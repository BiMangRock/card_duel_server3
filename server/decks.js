// decks.js (server, v135) — 덱 슬롯 여러 개 + "사용 중" 덱
//  - 슬롯은 덱을 보관하는 곳이다. 미완성(30장 미만)이거나 아직 없는 카드가 들어 있어도 저장할 수 있다 (덱 코드로 가져온 덱 등).
//  - "사용 중" 슬롯을 고르면 그 덱이 예전부터 쓰던 decks 표(= AI 대전·유저 대전·분해 보호가 쓰는 덱)에 들어간다.
//    그래서 사용 중으로 고를 때만 30장·보유 카드 규칙을 검사한다.
//  - 예전 PUT /api/deck(덱 편집 저장)도 사용 중 슬롯에 같이 반영된다 (syncActive).
const path = require('path');
const express = require('express');
const db = require('./db');
const { requireAuth } = require('./auth');
const { ensureCollection, collectionOf, CARD_POOL } = require('./collection');
const JS = path.join(__dirname, '..', 'public', 'js');
const { CONFIG, validateDeckList, defaultDeckList, HERO_POWERS } = require(path.join(JS, 'engine.js'));
const { validateDeckOwned, validateDeckScope, cardScope } = require(path.join(JS, 'collection.js'));

const MAX_SLOTS = 9;
// 테이블은 schema.sql (deck_slots · deck_meta)

const cardNamed = n => CARD_POOL.find(c => c.name === n);
const byName = { has: n => !!cardNamed(n), get: cardNamed };   // 직접 만든 카드는 서버가 켜진 뒤에도 늘어나므로 그때그때 찾는다
const cleanName = s => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24) || '새 덱';
const cleanPower = h => (h && HERO_POWERS[h]) ? h : '';
// 슬롯에 넣을 수 있는 목록인지 (느슨한 검사): 있는 카드 · 30장 이하 · 같은 카드 2장 이하 · 일반 카드(개발자는 전부)
function slotListProblem(list, admin) {
  if (!Array.isArray(list)) return '덱이 올바르지 않아요.';
  if (list.length > CONFIG.DECK_SIZE) return `덱은 ${CONFIG.DECK_SIZE}장까지예요.`;
  const cnt = {};
  for (const n of list) {
    if (typeof n !== 'string' || !byName.has(n)) return `없는 카드예요: ${String(n).slice(0, 30)}`;
    cnt[n] = (cnt[n] || 0) + 1;
    if (cnt[n] > (admin ? CONFIG.COPIES : CONFIG.COPIES)) return `같은 카드는 ${CONFIG.COPIES}장까지예요: ${n}`;
    if (!admin && cardScope(byName.get(n)) !== 'normal') return `일반 덱에 넣을 수 없는 카드예요: ${n}`;
  }
  return null;
}
// 사용 중 덱으로 쓸 수 있는지 (엄격한 검사: 기존 PUT /api/deck 과 같은 기준)
async function activeProblem(list, uid, admin) {
  if (admin) return validateDeckList(list);
  return validateDeckList(list) || validateDeckOwned(list, await collectionOf(uid)) || validateDeckScope(list, CARD_POOL, 'normal');
}
const rowsOf = uid => db.prepare('SELECT slot, name, deck_json, hero_power, updated_at FROM deck_slots WHERE user_id=? ORDER BY slot').all(uid);
const activeOf = async uid => { const r = await db.prepare('SELECT active_slot FROM deck_meta WHERE user_id=?').get(uid); return r ? r.active_slot : null; };
const setActive = (uid, slot) => db.prepare('INSERT INTO deck_meta(user_id,active_slot) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET active_slot=excluded.active_slot').run(uid, slot);
// 처음 쓰는 계정: 지금 쓰던 덱(없으면 추천 덱)을 1번 슬롯 "내 덱"으로 옮기고 사용 중으로
async function ensureSlots(uid) {
  if (await db.prepare('SELECT 1 FROM deck_slots WHERE user_id=? LIMIT 1').get(uid)) return;
  const cur = await db.prepare('SELECT deck_json FROM decks WHERE user_id=?').get(uid);
  let list = defaultDeckList(); if (cur) { try { const l = JSON.parse(cur.deck_json); if (Array.isArray(l)) list = l; } catch (_) {} }
  const r = await db.prepare('INSERT INTO deck_slots(user_id,slot,name,deck_json,hero_power,updated_at) VALUES (?,1,?,?,?,?) ON CONFLICT DO NOTHING').run(uid, '내 덱', JSON.stringify(list), '', Date.now());
  if (r.changes) await setActive(uid, 1);
}
async function decksOut(uid) {
  await ensureSlots(uid);
  let active = await activeOf(uid);
  const slots = (await rowsOf(uid)).map(r => ({ slot: r.slot, name: r.name, deck: JSON.parse(r.deck_json), heroPower: r.hero_power || '', updatedAt: r.updated_at }));
  if (!slots.some(s => s.slot === active)) { active = slots.length ? slots[0].slot : null; if (active) await setActive(uid, active); }
  return { max: MAX_SLOTS, active, slots };
}
function writeActiveDeck(uid, list) {
  return db.prepare(`INSERT INTO decks(user_id,deck_json,updated_at) VALUES (?,?,?)
              ON CONFLICT(user_id) DO UPDATE SET deck_json=excluded.deck_json, updated_at=excluded.updated_at`).run(uid, JSON.stringify(list), Date.now());
}
// 예전 방식의 덱 저장(PUT /api/deck)이 들어오면 사용 중 슬롯에도 같은 덱을 넣는다
async function syncActive(uid, list) {
  const a = await activeOf(uid); if (!a) return;
  await db.prepare('UPDATE deck_slots SET deck_json=?, updated_at=? WHERE user_id=? AND slot=?').run(JSON.stringify(list), Date.now(), uid, a);
}

const router = express.Router();
router.use('/decks', requireAuth);
const slotParam = req => { const n = Number(req.params.slot); return Number.isInteger(n) && n >= 1 && n <= MAX_SLOTS ? n : null; };
const fail = (res, code, msg) => res.status(code).json({ error: msg });

router.get('/decks', async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(await decksOut(req.user.id)); });

// 새 슬롯 {name, deck, heroPower}
router.post('/decks', async (req, res) => {
  const uid = req.user.id, b = req.body || {}, list = Array.isArray(b.deck) ? b.deck : [];
  const bad = slotListProblem(list, !!req.user.isAdmin); if (bad) return fail(res, 400, bad);
  await ensureSlots(uid);
  const slot = await db.tx(async () => {
    const used = new Set((await rowsOf(uid)).map(r => r.slot));
    let n = 1; while (used.has(n) && n <= MAX_SLOTS) n++;
    if (n > MAX_SLOTS) return null;
    await db.prepare('INSERT INTO deck_slots(user_id,slot,name,deck_json,hero_power,updated_at) VALUES (?,?,?,?,?,?)')
      .run(uid, n, cleanName(b.name), JSON.stringify(list), cleanPower(b.heroPower), Date.now());
    return n;
  }, { lock: uid });
  if (!slot) return fail(res, 400, `덱은 ${MAX_SLOTS}개까지 저장할 수 있어요. 하나를 지운 뒤 다시 해 주세요.`);
  res.json({ ok: true, slot, ...(await decksOut(uid)) });
});

// 슬롯 고치기 {name?, deck?, heroPower?}. 사용 중 슬롯의 덱을 바꾸면 사용 중 덱(decks 표)도 바뀐다 → 그때는 30장·보유 규칙을 지켜야 한다
router.put('/decks/:slot', async (req, res) => {
  const uid = req.user.id, slot = slotParam(req), b = req.body || {};
  if (!slot) return fail(res, 400, '잘못된 덱 번호예요.');
  await ensureSlots(uid);
  const row = await db.prepare('SELECT * FROM deck_slots WHERE user_id=? AND slot=?').get(uid, slot);
  if (!row) return fail(res, 404, '없는 덱이에요.');
  let list = null;
  if (b.deck !== undefined) {
    list = b.deck; const bad = slotListProblem(list, !!req.user.isAdmin); if (bad) return fail(res, 400, bad);
    if (await activeOf(uid) === slot) { await ensureCollection(uid); const p = await activeProblem(list, uid, !!req.user.isAdmin); if (p) return fail(res, 400, '사용 중인 덱은 완성된 덱이어야 해요: ' + p); }
  }
  await db.prepare('UPDATE deck_slots SET name=?, deck_json=?, hero_power=?, updated_at=? WHERE user_id=? AND slot=?')
    .run(b.name !== undefined ? cleanName(b.name) : row.name, list ? JSON.stringify(list) : row.deck_json,
         b.heroPower !== undefined ? cleanPower(b.heroPower) : row.hero_power, Date.now(), uid, slot);
  if (list && await activeOf(uid) === slot) await writeActiveDeck(uid, list);
  res.json({ ok: true, ...(await decksOut(uid)) });
});

router.delete('/decks/:slot', async (req, res) => {
  const uid = req.user.id, slot = slotParam(req);
  if (!slot) return fail(res, 400, '잘못된 덱 번호예요.');
  await ensureSlots(uid);
  if (await activeOf(uid) === slot) return fail(res, 400, '사용 중인 덱은 지울 수 없어요. 다른 덱을 먼저 사용해 주세요.');
  const r = await db.prepare('DELETE FROM deck_slots WHERE user_id=? AND slot=?').run(uid, slot);
  if (!r.changes) return fail(res, 404, '없는 덱이에요.');
  res.json({ ok: true, ...(await decksOut(uid)) });
});

// 이 슬롯을 사용 중 덱으로 (완성된 덱 · 가진 카드만)
router.post('/decks/:slot/activate', async (req, res) => {
  const uid = req.user.id, slot = slotParam(req);
  if (!slot) return fail(res, 400, '잘못된 덱 번호예요.');
  await ensureSlots(uid); await ensureCollection(uid);
  const row = await db.prepare('SELECT deck_json FROM deck_slots WHERE user_id=? AND slot=?').get(uid, slot);
  if (!row) return fail(res, 404, '없는 덱이에요.');
  const list = JSON.parse(row.deck_json);
  const p = await activeProblem(list, uid, !!req.user.isAdmin);
  if (p) return fail(res, 400, list.length < CONFIG.DECK_SIZE ? `아직 ${list.length}/${CONFIG.DECK_SIZE}장이라 쓸 수 없어요.` : p.replace('보유하지 않은 카드가 있어요', '아직 없는 카드가 있어요 (카드 제작에서 만들 수 있어요)'));
  try { await db.tx(async () => { await writeActiveDeck(uid, list); await setActive(uid, slot); }, { lock: uid }); }
  catch (e) { console.error('decks/activate 실패:', e); return fail(res, 500, '서버 오류가 났어요.'); }
  res.json({ ok: true, deck: list, ...(await decksOut(uid)) });
});

module.exports = { router, syncActive, decksOut, MAX_SLOTS, slotListProblem };
