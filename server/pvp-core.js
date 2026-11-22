// pvp-core.js (server) — 유저 대전의 심장: 대기열 · 판 진행 · 멀리건 · 턴 제한 시간 · 연결 끊김 · 정산 호출.
//  express·DB 를 직접 모른다. 상태 저장은 store(pvp-store.js), 메시지 보내기는 publish(realtime.js), DB 는 loadDeck/settle/statsOf 로 받는다.
//
//  원칙: 판의 진짜 상태(손패·덱 순서·난수)는 서버만 갖는다.
//   - 클라이언트는 "행동"만 보낸다 → 서버가 엔진(apply)으로 검증하고 적용한다.
//   - 클라이언트는 자기 시점의 화면(viewFor)과, 상대의 비공개 정보를 가린 이벤트만 받는다.
//   - 시간·승패·보상은 전부 서버가 정한다.
//
//  Vercel(서버리스)용 구조 — 예전에는 서버 한 대가 메모리에 대기열·판을 들고 웹소켓으로 보냈다.
//   - 서버(함수)는 요청마다 새로 뜰 수 있으므로, 대기열·판·접속 상태를 통째로 "world" 하나로 묶어 store 에 저장한다.
//     요청 하나 = store.run(world 를 잠그고 읽기 → 바꾸기 → 저장) 한 번. 그래서 동시에 온 요청도 차례로 처리된다.
//   - 계속 도는 시계가 없다 → 요청이 올 때마다 tick(시간 초과·끊김 처리)을 먼저 한다.
//     화면은 10초마다(판 도중엔 더 자주) /api/pvp/ping 을 보내므로 시계가 그걸로 돈다.
//   - "연결" = 화면 탭 하나(cid). ping 이 connTtlMs 동안 없으면 끊긴 것으로 본다.
//   - 메시지는 처리가 끝난(저장된) 뒤 publish(uid, msg) 로 그 사람의 모든 탭에 보낸다 (Supabase Realtime).
//     hello(새로 붙은 탭)에게만 보내는 메시지는 HTTP 응답으로 돌려준다.
//
//  클라이언트로 가는 메시지:
//    {t:'status', state:'idle'|'queue'|'match', mode:'normal'|'rank', waiting, waitingRank, record, winGold, rewardsToday, rank, cfg}
//    {t:'match', matchId, seat, phase:'mulligan'|'play'|'over', seq, opp:{name,online}, mulligan:{...}, view, events, remainMs, turnMs, result?}
//    {t:'presence', matchId, oppOnline, oppOfflineMs}     상대 연결 상태가 바뀜
//    {t:'error', error}
//    {t:'replaced', cid}                                  이 탭(cid)의 자리를 같은 계정의 새 탭이 가져감
//    {t:'invite'|'inviteSent'|'inviteGone'|'friends'|'chat'|'chatRead'|'emote'|'spectators', …}
const path = require('path');
const crypto = require('crypto');
const JS = path.join(__dirname, '..', 'public', 'js');
const E = require(path.join(JS, 'engine.js'));
const { PVP, pvpRng } = require(path.join(JS, 'pvp.js'));
const { PROGRESS } = require(path.join(JS, 'progress.js'));   // v132 감정 표현 목록
const EMOTE_IDS = PROGRESS.EMOTES.map(e => e.id);

const ALLOWED = new Set(['PLAY_CARD', 'ATTACK', 'HERO_ATTACK', 'HERO_POWER', 'END_TURN', 'TARGET', 'CHOOSE', 'SURRENDER']);   // v131 HERO_POWER
const cryptoRng = () => crypto.randomInt(0, 2 ** 30) / 2 ** 30;
const MAX_CONNS = 4;            // 한 계정이 동시에 열 수 있는 탭 수 (넘으면 가장 오래된 탭에 자리를 비켜 달라고 한다)

// 클라이언트가 보낸 행동에서 엔진이 아는 필드만 골라낸다 (이상한 값·큰 객체를 엔진에 넘기지 않는다)
function cleanAction(a) {
  if (!a || typeof a !== 'object' || !ALLOWED.has(a.type)) return null;
  const c = { type: a.type };
  for (const k of ['cardId', 'attackerId', 'index', 'pos']) {   // pos: v129 하수인을 놓을 자리
    if (a[k] !== undefined) { if (!Number.isInteger(a[k])) return null; c[k] = a[k]; }
  }
  if (a.target !== undefined && a.target !== null) {
    const t = a.target;
    if (typeof t !== 'object' || typeof t.kind !== 'string' || t.kind.length > 12 || !Number.isInteger(t.seat)) return null;
    c.target = { kind: t.kind, seat: t.seat };
    if (t.id !== undefined) { if (!Number.isInteger(t.id)) return null; c.target.id = t.id; }
  }
  return c;
}

// 상대에게 보여 주면 안 되는 이벤트 정보를 가린다 (손에 들어온 카드 이름 · 상대 손패 내용)
function scrubEvents(events, viewer) {
  const evs = structuredClone(events);
  for (const ev of evs) {
    if (ev.type === 'board' && Array.isArray(ev.seats)) {               // 혼돈의 주문서 중간 상태: 상대 손패는 장수만
      ev.seats.forEach((sn, i) => { if (i !== viewer && sn && Array.isArray(sn.hand)) sn.hand = sn.hand.map(() => ({})); });
    } else if (ev.seat !== undefined && ev.seat !== viewer) {
      if ((ev.type === 'generated' && !ev.returned && !ev.burned) || (ev.type === 'discoverPick' && !ev.burned)) { ev.name = '카드'; delete ev.cost; delete ev.card; }
      else if (ev.type === 'copy' || ev.type === 'deckAdd') { if (ev.name !== undefined) ev.name = '카드'; }
    }
  }
  return evs;
}

const emptyWorld = () => ({ users: {}, matches: {}, queue: [], invites: {} });

function createPvp(opts = {}) {
  const cfg = {
    turnMs: PVP.TURN_MS, mulliganMs: PVP.MULLIGAN_MS, reconnectMs: PVP.RECONNECT_MS,
    maxTimeouts: PVP.MAX_TIMEOUTS, maxTurns: PVP.MAX_TURNS,
    graceMs: 4000,                      // 이벤트가 많은 턴(연출이 긴 턴)에 붙여 주는 여유 시간 상한
    queueGraceMs: 10000,                // 대기 중 연결이 끊겨도 이만큼은 자리를 지켜 준다 (새로고침·재접속 대비)
    queueMaxMs: 10 * 60 * 1000,         // 이 시간 동안 상대가 안 나타나면 대기 취소
    inviteMs: PVP.INVITE_MS || 30000,   // v136 친구 대전 신청이 유효한 시간
    maxSpectators: PVP.MAX_SPECTATORS || 10,   // v136 한 판을 동시에 관전할 수 있는 사람 수
    connTtlMs: 30000,                   // 이 시간 동안 ping 이 없으면 그 탭은 끊긴 것으로 본다 (화면은 10초마다 보낸다)
    pingMs: 10000,                      // 화면에 알려 주는 ping 간격
    tickMs: 0,                          // 0 이 아니면 이 간격으로 스스로 tick (내 컴퓨터에서 켤 때 · 테스트). Vercel 에서는 요청이 시계 역할
    introMs: 0,                         // v147 매칭 성공 연출 시간 (멀리건 시간에 더해 준다). 실제 서버는 server/pvp.js 에서 PVP.INTRO_MS 로 켠다
    ...(opts.cfg || {}),
  };
  const log = opts.log || (() => {});
  const rng = opts.rng || cryptoRng;
  const { loadDeck, settle, store } = opts;
  const publish = opts.publish || (() => {});
  const statsOf = opts.statsOf || (async () => ({}));
  if (typeof loadDeck !== 'function' || typeof settle !== 'function' || !store) throw new Error('createPvp: loadDeck/settle/store 필요');

  // ---------- 한 번의 처리 = world 잠그고 → fn → 저장 → 메시지 보내기 ----------
  //  fn(x) 의 x: { W(world), now, out(보낼 메시지), direct(이 요청에만 돌려줄 메시지) }
  async function op(fn, { tick: doTick = true } = {}) {
    let x;
    const result = await store.run(async (W) => {
      x = { W, now: Date.now(), out: [], direct: [] };
      if (doTick) await tickIn(x);
      return fn(x);
    });
    if (x && x.out.length) { try { await publish(x.out); } catch (e) { log('메시지 보내기 실패', e && e.message); } }
    return result;
  }

  // ---------- 사용자 ----------
  function getUser(x, uid, username) {
    let u = x.W.users[uid];
    if (!u) { u = { uid, username: username || ('user' + uid), conns: [], matchId: null, queued: false, qmode: 'normal', queuedAt: 0, goneAt: null, unseen: null, spectating: null, qpower: null }; x.W.users[uid] = u; }
    else if (username) u.username = username;
    return u;
  }
  const userOf = (x, uid) => x.W.users[uid] || null;
  const matchById = (x, id) => (id && x.W.matches[id]) || null;
  const live = u => !!u && u.conns.length > 0;
  function gc(x, u) { if (u && !u.conns.length && !u.matchId && !u.queued && !u.unseen && !u.spectating && !invitesOf(x, u.uid).length) delete x.W.users[u.uid]; }
  const stateOf_ = (x, uid) => { const u = userOf(x, uid); return u && u.matchId ? 'match' : u && u.queued ? 'queue' : 'idle'; };
  const sendTo = (x, u, msg) => { if (u) x.out.push({ uid: u.uid, msg }); };
  async function statusMsg(x, u) {
    let st = {}; try { st = (await statsOf(u.uid)) || {}; } catch (e) { log('statsOf 실패', e && e.message); }
    const waitingOf = md => x.W.queue.filter(id => { const y = userOf(x, id); return y && y.qmode === md; }).length;
    return { t: 'status', state: stateOf_(x, u.uid), mode: u.qmode, waiting: waitingOf('normal'), waitingRank: waitingOf('rank'), spectating: u.spectating || null, ...st,
      cfg: { turnMs: cfg.turnMs, mulliganMs: cfg.mulliganMs, reconnectMs: cfg.reconnectMs, maxTimeouts: cfg.maxTimeouts, pingMs: cfg.pingMs } };
  }
  const pushStatus = async (x, u) => { if (u) sendTo(x, u, await statusMsg(x, u)); };

  // ---------- 연결 (탭) ----------
  //  hello: 탭이 새로 붙었다 → 지금 상태(대기·진행 중인 판·관전·신청)를 이 탭에만 돌려준다
  function connectIn(x, uid, username, cid) {
    const u = getUser(x, uid, username);
    u.conns = u.conns.filter(c => c.cid !== cid);
    while (u.conns.length >= MAX_CONNS) {                         // v148 자리가 꽉 찼으면 가장 오래된 탭에 자리를 비켜 달라고 한다
      const old = u.conns.shift(); sendTo(x, u, { t: 'replaced', cid: old.cid });
    }
    u.conns.push({ cid, seen: x.now }); u.goneAt = null;
    return u;
  }
  async function helloMsgs(x, u) {
    const out = [await statusMsg(x, u)];
    const m = matchById(x, u.matchId);
    if (m && !m.over) {
      const seat = m.uids.indexOf(u.uid);
      if (m.offline[seat] != null) { m.offline[seat] = null; presence(x, m, 1 - seat); }
      out.push(matchMsg(x, m, seat));
    } else if (u.unseen) {                        // 연결이 없는 사이에 판이 끝났다면 결과를 한 번 보여 준다
      out.push(u.unseen); u.unseen = null;
    } else if (u.spectating) {                    // v136 관전 중이었으면 이어서 본다
      const sm = matchById(x, u.spectating);
      if (sm && !sm.over && sm.spectators[u.uid] !== undefined) out.push(specMsg(x, sm, u.uid)); else u.spectating = null;
    }
    for (const iv of invitesOf(x, u.uid)) out.push(inviteMsgFor(x, iv, u.uid));   // v136 기다리는 친구 대전 신청
    return out;
  }
  function dropConn(x, u, cid, at) {
    const before = u.conns.length;
    u.conns = u.conns.filter(c => c.cid !== cid);
    if (u.conns.length === before || u.conns.length) return;
    u.goneAt = at || x.now;
    const m = matchById(x, u.matchId);
    if (m && !m.over) {
      const seat = m.uids.indexOf(u.uid);
      if (m.offline[seat] == null) { m.offline[seat] = u.goneAt; presence(x, m, 1 - seat); }
    }
    gc(x, u);
  }
  function presence(x, m, toSeat) {           // toSeat 에게 상대(1-toSeat)의 연결 상태를 알린다
    const u = userOf(x, m.uids[toSeat]); if (!u) return;
    const off = m.offline[1 - toSeat];
    sendTo(x, u, { t: 'presence', matchId: m.id, oppOnline: off == null, oppOfflineMs: off == null ? 0 : x.now - off, reconnectMs: cfg.reconnectMs });
  }

  // ---------- 대기열 ----------
  function leaveQueue(x, u) { u.queued = false; x.W.queue = x.W.queue.filter(id => id !== u.uid); }
  async function pushAllQueued(x) { for (const uid of x.W.queue) await pushStatus(x, userOf(x, uid)); }
  async function pump(x) {
    for (;;) {
      x.W.queue = x.W.queue.filter(uid => { const u = userOf(x, uid); return u && u.queued && !u.matchId; });
      let pair = null;
      for (const md of ['normal', 'rank']) {                        // v127 같은 대기열끼리만 (랭크전은 등급·승률 상관없이 먼저 온 순서)
        const ready = x.W.queue.filter(uid => { const y = userOf(x, uid); return live(y) && y.qmode === md; });
        if (ready.length >= 2) { pair = [ready[0], ready[1], md]; break; }
      }
      if (!pair) return;
      const [a, b, md] = pair;
      leaveQueue(x, userOf(x, a)); leaveQueue(x, userOf(x, b));
      await startMatch(x, a, b, md);
    }
  }

  // ---------- 판 시작 ----------
  async function startMatch(x, a, b, mode) {
    const order = rng() < 0.5 ? [a, b] : [b, a];            // 좌석 배정 (선공은 엔진이 따로 무작위로 정한다)
    let decks;
    try { decks = []; for (const uid of order) decks.push(await loadDeck(uid)); }
    catch (e) {
      log('덱 불러오기 실패', e && e.message);
      for (const uid of order) { const u = userOf(x, uid); if (u) { sendTo(x, u, { t: 'error', error: '덱을 불러오지 못했어요. 잠시 뒤 다시 해 주세요.' }); await pushStatus(x, u); } }
      return;
    }
    for (const uid of order) { const u = userOf(x, uid); if (u) { if (u.queued) leaveQueue(x, u); stopSpectating(x, u); } for (const iv of invitesOf(x, uid)) dropInvite(x, iv, 'busy'); }   // v136 대기열·관전·다른 신청 정리
    const heroPowers = order.map(uid => { const u = userOf(x, uid); return (u && u.qpower) || E.randomHeroPower(rng); });   // v131
    const seed = 1 + Math.floor(rng() * 2147483645);                   // v137 리플레이용: 판 시작 난수를 시드로
    const state = E.newGame(pvpRng(seed), { decks, heroPowers });
    const now = x.now;
    const names = order.map(uid => userOf(x, uid).username);
    const m = {
      id: crypto.randomBytes(8).toString('hex'), ranked: mode === 'rank', friendly: mode === 'friend', spectators: {}, uids: order, names,
      state, decks, seq: 0, phase: 'mulligan', over: false, startedAt: now,
      mull: [0, 1].map(s => ({ done: !(state.seats[s].startIds || []).length })), mullUntil: now + cfg.introMs + cfg.mulliganMs,
      deadline: null, timeouts: [0, 0], offline: [null, null], result: null, emoteAt: [0, 0],
      log: { v: 1, engine: E.VERSION, seed, decks: decks.map(d => d.slice()), heroPowers: heroPowers.slice(), names: names.slice(), ranked: mode === 'rank', friendly: mode === 'friend', steps: [] },   // v137 리플레이 기록
    };
    x.W.matches[m.id] = m;
    for (const uid of order) { const u = userOf(x, uid); u.matchId = m.id; u.queued = false; }
    log('판 시작', m.id, m.friendly ? '[친구]' : m.ranked ? '[랭크]' : '[일반]', m.names.join(' vs '));
    if (m.mull[0].done && m.mull[1].done) beginPlay(x, m); else broadcast(x, m);
  }
  function beginPlay(x, m) {
    m.phase = 'play'; m.deadline = x.now + cfg.turnMs + cfg.graceMs;
    broadcast(x, m);
  }

  // ---------- 메시지 만들기 ----------
  function matchMsg(x, m, seat, extra) {
    const opp = 1 - seat, st = m.state, now = x.now;
    return {
      t: 'match', matchId: m.id, seat, ranked: !!m.ranked, friendly: !!m.friendly, spectators: Object.keys(m.spectators).length, phase: m.over ? 'over' : m.phase, seq: m.seq,
      opp: { name: m.names[opp], online: m.offline[opp] == null }, oppOfflineMs: m.offline[opp] == null ? 0 : now - m.offline[opp],
      mulligan: { done: m.mull[seat].done, oppDone: m.mull[opp].done, startIds: m.mull[seat].done ? [] : (st.seats[seat].startIds || []), remainMs: m.phase === 'mulligan' ? Math.max(0, m.mullUntil - now) : 0 },
      introMs: m.phase === 'mulligan' && !m.over ? Math.max(0, m.startedAt + cfg.introMs - now) : 0,   // v147 남은 매칭 연출 시간 (재접속이면 보통 0)
      turnMs: cfg.turnMs, remainMs: (m.phase === 'play' && !m.over) ? Math.max(0, m.deadline - now) : 0, turnSeat: st.turn,
      timeouts: m.timeouts[seat], maxTimeouts: cfg.maxTimeouts,
      deck: m.decks[seat],                                        // 내 덱 구성 ("덱 보기" 창용). 상대 덱은 보내지 않는다
      view: E.viewFor(st, seat), events: [], ...extra,
    };
  }
  function broadcast(x, m, events, extra) {
    for (let seat = 0; seat < 2; seat++) {
      const u = userOf(x, m.uids[seat]); if (!u) continue;
      sendTo(x, u, matchMsg(x, m, seat, { events: events ? scrubEvents(events, seat) : [], ...(extra || {}) }));
    }
    const specs = Object.keys(m.spectators);
    if (specs.length) {                                            // v136 관전자: 양쪽 비공개 정보를 모두 가린 이벤트
      const sev = events ? scrubEvents(events, -1) : [];
      for (const sid of specs) { const u = userOf(x, sid); if (u) sendTo(x, u, specMsg(x, m, Number(sid), { events: sev, ...(extra || {}) })); }
    }
  }
  // ---------- v136 관전 ----------
  function specView(st, seat) {
    const v = E.viewFor(st, seat);
    v.me.handCount = v.me.hand.length; v.me.hand = []; delete v.me.deckCards;
    v.legal = [];
    if (v.pending) v.pending = { kind: v.pending.kind, seat: v.pending.seat };
    v.spectate = true;
    return v;
  }
  function specMsg(x, m, uid, extra) {
    const seat = m.spectators[uid] ?? 0, st = m.state, now = x.now;
    return {
      t: 'match', spectate: true, matchId: m.id, seat, ranked: !!m.ranked, friendly: !!m.friendly, spectators: Object.keys(m.spectators).length,
      phase: m.over ? 'over' : m.phase, seq: m.seq, names: m.names.slice(),
      opp: { name: m.names[1 - seat], online: m.offline[1 - seat] == null }, me: { name: m.names[seat], online: m.offline[seat] == null }, oppOfflineMs: 0,
      mulligan: { done: true, oppDone: m.mull[1 - seat].done, startIds: [], remainMs: m.phase === 'mulligan' ? Math.max(0, m.mullUntil - now) : 0 },
      turnMs: cfg.turnMs, remainMs: (m.phase === 'play' && !m.over) ? Math.max(0, m.deadline - now) : 0, turnSeat: st.turn,
      timeouts: 0, maxTimeouts: cfg.maxTimeouts,
      view: specView(st, seat), events: [], ...extra,
    };
  }
  function stopSpectating(x, u) {
    if (!u || !u.spectating) return;
    const m = matchById(x, u.spectating); u.spectating = null;
    if (m && m.spectators[u.uid] !== undefined) { delete m.spectators[u.uid]; pushSpecCount(x, m); }
  }
  function pushSpecCount(x, m) { for (const uid of m.uids) sendTo(x, userOf(x, uid), { t: 'spectators', matchId: m.id, count: Object.keys(m.spectators).length }); }

  // ---------- v136 친구 대전 신청 ----------
  const invitesOf = (x, uid) => Object.values(x.W.invites).filter(iv => iv.from === uid || iv.to === uid);
  const nameOf = (x, uid) => { const u = userOf(x, uid); return u ? u.username : ''; };
  function inviteMsgFor(x, iv, uid) {
    const remainMs = Math.max(0, iv.until - x.now);
    return iv.to === uid ? { t: 'invite', id: iv.id, from: { id: iv.from, name: nameOf(x, iv.from) }, remainMs }
                         : { t: 'inviteSent', id: iv.id, to: { id: iv.to, name: nameOf(x, iv.to) }, remainMs };
  }
  function dropInvite(x, iv, why) {
    if (!x.W.invites[iv.id]) return;
    delete x.W.invites[iv.id];
    for (const uid of [iv.from, iv.to]) sendTo(x, userOf(x, uid), { t: 'inviteGone', id: iv.id, why, name: nameOf(x, uid === iv.from ? iv.to : iv.from), mine: uid === iv.from });
    for (const uid of [iv.from, iv.to]) gc(x, userOf(x, uid));
  }
  async function respondIn(x, uid, id, accept, heroPower) {
    const iv = x.W.invites[String(id || '')];
    if (!iv || iv.to !== uid) return { ok: false, error: '이미 끝났거나 없는 신청이에요.' };
    if (!accept) { dropInvite(x, iv, 'declined'); return { ok: true }; }
    const a = userOf(x, iv.from), b = userOf(x, iv.to);
    if (!live(b)) return { ok: false, error: '서버와 연결되어 있지 않아요. 화면을 새로고침해 주세요.' };
    if (b.matchId) return { ok: false, error: '이미 대전 중이에요.' };
    if (!live(a) || a.matchId) { dropInvite(x, iv, a && a.matchId ? 'busy' : 'offline'); return { ok: false, error: '친구가 지금 대전을 시작할 수 없어요.' }; }
    b.qpower = E.HERO_POWERS[heroPower] ? heroPower : null; a.qpower = iv.power;
    dropInvite(x, iv, 'accepted');
    await startMatch(x, iv.from, iv.to, 'friend');
    await pushAllQueued(x);
    return { ok: true };
  }
  function presenceIn(x, uid) {
    const u = userOf(x, uid);
    if (!live(u)) {
      const m = u && matchById(x, u.matchId);                    // 판 도중 잠깐 끊긴 사람은 "대전 중"으로
      return m && !m.over ? { online: false, state: 'match', mode: m.friendly ? 'friend' : m.ranked ? 'rank' : 'normal' } : { online: false, state: 'offline' };
    }
    const m = matchById(x, u.matchId);
    if (m && !m.over) return { online: true, state: 'match', mode: m.friendly ? 'friend' : m.ranked ? 'rank' : 'normal', spectators: Object.keys(m.spectators).length };
    return { online: true, state: u.queued ? 'queue' : u.spectating ? 'spectate' : 'idle' };
  }

  // ---------- 멀리건 · 행동 ----------
  function matchOf(x, uid, matchId) {
    const u = userOf(x, uid), m = u && matchById(x, u.matchId);
    if (!m || m.over || (matchId && m.id !== matchId)) return null;
    return m;
  }
  function doMulligan(x, m, seat, ids) {
    m.log.steps.push({ m: seat, ids: ids.slice() });                  // v137
    E.mulliganHand(m.state, seat, ids);
    m.mull[seat].done = true;
    if (m.mull[0].done && m.mull[1].done) beginPlay(x, m); else broadcast(x, m);
  }
  function safeApply(state, action, seat) {
    try { return E.apply(state, action, seat); }
    catch (e) { log('apply 예외', e && e.stack || e); return { ok: false, error: '서버에서 처리하지 못했어요.', crashed: true }; }
  }
  // 엔진이 돌려준 새 상태를 판에 반영하고 양쪽에 알린다
  async function commit(x, m, newState, events, o) {
    const prevTurn = m.state.turn;
    m.state = newState; m.seq++;
    if (!newState.over && newState.turnNo > cfg.maxTurns) {          // 끝나지 않는 판: 무승부로 마친다
      newState.over = true; newState.winner = null; m.log.steps.push({ end: 'turnlimit', winner: null });
      events = events.concat([{ type: 'game_over', winner: null }]);
      return finish(x, m, null, 'turnlimit', events);
    }
    if (newState.over) return finish(x, m, newState.winner, (o && o.reason) || 'normal', events);
    if (newState.turn !== prevTurn) m.deadline = x.now + cfg.turnMs + Math.min(cfg.graceMs, events.length * 120);   // 새 턴: 제한 시간 다시
    broadcast(x, m, events, o && o.extra);
  }
  // 한쪽이 포기·시간 초과·접속 끊김으로 지는 경우: 엔진의 항복 처리를 그대로 써서 화면 연출도 같게 한다
  async function forfeit(x, m, loserSeat, reason) {
    const r = safeApply(m.state, { type: 'SURRENDER' }, loserSeat);
    if (r.ok) { m.log.steps.push({ s: loserSeat, a: { type: 'SURRENDER' } }); m.state = r.state; m.seq++; return finish(x, m, r.state.winner, reason, r.events); }
    m.state.over = true; m.state.winner = 1 - loserSeat; m.log.steps.push({ end: 'forfeit', winner: 1 - loserSeat });
    return finish(x, m, 1 - loserSeat, reason, [{ type: 'game_over', winner: 1 - loserSeat }]);
  }
  function voidMatch(x, m, why) {
    m.state.over = true; m.state.winner = null;
    log('무효 판', m.id, why);
    return finish(x, m, null, 'void', [{ type: 'game_over', winner: null }]);
  }

  // ---------- 판 끝 ----------
  async function finish(x, m, winnerSeat, reason, events) {
    if (m.over) return;
    m.over = true; m.phase = 'over';
    const settleArg = { matchId: m.id, ranked: !!m.ranked, friendly: !!m.friendly, uids: m.uids.slice(), winnerSeat, reason, turns: m.state.turnNo, startedAt: m.startedAt,
      replay: reason === 'void' ? null : { ...m.log, reason, end: { turnNo: m.state.turnNo, winner: winnerSeat, hp: m.state.seats.map(s => s.hp) } } };   // v137 무효 판은 리플레이 없음
    let res = null;
    for (let i = 0; i < 2 && !res; i++) { try { res = await settle(settleArg); } catch (e) { log('정산 실패', i, e && e.message); } }
    if (!res) res = [{ reward: 0, why: 'error' }, { reward: 0, why: 'error' }];      // 정산이 두 번 다 실패: 보상 없이 결과만 보여 준다
    m.result = res;
    delete x.W.matches[m.id];
    log('판 끝', m.id, reason, winnerSeat);
    for (let seat = 0; seat < 2; seat++) {
      const u = userOf(x, m.uids[seat]); if (!u) continue;
      const rs = res[seat] || {};
      const result = {
        youWon: winnerSeat === seat, draw: winnerSeat === null && reason !== 'void', void: reason === 'void', ranked: !!m.ranked, friendly: !!m.friendly,
        reason, turns: m.state.turnNo, oppName: m.names[1 - seat], ...rs,
      };
      const msg = matchMsg(x, m, seat, { events: scrubEvents(events || [], seat), result });
      u.matchId = null;
      if (live(u)) { sendTo(x, u, msg); await pushStatus(x, u); } else u.unseen = msg;
    }
    for (const [sid, seat] of Object.entries(m.spectators)) {           // v136 관전자: 결과만 (보상 없음)
      const u = userOf(x, sid); if (!u) continue;
      const result = { spectate: true, winnerName: winnerSeat === null ? null : m.names[winnerSeat], youWon: winnerSeat === seat, draw: winnerSeat === null && reason !== 'void', void: reason === 'void',
        ranked: !!m.ranked, friendly: !!m.friendly, reason, turns: m.state.turnNo, names: m.names.slice(), reward: 0 };
      const msg = specMsg(x, m, Number(sid), { events: scrubEvents(events || [], -1), result });
      u.spectating = null;
      if (live(u)) { sendTo(x, u, msg); await pushStatus(x, u); }
      gc(x, u);
    }
    m.spectators = {};
    for (const uid of m.uids) gc(x, userOf(x, uid));
  }

  // ---------- 시계: 멀리건·턴 제한·접속 끊김·대기 시간 ----------
  async function onTurnTimeout(x, m) {
    const seat = m.state.turn;
    m.timeouts[seat]++;
    if (m.timeouts[seat] >= cfg.maxTimeouts) return forfeit(x, m, seat, 'timeout');
    // 선택(발견·대상)이 남아 있으면 첫 번째 선택지를 고르고, 턴을 넘긴다
    let st = m.state; const evs = [];
    for (let i = 0; i < 30 && !st.over && st.turn === seat; i++) {
      const act = st.pending ? (E.viewFor(st, seat).legal[0] || { type: 'END_TURN' }) : { type: 'END_TURN' };
      const r = safeApply(st, act, seat);
      if (!r.ok) break;
      m.log.steps.push({ s: seat, a: act, auto: 1 });                  // v137 시간 초과로 자동 처리된 행동
      st = r.state; evs.push(...r.events);
    }
    if (!st.over && st.turn === seat) return voidMatch(x, m, '시간 초과 처리 실패');
    return commit(x, m, st, evs, { extra: { timeoutSeat: seat } });
  }
  async function tickIn(x) {
    const now = x.now, W = x.W;
    // 끊긴 탭 정리 (ping 이 connTtlMs 동안 없음)
    for (const u of Object.values(W.users)) {
      for (const c of u.conns.slice()) if (now - c.seen > cfg.connTtlMs) dropConn(x, u, c.cid, c.seen);
    }
    for (const m of Object.values(W.matches)) {
      if (m.over) continue;
      if (m.phase === 'mulligan' && now >= m.mullUntil) {
        for (let s = 0; s < 2 && m.phase === 'mulligan'; s++) if (!m.mull[s].done) doMulligan(x, m, s, []);   // 시간 안에 안 고르면 그대로 시작
      }
      const gone = [0, 1].filter(s => m.offline[s] != null && now - m.offline[s] >= cfg.reconnectMs);
      if (gone.length === 2) { await voidMatch(x, m, '둘 다 접속 끊김'); continue; }
      if (gone.length === 1) { await forfeit(x, m, gone[0], 'disconnect'); continue; }
      // 턴 시간 초과 (요청이 늦게 와서 여러 턴이 밀렸어도 한 번에 하나씩, 최대 몇 번만)
      for (let k = 0; k < 4 && !m.over && m.phase === 'play' && now >= m.deadline; k++) await onTurnTimeout(x, m);
    }
    let changed = false;                                            // 대기열 정리
    for (const uid of W.queue.slice()) {
      const u = userOf(x, uid); if (!u) { changed = true; continue; }
      const gone = !live(u) && u.goneAt && now - u.goneAt > cfg.queueGraceMs, tooLong = now - u.queuedAt > cfg.queueMaxMs;
      if (gone || tooLong) { leaveQueue(x, u); changed = true; if (live(u)) { sendTo(x, u, { t: 'error', error: '대기 시간이 길어져 대기를 취소했어요. 다시 눌러 주세요.' }); await pushStatus(x, u); } gc(x, u); }
    }
    if (changed) { W.queue = W.queue.filter(id => userOf(x, id)); await pushAllQueued(x); }
    for (const iv of Object.values(W.invites)) {                     // v136 친구 대전 신청: 시간이 지났거나 한쪽이 나갔으면 지운다
      if (now >= iv.until) { dropInvite(x, iv, 'expired'); continue; }
      const gone = [iv.from, iv.to].some(id => { const y = userOf(x, id); return !y || (!live(y) && y.goneAt && now - y.goneAt > cfg.queueGraceMs); });
      if (gone) dropInvite(x, iv, 'offline');
    }
    await pump(x);
  }

  // ================= 밖에서 부르는 함수 (전부 async) =================
  async function hello(uid, username, cid) {
    cid = String(cid || '').slice(0, 40) || crypto.randomBytes(6).toString('hex');
    return op(async x => { const u = connectIn(x, uid, username, cid); return { cid, msgs: await helloMsgs(x, u) }; });
  }
  // ping: 살아 있다는 신호 (+ 시계). 모르는 탭이면(오래 끊겼다 돌아옴) hello 처럼 지금 상태를 돌려준다
  async function ping(uid, username, cid) {
    cid = String(cid || '').slice(0, 40);
    return op(async x => {
      const u = userOf(x, uid), c = u && u.conns.find(y => y.cid === cid);
      if (c) { c.seen = x.now; if (username) u.username = username; return { ok: true }; }
      const nu = connectIn(x, uid, username, cid);
      return { ok: true, resync: true, msgs: await helloMsgs(x, nu) };
    });
  }
  async function bye(uid, cid) {
    return op(async x => { const u = userOf(x, uid); if (u) dropConn(x, u, String(cid || '')); return { ok: true }; });
  }
  async function tick() { return op(async () => ({ ok: true })); }

  async function queueJoin(uid, mode, heroPower) {
    return op(async x => {
      const u = userOf(x, uid); const md = mode === 'rank' ? 'rank' : 'normal';   // v127 일반전 / 랭크전
      if (u) u.qpower = E.HERO_POWERS[heroPower] ? heroPower : null;            // v131 고른 영웅 능력 (없거나 잘못되면 판 시작 때 무작위)
      if (!live(u)) return { ok: false, error: '서버와 연결되어 있지 않아요. 화면을 새로고침해 주세요.' };
      if (u.matchId) return { ok: false, error: '이미 대전 중이에요.' };
      if (u.queued && u.qmode === md) return { ok: true, already: true };
      stopSpectating(x, u);                                                // v136 관전 중이면 그만 본다
      for (const iv of invitesOf(x, uid)) if (iv.from === uid) dropInvite(x, iv, 'cancelled');   // v136 내가 보낸 친구 대전 신청은 취소
      if (u.queued) leaveQueue(x, u);                                      // 다른 대기열에 있었으면 옮긴다 (랭크전 → 일반전 전환)
      u.queued = true; u.qmode = md; u.queuedAt = x.now; x.W.queue.push(uid);
      await pump(x);
      await pushAllQueued(x);
      if (!u.queued && !u.matchId) await pushStatus(x, u);
      return { ok: true };
    });
  }
  async function queueCancel(uid) {
    return op(async x => {
      const u = userOf(x, uid);
      if (!u || !u.queued) return { ok: false, error: '대기 중이 아니에요.' };
      leaveQueue(x, u); await pushStatus(x, u); await pushAllQueued(x); gc(x, u);
      return { ok: true };
    });
  }
  async function mulligan(uid, matchId, ids) {
    return op(async x => {
      const m = matchOf(x, uid, matchId);
      if (!m) return { ok: false, error: '진행 중인 판이 없어요.' };
      if (m.phase !== 'mulligan') return { ok: false, error: '멀리건 시간이 지났어요.' };
      const seat = m.uids.indexOf(uid);
      if (m.mull[seat].done) return { ok: false, error: '이미 선택했어요.' };
      if (!Array.isArray(ids) || ids.length > 10 || !ids.every(Number.isInteger)) return { ok: false, error: '잘못된 선택이에요.' };
      doMulligan(x, m, seat, ids);
      return { ok: true, hand: E.viewFor(m.state, seat).me.hand };   // v158 바뀐 손패 (멀리건 연출: 같은 칸의 새 카드가 덱에서 나온다)
    });
  }
  // v132 감정 표현: 상대에게 말풍선만 전달 (게임 상태와 무관). 너무 자주 보내면 거절
  async function emote(uid, matchId, id) {
    return op(async x => {
      const m = matchOf(x, uid, matchId);
      if (!m || m.over) return { ok: false, error: '진행 중인 판이 없어요.' };
      if (!EMOTE_IDS.includes(id)) return { ok: false, error: '잘못된 감정 표현이에요.' };
      const seat = m.uids.indexOf(uid);
      m.emoteAt = m.emoteAt || [0, 0];
      if (x.now - m.emoteAt[seat] < PROGRESS.EMOTE_GAP_MS) return { ok: false, error: '조금 뒤에 다시 보내 주세요.' };
      m.emoteAt[seat] = x.now;
      sendTo(x, userOf(x, m.uids[1 - seat]), { t: 'emote', matchId: m.id, seat, id });
      for (const sid of Object.keys(m.spectators)) sendTo(x, userOf(x, sid), { t: 'emote', matchId: m.id, seat, id });   // v136 관전자에게도
      return { ok: true };
    }, { tick: false });
  }
  async function action(uid, matchId, seq, raw) {
    return op(async x => {
      const m = matchOf(x, uid, matchId);
      if (!m) return { ok: false, error: '진행 중인 판이 없어요.' };
      const a = cleanAction(raw);
      if (!a) return { ok: false, error: '알 수 없는 행동이에요.' };
      const seat = m.uids.indexOf(uid);
      if (a.type !== 'SURRENDER') {
        if (m.phase !== 'play') return { ok: false, error: '아직 멀리건 중이에요.' };
        if (!Number.isInteger(seq) || seq !== m.seq) return { ok: false, stale: true, error: '화면이 최신이 아니에요. 잠시 뒤 다시 해 주세요.' };
      }
      const r = safeApply(m.state, a, seat);
      if (!r.ok) return { ok: false, error: r.error };
      m.log.steps.push({ s: seat, a });                   // v137 리플레이
      m.timeouts[seat] = 0;                               // 직접 행동했으면 "연속 시간 초과"는 처음부터
      await commit(x, m, r.state, r.events, a.type === 'SURRENDER' ? { reason: 'surrender' } : null);
      return { ok: true, seq: m.seq };
    });
  }
  // 친구에게 대전 신청 (친구인지는 부르는 쪽이 확인한다). 상대가 이미 나에게 신청했으면 바로 시작
  async function invite(from, to, heroPower) {
    return op(async x => {
      const u = userOf(x, from), t = userOf(x, to);
      if (!live(u)) return { ok: false, error: '서버와 연결되어 있지 않아요. 화면을 새로고침해 주세요.' };
      if (from === to) return { ok: false, error: '나 자신과는 대전할 수 없어요.' };
      if (u.matchId) return { ok: false, error: '이미 대전 중이에요.' };
      if (!live(t)) return { ok: false, error: '친구가 지금 접속해 있지 않아요.' };
      if (t.matchId) return { ok: false, error: '친구가 지금 대전 중이에요. 관전은 할 수 있어요.' };
      u.qpower = E.HERO_POWERS[heroPower] ? heroPower : null;
      const back = Object.values(x.W.invites).find(iv => iv.from === to && iv.to === from);
      if (back) return respondIn(x, from, back.id, true, heroPower);
      for (const iv of invitesOf(x, from)) if (iv.from === from) dropInvite(x, iv, 'cancelled');   // 신청은 한 번에 한 명에게만
      if (u.queued) { leaveQueue(x, u); await pushStatus(x, u); await pushAllQueued(x); }
      const iv = { id: crypto.randomBytes(6).toString('hex'), from, to, at: x.now, until: x.now + cfg.inviteMs, power: u.qpower };
      x.W.invites[iv.id] = iv;
      sendTo(x, t, inviteMsgFor(x, iv, to)); sendTo(x, u, inviteMsgFor(x, iv, from));
      return { ok: true, id: iv.id, remainMs: cfg.inviteMs };
    });
  }
  const respond = (uid, id, accept, heroPower) => op(x => respondIn(x, uid, id, accept, heroPower));
  async function inviteCancel(uid) {
    return op(async x => {
      let n = 0; for (const iv of invitesOf(x, uid)) if (iv.from === uid) { dropInvite(x, iv, 'cancelled'); n++; }
      return n ? { ok: true } : { ok: false, error: '보낸 신청이 없어요.' };
    });
  }
  // targetUid 가 하고 있는 판을 본다 (친구인지는 부르는 쪽이 확인한다)
  async function spectate(uid, targetUid) {
    return op(async x => {
      const u = userOf(x, uid);
      if (!live(u)) return { ok: false, error: '서버와 연결되어 있지 않아요. 화면을 새로고침해 주세요.' };
      if (u.matchId) return { ok: false, error: '대전 중에는 관전할 수 없어요.' };
      const t = userOf(x, targetUid), m = t && matchById(x, t.matchId);
      if (!m || m.over) return { ok: false, error: '친구가 지금 대전 중이 아니에요.' };
      if (m.uids.includes(uid)) return { ok: false, error: '내가 하는 판이에요.' };
      const n = Object.keys(m.spectators).length;
      if (m.spectators[uid] === undefined && n >= cfg.maxSpectators) return { ok: false, error: `이 판은 관전 인원이 가득 찼어요 (최대 ${cfg.maxSpectators}명).` };
      if (u.queued) { leaveQueue(x, u); await pushStatus(x, u); await pushAllQueued(x); }
      if (u.spectating && u.spectating !== m.id) stopSpectating(x, u);
      u.spectating = m.id; m.spectators[uid] = m.uids.indexOf(targetUid);
      sendTo(x, u, specMsg(x, m, uid)); pushSpecCount(x, m);
      return { ok: true, matchId: m.id };
    });
  }
  async function spectateLeave(uid) {
    return op(async x => {
      const u = userOf(x, uid); if (!u || !u.spectating) return { ok: true };
      stopSpectating(x, u); await pushStatus(x, u); gc(x, u);
      return { ok: true };
    });
  }
  // 친구 목록에 보일 접속 상태 (여러 명을 한 번에)
  async function presenceMany(uids) { return op(async x => { const out = {}; for (const id of uids) out[id] = presenceIn(x, id); return out; }); }
  async function presenceOf(uid) { return (await presenceMany([uid]))[uid]; }
  async function stateOf(uid) { return op(async x => stateOf_(x, uid)); }
  // 알림만 보내기 (world 를 안 건드린다: 친구 요청·채팅 등)
  async function notify(uid, msg) { try { await publish([{ uid, msg }]); } catch (e) { log('알림 실패', e && e.message); } }
  async function rename(uid, name) {
    return op(async x => {
      const u = userOf(x, uid); if (u && name) u.username = name;
      for (const iv of invitesOf(x, uid)) for (const id of [iv.from, iv.to]) { const y = userOf(x, id); if (y) sendTo(x, y, inviteMsgFor(x, iv, id)); }
    }, { tick: false });
  }

  let timer = null;
  if (cfg.tickMs > 0) {
    timer = setInterval(() => { tick().catch(e => log('tick 예외', e && e.stack || e)); }, cfg.tickMs);
    if (timer.unref) timer.unref();
  }
  function shutdown() { if (timer) clearInterval(timer); timer = null; }

  return {
    hello, ping, bye, tick, queueJoin, queueCancel, mulligan, emote, action, stateOf, shutdown,
    invite, respond, inviteCancel, spectate, spectateLeave, presenceOf, presenceMany, notify, rename,
    cfg, _peek: () => store.peek ? store.peek() : null,
  };
}

module.exports = { createPvp, cleanAction, scrubEvents, emptyWorld };
