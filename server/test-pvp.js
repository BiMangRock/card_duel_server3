// test-pvp.js — 유저 대전 확인: 판 진행 · 숨겨진 정보 · 턴 제한 시간 · 시간 초과 패배 · 접속 끊김 · 항복 · 잘못된 행동 · HTTP(hello·ping·롱 폴링) 통신 (임시 DB 사용)
process.env.DB_PATH = ':memory:';
const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
const JS = path.join(__dirname, '..', 'public', 'js');
const E = require(path.join(JS, 'engine.js'));
const { PVP } = require(path.join(JS, 'pvp.js'));
const { cleanAction, scrubEvents } = require('./pvp-core');
const { mkCore: mkCoreRaw } = require('./test-pvp-helper');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 5000, what = '') => { const t0 = Date.now(); while (!(await f())) { if (Date.now() - t0 > ms) throw new Error('시간 초과 대기: ' + what); await sleep(10); } };
const deck = E.defaultDeckList();

// 가짜 탭: 받은 메시지를 모아 둔다
function mkClient(core, uid) {
  const c = { uid, msgs: [], last: null, conn: null };
  c.conn = { send: raw => { const m = JSON.parse(JSON.stringify(raw)); c.msgs.push(m); if (m.t === 'match') c.last = m; } };
  c.join = () => core.connect(uid, 'u' + uid, c.conn);
  c.status = () => [...c.msgs].reverse().find(m => m.t === 'status');
  return c;
}
// 테스트에서는 시계를 50ms 마다 스스로 돌린다 (실제 Vercel 에서는 ping 요청이 시계)
function mkCore(extra = {}, cfg = {}) {
  const settled = [];
  const core = mkCoreRaw({
    cfg: { turnMs: 5000, mulliganMs: 5000, reconnectMs: 5000, graceMs: 0, tickMs: 50, ...cfg }, loadDeck: () => deck.slice(),
    settle: async g => { settled.push(g); return [{ reward: g.winnerSeat === 0 ? 50 : 0 }, { reward: g.winnerSeat === 1 ? 50 : 0 }]; }, ...extra,
  });
  core.matchNow = async id => (await core._peek()).matches[id];
  return { core, settled };
}
async function startMatch(core, ...uids) {
  const cs = uids.map(u => mkClient(core, u)); for (const c of cs) await c.join();
  for (const u of uids) assert.ok((await core.queueJoin(u)).ok);
  await until(() => cs.every(c => c.last), 2000, '매칭');
  const mid = cs[0].last.matchId;
  for (const u of uids) assert.ok((await core.mulligan(u, mid, [])).ok, '멀리건');
  await until(() => cs.every(c => c.last.phase === 'play'), 2000, '멀리건 끝');
  return cs;
}
const turnClient = cs => cs.find(c => c.last.turnSeat === c.last.seat);

(async () => {
  // ===== 행동 정리 =====
  assert.strictEqual(cleanAction({ type: 'HACK' }), null);
  assert.strictEqual(cleanAction({ type: 'PLAY_CARD', cardId: 'x' }), null, '정수가 아닌 값은 거부');
  assert.strictEqual(cleanAction(null), null);
  assert.deepStrictEqual(cleanAction({ type: 'END_TURN', junk: { a: 1 } }), { type: 'END_TURN' }, '모르는 필드는 버린다');
  console.log('✔ 행동 정리');

  // ===== 판 시작 · 숨겨진 정보 =====
  {
    const { core } = mkCore();
    const [a, b] = await startMatch(core, 1, 2);
    assert.notStrictEqual(a.last.seat, b.last.seat);
    for (const c of [a, b]) {
      const m = c.last, v = m.view;
      assert.strictEqual(v.opp.hand, undefined, '상대 손패 내용은 안 보낸다');
      assert.ok(typeof v.opp.handCount === 'number');
      assert.ok(Array.isArray(m.deck) && m.deck.length === 30, '내 덱만 보낸다');
      assert.strictEqual(v.opp.deckCards, undefined, '상대 덱 구성은 안 보낸다');
      assert.ok(m.remainMs > 0 && m.remainMs <= 5000, '남은 시간이 온다');
    }
    const ev = scrubEvents([{ type: 'generated', seat: 1, name: '비밀카드', cost: 3, card: {} }, { type: 'generated', seat: 0, name: '내카드', cost: 2 }], 0);
    assert.strictEqual(ev[0].name, '카드'); assert.strictEqual(ev[1].name, '내카드', '내 카드는 그대로');
    console.log('✔ 판 시작 · 상대 정보 가림');

    // 내 차례가 아닐 때 / 낡은 seq / 이상한 행동
    const mine = turnClient(a === turnClient([a, b]) ? [a, b] : [a, b]), other = mine === a ? b : a, mid = mine.last.matchId;
    let r = await core.action(other.uid, mid, other.last.seq, { type: 'END_TURN' }); assert.ok(!r.ok, '내 턴이 아니면 거부');
    r = await core.action(mine.uid, mid, mine.last.seq + 5, { type: 'END_TURN' }); assert.ok(!r.ok && r.stale, '낡은 seq 거부');
    r = await core.action(mine.uid, mid, mine.last.seq, { type: 'NOPE' }); assert.ok(!r.ok);
    r = await core.action(mine.uid, 'wrong', mine.last.seq, { type: 'END_TURN' }); assert.ok(!r.ok, '다른 판 번호 거부');
    const seq0 = mine.last.seq;
    r = await core.action(mine.uid, mid, seq0, { type: 'END_TURN' }); assert.ok(r.ok);
    await until(() => other.last.seq === seq0 + 1 && mine.last.seq === seq0 + 1, 1000, '턴 종료 전달');
    assert.strictEqual(other.last.view.turn, other.last.seat, '턴이 넘어감');
    r = await core.action(mine.uid, mid, seq0, { type: 'END_TURN' }); assert.ok(!r.ok && r.stale, '같은 요청 재전송은 거부 (더블 클릭)');
    console.log('✔ 순서 · 낡은 요청 · 잘못된 행동 거부');

    // 항복
    r = await core.action(mine.uid, mid, mine.last.seq, { type: 'SURRENDER' }); assert.ok(r.ok);
    await until(() => a.last.result && b.last.result, 1000, '항복 결과');
    assert.strictEqual(mine.last.result.reason, 'surrender'); assert.strictEqual(other.last.result.youWon, true);
    assert.strictEqual(other.last.result.reward, 50, '정산 결과가 메시지에 들어간다');
    assert.strictEqual(await core.stateOf(1), 'idle'); core.shutdown();
    console.log('✔ 항복');
  }

  // ===== 턴 제한 시간: 넘어가고, 연속으로 쌓이면 패배 =====
  {
    const { core, settled } = mkCore({}, { turnMs: 300, maxTimeouts: 2 });
    const cs = await startMatch(core, 11, 12);
    const first = turnClient(cs), mid = first.last.matchId, seq0 = first.last.seq;
    await until(() => first.last.seq > seq0, 2000, '시간 초과로 턴 넘김');
    const t = first.msgs.find(m => m.t === 'match' && m.timeoutSeat !== undefined);
    assert.ok(t && t.timeoutSeat === first.last.seat || cs.some(c => c.msgs.some(m => m.timeoutSeat === first.last.seat)), '시간 초과 알림');
    assert.ok((await core.matchNow(mid)).timeouts[first.last.seat] >= 1);
    await until(() => cs.every(c => c.last.result), 4000, '연속 시간 초과 패배');   // 둘 다 가만있으면 먼저 2번 쌓인 쪽(=먼저 두던 쪽)이 진다
    const loser = cs.find(c => !c.last.result.youWon);
    assert.strictEqual(loser.last.result.reason, 'timeout'); assert.strictEqual(settled.length, 1); assert.strictEqual(settled[0].reason, 'timeout');
    core.shutdown(); console.log('✔ 턴 제한 시간 · 연속 시간 초과 패배');
  }
  // 직접 행동하면 연속 횟수가 0 으로
  {
    const { core } = mkCore({}, { turnMs: 400, maxTimeouts: 3 });
    const cs = await startMatch(core, 21, 22);
    const first = turnClient(cs), mid = first.last.matchId;
    await until(async () => (await core.matchNow(mid)).timeouts[first.last.seat] === 1, 2000, '1회 초과');
    await until(() => cs.every(c => c.last.timeoutSeat !== undefined), 1000, '시간 초과 화면 도착');
    const p = cs.find(c => c.last.turnSeat === c.last.seat);
    assert.ok((await core.action(p.uid, mid, p.last.seq, { type: 'END_TURN' })).ok);
    assert.strictEqual((await core.matchNow(mid)).timeouts[p.last.seat], 0, '직접 행동하면 초기화');
    core.shutdown(); console.log('✔ 직접 행동 시 시간 초과 횟수 초기화');
  }

  // ===== 접속 끊김: 돌아오면 이어서, 못 돌아오면 패배 =====
  {
    const { core, settled } = mkCore({}, { reconnectMs: 400 });
    const [a, b] = await startMatch(core, 31, 32);
    await core.disconnect(a.uid, a.conn);
    await until(() => b.msgs.some(m => m.t === 'presence' && m.oppOnline === false), 1000, '상대 끊김 알림');
    const re = mkClient(core, a.uid); await re.join();
    await until(() => re.last, 1000, '재접속 상태 수신');
    assert.strictEqual(re.last.phase, 'play'); assert.strictEqual(re.last.seat, a.last.seat, '같은 자리로 이어짐');
    await until(() => b.msgs.some(m => m.t === 'presence' && m.oppOnline === true), 1000, '복귀 알림');
    await core.disconnect(a.uid, re.conn);
    await until(() => b.last.result, 3000, '끊김 패배');
    assert.strictEqual(b.last.result.youWon, true); assert.strictEqual(b.last.result.reason, 'disconnect'); assert.strictEqual(settled[0].reason, 'disconnect');
    const back = mkClient(core, a.uid); await back.join();       // 끊긴 사이에 끝난 판의 결과는 돌아왔을 때 한 번 보여 준다
    await until(() => back.last && back.last.result, 1000, '못 본 결과');
    assert.strictEqual(back.last.result.youWon, false);
    core.shutdown(); console.log('✔ 접속 끊김 · 재접속 · 끊김 패배');
  }
  // 둘 다 끊기면 무효 판 (전적·보상 없음)
  {
    const { core, settled } = mkCore({}, { reconnectMs: 300 });
    const [a, b] = await startMatch(core, 41, 42);
    await core.disconnect(a.uid, a.conn); await core.disconnect(b.uid, b.conn);
    await until(() => settled.length === 1, 2000, '무효 판');
    assert.strictEqual(settled[0].reason, 'void'); core.shutdown(); console.log('✔ 둘 다 끊기면 무효');
  }
  // ping 이 끊기면(탭이 말없이 사라짐) connTtlMs 뒤 끊김으로 본다 → reconnectMs 뒤 패배. 다시 ping 하면 지금 상태를 받는다
  {
    const { core, settled } = mkCore({}, { reconnectMs: 300, connTtlMs: 200 });
    const [a, b] = await startMatch(core, 43, 44);
    const keep = setInterval(() => core.ping(b.uid, 'u' + b.uid, b.conn.cid).catch(() => {}), 50);   // b 는 계속 살아 있음
    core.unsubscribe(a.uid, a.conn);                                                                    // a 는 아무 말 없이 사라짐
    await until(() => b.msgs.some(m => m.t === 'presence' && m.oppOnline === false), 2000, 'ping 끊김 감지');
    await until(() => b.last.result, 3000, 'ping 끊김 패배');
    clearInterval(keep);
    assert.strictEqual(b.last.result.reason, 'disconnect'); assert.strictEqual(settled[0].reason, 'disconnect');
    const r = await core.ping(a.uid, 'u' + a.uid, a.conn.cid);
    assert.ok(r.resync && r.msgs.some(m => m.t === 'match' && m.result && !m.result.youWon), '오래 끊겼다 돌아온 탭은 지금 상태(못 본 결과)를 받는다');
    core.shutdown(); console.log('✔ ping 끊김 감지 · 다시 붙으면 상태 다시 받기');
  }

  // ===== 멀리건 시간 =====
  {
    const { core } = mkCore({}, { mulliganMs: 300 });
    const cs = [51, 52].map(u => mkClient(core, u)); for (const c of cs) await c.join(); for (const c of cs) await core.queueJoin(c.uid);
    await until(() => cs.every(c => c.last), 1000);
    assert.strictEqual(cs[0].last.phase, 'mulligan');
    await until(() => cs.every(c => c.last.phase === 'play'), 2000, '멀리건 시간이 지나면 그대로 시작');
    core.shutdown(); console.log('✔ 멀리건 제한 시간');
  }

  // ===== 대기열 =====
  {
    const { core } = mkCore();
    const a = mkClient(core, 61); await a.join();
    assert.ok((await core.queueJoin(61)).ok); assert.strictEqual(await core.stateOf(61), 'queue');
    assert.ok((await core.queueJoin(61)).already, '두 번 눌러도 한 번만');
    assert.ok((await core.queueCancel(61)).ok); assert.strictEqual(await core.stateOf(61), 'idle'); assert.ok(!(await core.queueCancel(61)).ok);
    assert.ok(!(await core.queueJoin(999)).ok, '연결 없이는 대기열에 못 들어감');
    core.shutdown(); console.log('✔ 대기열');
  }

  // ===== HTTP: 실제 서버로 두 사람이 붙어서 한 판 (hello · 롱 폴링 · ping) =====
  const auth = require('./auth'), saves = require('./saves');
  const pvpMod = require('./pvp');
  const app = express(); app.use(express.json());
  app.use('/api', auth.router); app.use('/api', saves.router); app.use('/api', pvpMod.router);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mkUser = name => {
    let cookie = ''; const u = { msgs: [], last: null, cookie: () => cookie, stop: false };
    u.call = async (method, url, body, headers = {}) => {
      const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    u.signup = () => u.call('POST', '/api/signup', { username: name, nickname: name, password: 'password123' });
    const take = m => { u.msgs.push(m); if (m.t === 'match') u.last = m; };
    // 탭 열기: hello 로 지금 상태를 받고, 롱 폴링으로 이어서 받는다 (화면의 pvpclient.js 와 같은 흐름)
    u.open = async (cid = 'tab-' + name) => {
      const r = await u.call('POST', '/api/pvp/hello', { cid });
      assert.strictEqual(r.status, 200); assert.strictEqual(r.data.rt.mode, 'poll', '테스트는 로컬(롱 폴링) 모드');
      r.data.msgs.forEach(take);
      let after = r.data.rt.after;
      (async () => { while (!u.stop) { const p = await u.call('GET', `/api/pvp/poll?after=${after}&wait=2000`); if (p.status !== 200) break; after = p.data.last; p.data.msgs.forEach(x => take(x.msg)); } })();
      return r.data;
    };
    return u;
  };
  try {
    const A = mkUser('pvpalice'), B = mkUser('pvpbob');
    const nohello = await fetch(base + '/api/pvp/hello', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.strictEqual(nohello.status, 401, '로그인 전엔 거부');
    await A.signup(); await B.signup();
    assert.strictEqual((await A.call('GET', '/api/pvp/status')).data.state, 'idle');
    assert.strictEqual((await A.call('POST', '/api/pvp/queue')).status, 400, 'hello 전에는 대기열에 못 들어감');
    assert.strictEqual((await A.call('POST', '/api/pvp/hello', { cid: 'x' }, { origin: 'https://evil.example' })).status, 403, '다른 사이트에서 온 요청 거부');
    const ha = await A.open(); await B.open();
    assert.ok(ha.pingMs > 0, 'ping 간격을 알려 준다');
    await until(() => A.msgs.some(m => m.t === 'status') && B.msgs.some(m => m.t === 'status'), 2000, '첫 상태');
    assert.strictEqual(A.msgs.find(m => m.t === 'status').winGold, PVP.WIN_GOLD);
    assert.strictEqual((await A.call('POST', '/api/pvp/queue')).status, 200);
    assert.strictEqual((await B.call('POST', '/api/pvp/queue')).status, 200);
    await until(() => A.last && B.last, 3000, 'HTTP 매칭');
    const mid = A.last.matchId;
    assert.strictEqual((await A.call('POST', '/api/pvp/mulligan', { matchId: mid, ids: [] })).status, 200);
    assert.strictEqual((await B.call('POST', '/api/pvp/mulligan', { matchId: mid, ids: [] })).status, 200);
    await until(() => A.last.phase === 'play' && B.last.phase === 'play', 2000, '대전 시작');
    assert.strictEqual((await A.call('GET', '/api/pvp/status')).data.state, 'match', '새로고침해도 판이 이어진다');
    assert.ok((await A.call('POST', '/api/pvp/ping', { cid: 'tab-pvpalice' })).data.ok, 'ping');
    const p = [A, B].find(u => u.last.turnSeat === u.last.seat), q = p === A ? B : A;
    let r = await q.call('POST', '/api/pvp/action', { matchId: mid, seq: q.last.seq, action: { type: 'END_TURN' } });
    assert.strictEqual(r.status, 400, '내 턴이 아니면 400');
    r = await p.call('POST', '/api/pvp/action', { matchId: mid, seq: p.last.seq + 9, action: { type: 'END_TURN' } });
    assert.strictEqual(r.status, 409, '낡은 화면은 409');
    r = await p.call('POST', '/api/pvp/action', { matchId: mid, seq: p.last.seq, action: { type: 'END_TURN' } }); assert.strictEqual(r.status, 200);
    await until(() => q.last.turnSeat === q.last.seat, 2000, '상대 행동이 실시간 통로로 도착');
    // 항복 → 짧은 판이어도 이긴 쪽은 보상을 받고, 기록도 남음
    r = await q.call('POST', '/api/pvp/action', { matchId: mid, seq: q.last.seq, action: { type: 'SURRENDER' } }); assert.strictEqual(r.status, 200);
    await until(() => A.last.result && B.last.result, 2000, 'HTTP 결과');
    assert.strictEqual(p.last.result.youWon, true); assert.strictEqual(p.last.result.reward, PVP.WIN_GOLD); assert.strictEqual(p.last.result.why, undefined);
    await until(() => { const st = [...p.msgs].reverse().find(m => m.t === 'status'); return st && st.state === 'idle'; }, 2000, '끝난 뒤 상태');
    const st = [...p.msgs].reverse().find(m => m.t === 'status'); assert.strictEqual(st.record.wins, 1);
    // v148 한 계정의 탭은 4개까지 → 5번째가 오면 가장 오래된 탭에 {t:'replaced', cid} 를 보낸다
    for (let i = 0; i < 4; i++) assert.strictEqual((await p.call('POST', '/api/pvp/hello', { cid: 'extra' + i })).status, 200, '새 탭은 항상 받아 준다');
    const myCid = 'tab-' + (p === A ? 'pvpalice' : 'pvpbob');
    await until(() => p.msgs.some(m => m.t === 'replaced' && m.cid === myCid), 2000, '가장 오래된 탭에 자리 넘김 알림');
    const w = await pvpMod.core._peek(); assert.strictEqual(w.users[p === A ? 1 : 2].conns.length, 4, '연결 수는 4개 그대로');
    const rs = await p.call('POST', '/api/pvp/ping', { cid: myCid }); assert.ok(rs.data.resync, '밀려난 탭이 ping 하면 다시 붙으며 상태를 받는다');
    assert.ok((await p.call('POST', '/api/pvp/bye', { cid: myCid })).data.ok, 'bye');
    console.log('✔ HTTP 통신: hello · 롱 폴링 · ping · 매칭 · 멀리건 · 행동 · 거부 코드 · 결과 · 자리 넘김');
  } finally {
    server.closeAllConnections && server.closeAllConnections(); server.close(); pvpMod.core.shutdown();
  }
  console.log('✔ PvP 서버 테스트 통과');
  process.exit(0);
})().catch(e => { console.error('✘ 실패:', e); process.exit(1); });
