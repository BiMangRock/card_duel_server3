// customcards.js — 유저가 직접 만드는 카드 (규칙 기반, AI 없음) + 승인(PR) 흐름
//
//   상태:  made(만듦: AI 대전·모험에서 사용) → pending(승인 요청) → approved(승인: 유저 대전에서도 사용) / rejected(반려: AI 대전·모험만)
//   · 만들 때 골드를 내고(CardRules.CUSTOM.GOLD_COST), 만든 사람은 그 카드를 2장 받는다
//   · 서버가 켜질 때 DB 의 카드를 전부 CARD_POOL 에 넣는다 (덱 검사·유저 대전 엔진이 이름으로 찾을 수 있게)
//   · 브라우저는 /api/customcards/pool 로 "승인된 카드 + 내 카드"를 받아 자기 CARD_POOL 에 넣는다 (customboot.js)
//   · 효과 목록(effectcatalog.js)·예산·이름 규칙(cardrules.js)은 브라우저와 같은 파일을 쓴다 → 화면에서 통과한 카드는 서버에서도 통과
const path = require('path');
const express = require('express');
const db = require('./db');
const { requireAuth, requireAdmin } = require('./auth');
const { ensureWallet, walletOut } = require('./wallet');
const { ensureCollection, ensureAtLeast, collectionOf } = require('./collection');
const JS = path.join(__dirname, '..', 'public', 'js');
const E = require(path.join(JS, 'engine.js'));
const CR = require(path.join(JS, 'cardrules.js'));

// 테이블은 schema.sql (custom_cards · custom_card_versions · gold_log · custom_card_images)

const STATUS_LABEL = { made: '만듦', pending: '승인 대기', approved: '승인됨', rejected: '반려됨' };
// 카드 행 + 만든 사람 이름 (cardOf 가 DB 를 다시 부르지 않게 한 번에)
const SEL = "SELECT c.*, COALESCE(u.nickname, u.username) AS creator_name FROM custom_cards c LEFT JOIN users u ON u.id=c.user_id";
const SEL_COLS = "SELECT c.id,c.user_id,c.name,c.status,c.input_json,c.card_json,c.lines_json,c.budget_json,c.warns_json,c.check_json,c.image_type,c.note,c.created_at,c.requested_at,c.reviewed_at, COALESCE(u.nickname, u.username) AS creator_name FROM custom_cards c LEFT JOIN users u ON u.id=c.user_id";
const rowById = id => db.prepare(SEL + ' WHERE c.id=?').get(id);

// DB 행 → 게임 카드 (CARD_POOL 에 들어가는 모양)
function cardOf(row) {
  const c = JSON.parse(row.card_json);
  c.custom = true; c.customId = row.id; c.customStatus = row.status; c.creator = row.creator_name || '?';
  c.flavor = `제작: ${c.creator}` + (row.status === 'approved' ? ' · 승인된 카드' : '');
  if (row.image_type) c.art = `/api/customcards/${row.id}/art`;
  return c;
}
// CARD_POOL 안의 카드 객체를 갱신한다 (같은 객체를 고쳐서, 이미 그 객체를 쥔 곳도 바뀌게)
function syncPool(row) {
  const fresh = cardOf(row), i = E.CARD_POOL.findIndex(c => c.custom && c.customId === row.id);
  if (i < 0) { E.CARD_POOL.push(fresh); return fresh; }
  const cur = E.CARD_POOL[i];
  for (const k of Object.keys(cur)) delete cur[k];
  Object.assign(cur, fresh); return cur;
}
// 카드 풀 맞추기: 서버(Vercel 함수)가 여러 대일 수 있으므로, 다른 서버에서 만든·승인한 카드도 보이게
//  POOL_TTL 마다 "개수 · 마지막 변경 시각"만 확인하고, 달라졌으면 전부 다시 읽는다 (app.js 의 미들웨어가 요청마다 부른다)
const POOL_TTL = 5000;
let poolAt = 0, poolSig = null, poolP = null;
async function refreshPool(force) {
  if (!force && Date.now() - poolAt < POOL_TTL) return;
  if (poolP) return poolP;
  poolP = (async () => {
    const sig = await db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(updated_at),0) AS t, COALESCE(MAX(id),0) AS m FROM custom_cards').get();
    const key = `${sig.n}:${sig.t}:${sig.m}`;
    if (force || key !== poolSig) {
      const rows = await db.prepare(SEL_COLS + ' ORDER BY c.id').all();
      const ids = new Set(rows.map(r => r.id));
      for (let i = E.CARD_POOL.length - 1; i >= 0; i--) { const c = E.CARD_POOL[i]; if (c.custom && !ids.has(c.customId)) E.CARD_POOL.splice(i, 1); }   // 지워진 카드
      for (const row of rows) syncPool(row);
      poolSig = key;
    }
    poolAt = Date.now();
  })().finally(() => { poolP = null; });
  return poolP;
}

// 유저 대전에 쓸 수 없는 카드 (승인 전 직접 만든 카드)
function unapprovedIn(list) {
  const bad = new Set();
  for (const n of list || []) { const c = E.CARD_POOL.find(x => x.name === n); if (c && c.custom && c.customStatus !== 'approved') bad.add(n); }
  return [...bad];
}
async function unapprovedInDeckOf(uid) {
  const d = await db.prepare('SELECT deck_json FROM decks WHERE user_id=?').get(uid);
  if (!d) return [];
  try { return unapprovedIn(JSON.parse(d.deck_json)); } catch (_) { return []; }
}

// ---------- 자동 점검: 이 카드를 넣은 덱으로 봇 대전 ----------
function autoCheck(card0, games = 6) {
  const res = { games, errors: 0, firstError: null, wins: 0, played: 0, avgTurns: 0 };
  let turns = 0;
  const card = { ...JSON.parse(JSON.stringify(card0)), name: '__점검중__' + Math.random().toString(36).slice(2, 8) };   // 같은 이름의 예전 버전과 섞이지 않게 임시 이름으로
  const inPool = false;
  E.CARD_POOL.push(card);
  try {
    for (let g = 0; g < games; g++) {
      const d0 = E.buildRandomDeck(), d1 = E.buildRandomDeck();
      for (let i = 0; i < 4; i++) d0[i] = card.name;                // 테스트 덱이라 4장까지 넣어 자주 나오게
      let s = E.newGame(Math.random, { decks: [d0, d1], freeDeck: [true, false] }), steps = 0;
      while (!s.over && s.turnNo <= 150 && steps++ < 4000) {
        const act = E.BotPlayers.rule.decide(E.viewFor(s, s.turn));
        let r;
        try { r = E.apply(s, act, s.turn); } catch (e) { res.errors++; res.firstError = res.firstError || String(e.message).slice(0, 200); break; }
        if (!r.ok) { res.errors++; res.firstError = res.firstError || String(r.error || '').slice(0, 200); break; }
        if (act && act.type === 'PLAY_CARD' && s.turn === 0) { const c = s.seats[0].hand.find(x => x.id === act.cardId); if (c && c.name === card.name) res.played++; }
        s = r.state;
      }
      turns += s.turnNo;
      if (s.over && s.winner === 0) res.wins++;
    }
  } finally { if (!inPool) { const i = E.CARD_POOL.indexOf(card); if (i >= 0) E.CARD_POOL.splice(i, 1); } }
  res.avgTurns = +(turns / games).toFixed(1);
  const wr = res.wins / games;
  res.verdict = res.errors ? '오류 있음' : wr >= 0.85 ? '너무 강할 수 있음' : wr <= 0.15 ? '약할 수 있음' : '이상 없음';
  return res;
}

// ---------- 출력 모양 ----------
async function rowOut(r, withInput) {
  return {
    id: r.id, name: r.name, status: r.status, statusLabel: STATUS_LABEL[r.status], creator: r.creator_name || '?', userId: r.user_id,
    card: cardOf(r), lines: JSON.parse(r.lines_json), budget: JSON.parse(r.budget_json), warns: JSON.parse(r.warns_json),
    check: r.check_json ? JSON.parse(r.check_json) : null, note: r.note || null, hasArt: !!r.image_type,
    createdAt: r.created_at, requestedAt: r.requested_at || null, reviewedAt: r.reviewed_at || null,
    ...(withInput ? { input: JSON.parse(r.input_json) } : {}),
    ...(withInput === 'versions' ? { versions: await versionsOf(r.id) } : {}),
    version: (await db.prepare('SELECT MAX(version) AS v FROM custom_card_versions WHERE card_id=?').get(r.id)).v || 1,
  };
}
async function saveVersion(cardId, statusBefore, noteBefore) {
  const r = await db.prepare('SELECT card_json, lines_json, budget_json FROM custom_cards WHERE id=?').get(cardId);
  const v = ((await db.prepare('SELECT MAX(version) AS v FROM custom_card_versions WHERE card_id=?').get(cardId)).v || 0) + 1;
  await db.prepare('INSERT INTO custom_card_versions(card_id,version,card_json,lines_json,budget_json,status_before,note_before,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(cardId, v, r.card_json, r.lines_json, r.budget_json, statusBefore || null, noteBefore || null, Date.now());
  return v;
}
const versionsOf = async cardId => (await db.prepare('SELECT version, card_json, lines_json, budget_json, status_before, note_before, created_at FROM custom_card_versions WHERE card_id=? ORDER BY version')
  .all(cardId)).map(v => ({ version: v.version, card: JSON.parse(v.card_json), lines: JSON.parse(v.lines_json), budget: JSON.parse(v.budget_json), statusBefore: v.status_before, noteBefore: v.note_before, at: v.created_at }));

// 그림: data URL → {buf, type}. 브라우저가 256px 정도로 줄여 보낸다
function parseImage(d) {
  if (!d) return null;
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(d));
  if (!m) return { error: '그림은 png·jpg·webp 만 올릴 수 있어요.' };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 250 * 1024) return { error: '그림이 너무 커요. (250KB 이하)' };
  return { buf, type: m[1] };
}
// 이름 검사는 카드 풀(메모리)로 한다 → CR.nameProblem 이 동기 함수라서. 요청마다 refreshPool 로 맞춰 두고, 저장할 때는 DB 의 UNIQUE 가 최종으로 막는다
const nameTaken = n => E.CARD_POOL.some(c => c.custom && c.name === n);

// 소환수 그림: 입력 안의 data URL 을 꺼내 'pending:번호' 로 바꿔 둔다 (카드를 저장한 뒤 진짜 주소로 바꾼다)
function takeTokenImages(selections) {
  const imgs = [], errors = [];
  const walk = t => {
    if (!t || typeof t !== 'object') return;
    if (typeof t.art === 'string' && t.art.startsWith('data:')) {
      const img = parseImage(t.art);
      if (img.error) errors.push(img.error); else { imgs.push(img); t.art = 'pending:' + (imgs.length - 1); }
    } else if (t.art && !/^\/api\/customcards\//.test(String(t.art))) delete t.art;
    for (const c of Array.isArray(t.summons) ? t.summons : []) walk(c && c.token);
  };
  for (const sel of Array.isArray(selections) ? selections : []) walk(sel && sel.token);
  return { imgs, error: errors[0] || null };
}
const replacePending = (json, urls) => json.replace(/"pending:(\d+)"/g, (m, k) => JSON.stringify(urls[Number(k)] || ''));
const allOut = (rows, w) => Promise.all(rows.map(r => rowOut(r, w)));

// ---------- 라우터 ----------
const router = express.Router();
const hits = new Map();
const slowOk = uid => { const t = Date.now(), a = (hits.get(uid) || []).filter(x => t - x < 60000); if (a.length >= 10) return false; a.push(t); hits.set(uid, a); return true; };

// 브라우저 카드 풀에 넣을 카드: 승인된 카드 + 내가 만든 카드 (개발자는 전부)
router.get('/customcards/pool', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const rows = req.user.isAdmin ? await db.prepare(SEL_COLS + ' ORDER BY c.id').all()
    : await db.prepare(SEL_COLS + " WHERE c.status='approved' OR c.user_id=? ORDER BY c.id").all(req.user.id);
  res.json({ cards: rows.map(cardOf) });
});

// 이름 확인 (입력하는 동안 화면이 묻는다)
router.get('/customcards/name-check', requireAuth, async (req, res) => {
  await refreshPool(true);
  res.json({ problem: CR.nameProblem(String(req.query.name || ''), nameTaken) });
});

// 내가 만든 카드
router.get('/customcards/mine', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const rows = await db.prepare(SEL_COLS + ' WHERE c.user_id=? ORDER BY c.id DESC').all(req.user.id);
  res.json({ cards: await allOut(rows, true), gold: CR.CUSTOM.GOLD_COST, editGold: CR.CUSTOM.EDIT_GOLD, max: req.user.isAdmin ? null : (CR.CUSTOM.MAX_PER_USER || null) });
});

// 만들기 {name, cost, atk, hp, selections:[{id, params}], image}
router.post('/customcards', requireAuth, async (req, res) => {
  const uid = req.user.id, b = req.body || {};
  if (!slowOk(uid)) return res.status(429).json({ error: '너무 빨라요. 잠시 뒤 다시 해 주세요.' });
  await refreshPool(true);
  delete b.art;                                                  // 카드 그림은 image 로만 받는다
  const ti = takeTokenImages(b.selections);
  if (ti.error) return res.status(400).json({ error: '소환수 ' + ti.error });
  const built = CR.buildCard(b, { nameTaken });
  if (!built.ok) return res.status(400).json({ error: built.problems[0], problems: built.problems, budget: built.budget });
  const img = parseImage(b.image);
  if (img && img.error) return res.status(400).json({ error: img.error });
  if (!req.user.isAdmin && CR.CUSTOM.MAX_PER_USER) {
    const n = (await db.prepare('SELECT COUNT(*) AS n FROM custom_cards WHERE user_id=?').get(uid)).n;
    if (n >= CR.CUSTOM.MAX_PER_USER) return res.status(400).json({ error: `카드는 한 사람당 ${CR.CUSTOM.MAX_PER_USER}장까지 만들 수 있어요.` });
  }
  const check = autoCheck(JSON.parse(JSON.stringify(built.card)));
  if (check.errors) return res.status(400).json({ error: '이 조합은 게임에서 오류가 나요. 효과를 바꿔 주세요.', check });

  await ensureWallet(uid); await ensureCollection(uid);
  const price = CR.CUSTOM.GOLD_COST;
  let id;
  try {
    id = await db.tx(async () => {
      const w = await db.prepare('SELECT gold, rev FROM wallets WHERE user_id=?').get(uid);
      if (w.gold < price) return null;
      await db.prepare('UPDATE wallets SET gold=gold-?, rev=rev+1, updated_at=? WHERE user_id=?').run(price, Date.now(), uid);
      const input = { name: built.card.name, cost: built.card.cost, atk: built.card.atk, hp: built.card.hp, selections: (b.selections || []).map(s => ({ id: s.id, params: s.params || {}, ...(s.token ? { token: s.token } : {}) })) };
      const cid = (await db.prepare(`INSERT INTO custom_cards(user_id,name,status,input_json,card_json,lines_json,budget_json,warns_json,check_json,image,image_type,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(uid, built.card.name, 'made', JSON.stringify(input), JSON.stringify(built.card), JSON.stringify(built.lines),
        JSON.stringify(built.budget), JSON.stringify(built.warns), JSON.stringify(check), img ? img.buf : null, img ? img.type : null, Date.now(), Date.now())).id;
      if (ti.imgs.length) {                                        // 소환수 그림 저장 → 카드 데이터의 'pending:n' 을 진짜 주소로
        const ins = db.prepare('INSERT INTO custom_card_images(card_id,image,image_type) VALUES (?,?,?) RETURNING id');
        const urls = [];
        for (const im of ti.imgs) urls.push(`/api/customcards/img/${Number((await ins.get(cid, im.buf, im.type)).id)}`);
        await db.prepare('UPDATE custom_cards SET card_json=?, input_json=?, lines_json=? WHERE id=?').run(
          replacePending(JSON.stringify(built.card), urls), replacePending(JSON.stringify(input), urls), replacePending(JSON.stringify(built.lines), urls), cid);
      }
      await saveVersion(cid, null, null);
      return cid;
    }, { lock: uid });
  } catch (e) {
    if (db.isUnique(e)) return res.status(400).json({ error: '이미 있는 카드 이름이에요' });
    throw e;
  }
  if (!id) return res.status(400).json({ error: `골드가 부족해요. (${price}골드 필요)` });
  const row = await rowById(id);
  const card = syncPool(row);
  await ensureAtLeast(uid, card.name, CR.CUSTOM.GIVE_COPIES);
  res.json({ card, item: await rowOut(row), wallet: walletOut(await ensureWallet(uid)), collection: await collectionOf(uid) });
});

// 승인 요청 (PR 열기)
router.post('/customcards/:id/request', requireAuth, async (req, res) => {
  const row = await rowById(Number(req.params.id));
  if (!row || row.user_id !== req.user.id) return res.status(404).json({ error: '없는 카드예요.' });
  if (row.status === 'pending') return res.status(409).json({ error: '이미 승인을 기다리고 있어요.' });
  if (row.status === 'approved') return res.status(409).json({ error: '이미 승인된 카드예요.' });
  await db.prepare("UPDATE custom_cards SET status='pending', requested_at=?, note=NULL, updated_at=? WHERE id=?").run(Date.now(), Date.now(), row.id);
  const r2 = await rowById(row.id); syncPool(r2);
  res.json({ item: await rowOut(r2) });
});

// 고치기 (만듦·반려 카드만, 이름 고정, EDIT_GOLD 골드)
//   만듦 → 고쳐도 만듦 (승인 요청 전까지 유저 대전 불가) / 반려 → 고치면 바로 승인 대기(재요청)
//   그림: image 가 data URL 이면 교체, clearImage 면 지움, 둘 다 없으면 그대로
router.put('/customcards/:id', requireAuth, async (req, res) => {
  const uid = req.user.id, b = req.body || {};
  if (!slowOk(uid)) return res.status(429).json({ error: '너무 빨라요. 잠시 뒤 다시 해 주세요.' });
  await refreshPool(true);
  const row = await rowById(Number(req.params.id));
  if (!row || row.user_id !== uid) return res.status(404).json({ error: '없는 카드예요.' });
  if (row.status !== 'made' && row.status !== 'rejected') return res.status(409).json({ error: row.status === 'pending' ? '승인을 기다리는 카드는 고칠 수 없어요.' : '승인된 카드는 고칠 수 없어요.' });
  delete b.art; b.name = row.name;                               // 이름은 고정
  const ti = takeTokenImages(b.selections);
  if (ti.error) return res.status(400).json({ error: '소환수 ' + ti.error });
  const built = CR.buildCard(b, { nameTaken, allowName: row.name });
  if (!built.ok) return res.status(400).json({ error: built.problems[0], problems: built.problems, budget: built.budget });
  const img = b.image ? parseImage(b.image) : null;
  if (img && img.error) return res.status(400).json({ error: img.error });
  const check = autoCheck(built.card);
  if (check.errors) return res.status(400).json({ error: '이 조합은 게임에서 오류가 나요. 효과를 바꿔 주세요.', check });

  const price = CR.CUSTOM.EDIT_GOLD, next = row.status === 'rejected' ? 'pending' : 'made';
  await ensureWallet(uid);
  const ok = await db.tx(async () => {
    const w = await db.prepare('SELECT gold FROM wallets WHERE user_id=?').get(uid);
    if (w.gold < price) return false;
    await db.prepare('UPDATE wallets SET gold=gold-?, rev=rev+1, updated_at=? WHERE user_id=?').run(price, Date.now(), uid);
    if (!(await db.prepare('SELECT 1 FROM custom_card_versions WHERE card_id=?').get(row.id))) await saveVersion(row.id, null, null);   // 버전 기록이 생기기 전에 만든 카드: 고치기 전 모습을 v1 로 남긴다
    const input = { name: row.name, cost: built.card.cost, atk: built.card.atk, hp: built.card.hp, selections: (b.selections || []).map(x => ({ id: x.id, params: x.params || {}, ...(x.token ? { token: x.token } : {}) })) };
    let cardJ = JSON.stringify(built.card), inputJ = JSON.stringify(input), linesJ = JSON.stringify(built.lines);
    if (ti.imgs.length) {
      const ins = db.prepare('INSERT INTO custom_card_images(card_id,image,image_type) VALUES (?,?,?) RETURNING id');
      const urls = [];
      for (const im of ti.imgs) urls.push(`/api/customcards/img/${Number((await ins.get(row.id, im.buf, im.type)).id)}`);
      cardJ = replacePending(cardJ, urls); inputJ = replacePending(inputJ, urls); linesJ = replacePending(linesJ, urls);
    }
    await db.prepare(`UPDATE custom_cards SET input_json=?, card_json=?, lines_json=?, budget_json=?, warns_json=?, check_json=?, status=?, note=NULL,
      requested_at=CASE WHEN ?::text='pending' THEN ?::bigint ELSE requested_at END, reviewed_at=CASE WHEN ?::text='pending' THEN NULL ELSE reviewed_at END, updated_at=? WHERE id=?`)
      .run(inputJ, cardJ, linesJ, JSON.stringify(built.budget), JSON.stringify(built.warns), JSON.stringify(check), next, next, Date.now(), next, Date.now(), row.id);
    if (img) await db.prepare('UPDATE custom_cards SET image=?, image_type=? WHERE id=?').run(img.buf, img.type, row.id);
    else if (b.clearImage) await db.prepare('UPDATE custom_cards SET image=NULL, image_type=NULL WHERE id=?').run(row.id);
    await saveVersion(row.id, row.status, row.note);
    return true;
  }, { lock: uid });
  if (!ok) return res.status(400).json({ error: `골드가 부족해요. (${price}골드 필요)` });
  const r2 = await rowById(row.id);
  const card = syncPool(r2);
  res.json({ card, item: await rowOut(r2, true), wallet: walletOut(await ensureWallet(uid)) });
});

// 카드 그림 (<img> 가 로그인 쿠키를 같이 보내므로 게임·승인 페이지에서 그대로 보인다)
router.get('/customcards/:id/art', async (req, res) => {
  const id = Number(req.params.id); if (!Number.isInteger(id)) return res.status(404).end();
  const r = await db.prepare('SELECT image, image_type FROM custom_cards WHERE id=?').get(id);
  if (!r || !r.image_type) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=86400'); res.type(r.image_type).send(Buffer.from(r.image));
});

router.get('/customcards/img/:id', async (req, res) => {       // 소환수 그림
  const id = Number(req.params.id); if (!Number.isInteger(id)) return res.status(404).end();
  const r = await db.prepare('SELECT image, image_type FROM custom_card_images WHERE id=?').get(id);
  if (!r) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=86400'); res.type(r.image_type).send(Buffer.from(r.image));
});

// ---------- 개발자: 승인 페이지 (review.html) ----------
router.get('/customcards/admin/list', requireAdmin, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const rows = await db.prepare(SEL_COLS + ` ORDER BY (c.status='pending') DESC, COALESCE(c.requested_at, c.created_at) DESC LIMIT 300`).all();
  const counts = {}; for (const r of await db.prepare('SELECT status, COUNT(*) AS n FROM custom_cards GROUP BY status').all()) counts[r.status] = r.n;
  res.json({ cards: await allOut(rows, 'versions'), counts });
});
router.post('/customcards/admin/:id/recheck', requireAdmin, async (req, res) => {
  const row = await rowById(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '없는 카드예요.' });
  const check = autoCheck(cardOf(row), 10);
  await db.prepare('UPDATE custom_cards SET check_json=? WHERE id=?').run(JSON.stringify(check), row.id);
  res.json({ check });
});
router.post('/customcards/admin/:id/review', requireAdmin, async (req, res) => {
  const decision = req.body && req.body.decision;
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'decision 은 approved 또는 rejected 예요.' });
  const row = await rowById(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '없는 카드예요.' });
  const note = String((req.body && req.body.note) || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 300);
  await db.prepare('UPDATE custom_cards SET status=?, note=?, reviewed_at=?, updated_at=? WHERE id=?').run(decision, note || null, Date.now(), Date.now(), row.id);
  const r2 = await rowById(row.id); syncPool(r2);
  res.json({ item: await rowOut(r2, true) });
});

// ---------- 개발자: 골드 수정 ----------
//   GET  /customcards/admin/users?q=   유저 목록 (닉네임·아이디·골드)
//   POST /customcards/admin/gold {userId, gold}  골드를 이 값으로   |  {userId, add}  더하기(빼기)
//   지갑 저장 번호(rev)를 올리므로, 그 유저가 게임을 켜 둔 채라면 새로고침해야 한다 (자기 자신은 응답의 wallet 을 화면이 바로 받아 쓴다)
router.get('/customcards/admin/users', requireAdmin, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const qq = '%' + String(req.query.q || '').replace(/[%_]/g, '') + '%';
  const rows = await db.prepare(`SELECT u.id, u.username, u.nickname, u.is_admin, COALESCE(w.gold, 0) AS gold, w.user_id AS has_wallet
    FROM users u LEFT JOIN wallets w ON w.user_id=u.id WHERE u.username ILIKE ? OR COALESCE(u.nickname,'') ILIKE ? ORDER BY u.id LIMIT 100`).all(qq, qq);
  const log = await db.prepare(`SELECT g.at, g.before, g.after, COALESCE(a.nickname,a.username) AS admin, COALESCE(u.nickname,u.username) AS "user"
    FROM gold_log g JOIN users a ON a.id=g.admin_id JOIN users u ON u.id=g.user_id ORDER BY g.id DESC LIMIT 20`).all();
  res.json({ users: rows.map(r => ({ id: r.id, username: r.username, nickname: r.nickname, isAdmin: !!r.is_admin, gold: r.gold })), log, me: req.user.id });
});
router.post('/customcards/admin/gold', requireAdmin, async (req, res) => {
  const b = req.body || {}, uid = Number(b.userId);
  if (!Number.isInteger(uid) || !(await db.prepare('SELECT 1 FROM users WHERE id=?').get(uid))) return res.status(404).json({ error: '없는 유저예요.' });
  const before = (await ensureWallet(uid)).gold;
  let after = b.gold !== undefined ? Number(b.gold) : before + Number(b.add);
  if (!Number.isFinite(after)) return res.status(400).json({ error: '숫자를 입력해 주세요.' });
  after = Math.max(0, Math.min(10000000, Math.round(after)));
  await db.prepare('UPDATE wallets SET gold=?, rev=rev+1, updated_at=? WHERE user_id=?').run(after, Date.now(), uid);
  await db.prepare('INSERT INTO gold_log(admin_id,user_id,before,after,at) VALUES (?,?,?,?,?)').run(req.user.id, uid, before, after, Date.now());
  res.json({ userId: uid, before, after, wallet: walletOut(await ensureWallet(uid)) });
});

module.exports = { router, unapprovedIn, unapprovedInDeckOf, autoCheck, cardOf, refreshPool };
