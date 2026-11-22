// pvp.js (server) — 유저 대전 API.
//  통신: 브라우저 → 서버는 평범한 POST. 서버 → 브라우저는 realtime.js (Supabase Realtime, 없으면 롱 폴링).
//   - POST /pvp/hello {cid}        탭이 붙었다. 응답: {cid, rt(실시간 접속 정보), msgs(지금 상태), pingMs}
//   - POST /pvp/ping  {cid}        살아 있다는 신호 (화면이 10초마다). 서버리스라 이 요청이 시계(턴 제한·끊김 처리)도 돌린다
//   - POST /pvp/bye   {cid}        탭을 닫는다 (바로 오프라인으로)
//   - GET  /pvp/poll?after=n       (로컬 모드에서만) 쌓인 메시지를 가져간다
//  판 진행·타이머·끊김 처리는 pvp-core.js, 보상·기록은 pvp-db.js, world 저장은 pvp-store.js.
const express = require('express');
const path = require('path');
const { requireAuth } = require('./auth');
const { createPvp } = require('./pvp-core');
const { dbStore } = require('./pvp-store');
const pvpdb = require('./pvp-db');
const rt = require('./realtime');
const { areFriends } = require('./friends-db');   // v136 친구 대전 · 관전은 친구끼리만
const { PVP } = require(path.join(__dirname, '..', 'public', 'js', 'pvp.js'));   // v147

// 계정별 요청 횟수 제한 (행동 도배 방지). 서버(함수)마다 따로 센다
function makeBucket(max, windowMs) {
  const hits = new Map();
  return uid => {
    const t = Date.now(), a = (hits.get(uid) || []).filter(x => t - x < windowMs);
    if (a.length >= max) { hits.set(uid, a); return false; }
    a.push(t); hits.set(uid, a); return true;
  };
}

function makeHandlers(pvp) {
  const customBlock = async uid => {                    // 승인 전 직접 만든 카드가 사용 중 덱에 있으면 유저 대전 불가
    const l = await require('./customcards').unapprovedInDeckOf(uid);
    return l.length ? { ok: false, error: `승인 전 직접 만든 카드(${l.join(', ')})가 덱에 있어 유저 대전에 쓸 수 없어요. AI 대전·모험에서는 쓸 수 있어요.` } : null;
  };
  const actionOk = makeBucket(60, 10000), queueOk = makeBucket(20, 10000), pingOk = makeBucket(30, 10000);
  const tooMany = res => res.status(429).json({ error: '요청이 너무 빨라요. 잠시 뒤 다시 해 주세요.' });
  const nameOf = req => req.user.name || req.user.username;   // v136 닉네임이 있으면 닉네임으로 보인다
  const send = (res, r, bad = 400) => res.status(r.ok ? 200 : (r.stale ? 409 : bad)).json(r);
  return {
    async hello(req, res) {
      const r = await pvp.hello(req.user.id, nameOf(req), (req.body || {}).cid);
      res.set('Cache-Control', 'no-store');
      res.json({ ...r, rt: rt.clientInfo(req.user.id), pingMs: pvp.cfg.pingMs });
    },
    async ping(req, res) {
      if (!pingOk(req.user.id)) return tooMany(res);
      const r = await pvp.ping(req.user.id, nameOf(req), (req.body || {}).cid);
      res.set('Cache-Control', 'no-store'); res.json(r);
    },
    async bye(req, res) { res.json(await pvp.bye(req.user.id, (req.body || {}).cid)); },
    async poll(req, res) {                                   // 로컬 모드 전용 롱 폴링
      if (rt.MODE !== 'local') return res.status(404).json({ error: '없는 API예요.' });
      const after = Math.max(0, Math.floor(Number(req.query.after) || 0));
      res.set('Cache-Control', 'no-store');
      res.json(await rt.poll(req.user.id, after, Math.min(25000, Math.max(0, Number(req.query.wait) || 20000))));
    },
    // GET /pvp/status — 페이지를 새로 열었을 때 진행 중인 판이 있는지
    async status(req, res) { res.set('Cache-Control', 'no-store'); res.json({ state: await pvp.stateOf(req.user.id) }); },
    async queue(req, res) {
      if (!queueOk(req.user.id)) return tooMany(res);
      { const cb = await customBlock(req.user.id); if (cb) return res.status(400).json(cb); }
      send(res, await pvp.queueJoin(req.user.id, (req.body || {}).mode, (req.body || {}).heroPower));   // v127 {mode:'normal'|'rank'}
    },
    async cancel(req, res) { send(res, await pvp.queueCancel(req.user.id)); },
    async mulligan(req, res) {
      if (!actionOk(req.user.id)) return tooMany(res);
      const b = req.body || {}; send(res, await pvp.mulligan(req.user.id, String(b.matchId || ''), b.ids));
    },
    async emote(req, res) {
      if (!actionOk(req.user.id)) return tooMany(res);
      const b = req.body || {}; send(res, await pvp.emote(req.user.id, String(b.matchId || ''), String(b.id || '')));
    },
    async invite(req, res) {
      if (!queueOk(req.user.id)) return tooMany(res);
      const b = req.body || {}, to = Number(b.to);
      if (!Number.isInteger(to) || !(await areFriends(req.user.id, to))) return res.status(400).json({ ok: false, error: '친구에게만 대전을 신청할 수 있어요.' });
      { const cb = await customBlock(req.user.id); if (cb) return res.status(400).json(cb); }
      send(res, await pvp.invite(req.user.id, to, b.heroPower));
    },
    async inviteRespond(req, res) {
      if (!queueOk(req.user.id)) return tooMany(res);
      const b = req.body || {}; if (b.accept) { const cb = await customBlock(req.user.id); if (cb) return res.status(400).json(cb); }
      send(res, await pvp.respond(req.user.id, String(b.id || ''), !!b.accept, b.heroPower));
    },
    async inviteCancel(req, res) { send(res, await pvp.inviteCancel(req.user.id)); },
    async spectate(req, res) {
      if (!queueOk(req.user.id)) return tooMany(res);
      const fid = Number((req.body || {}).friendId);
      if (!Number.isInteger(fid) || !(await areFriends(req.user.id, fid))) return res.status(400).json({ ok: false, error: '친구의 판만 관전할 수 있어요.' });
      send(res, await pvp.spectate(req.user.id, fid));
    },
    async spectateLeave(req, res) { res.json(await pvp.spectateLeave(req.user.id)); },
    // POST /pvp/action {matchId, seq, action}   (결과 화면은 실시간 통로로 온다. 여기서는 접수 여부만)
    async action(req, res) {
      if (!actionOk(req.user.id)) return tooMany(res);
      const b = req.body || {}; send(res, await pvp.action(req.user.id, String(b.matchId || ''), b.seq, b.action));
    },
  };
}

// Vercel 에서는 계속 도는 시계가 없다(tickMs 0) → 요청이 시계. 내 컴퓨터(npm start)에서는 PVP_TICK_MS 로 스스로 돈다
const core = createPvp({
  cfg: { introMs: PVP.INTRO_MS, tickMs: Number(process.env.PVP_TICK_MS) || 0 },
  store: dbStore(), publish: rt.publish,
  loadDeck: pvpdb.loadDeck, settle: pvpdb.settle, statsOf: pvpdb.statsOf, log: (...a) => console.log('[pvp]', ...a),
});
const h = makeHandlers(core);
const router = express.Router();
router.use('/pvp', requireAuth);
router.post('/pvp/hello', h.hello);
router.post('/pvp/ping', h.ping);
router.post('/pvp/bye', h.bye);
router.get('/pvp/poll', h.poll);
router.get('/pvp/status', h.status);
router.post('/pvp/emote', h.emote);
router.post('/pvp/queue', h.queue);
router.post('/pvp/cancel', h.cancel);
router.post('/pvp/mulligan', h.mulligan);
router.post('/pvp/action', h.action);
router.post('/pvp/invite', h.invite);
router.post('/pvp/invite/respond', h.inviteRespond);
router.post('/pvp/invite/cancel', h.inviteCancel);
router.post('/pvp/spectate', h.spectate);
router.post('/pvp/spectate/leave', h.spectateLeave);
// v137 리플레이: 내 지난 판 목록 · 하나 불러오기 (브라우저가 시드와 행동 목록으로 판을 다시 만들어 보여 준다)
router.get('/pvp/replays', async (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ list: await pvpdb.replayList(req.user.id) }); });
router.get('/pvp/replays/:id', async (req, res) => {
  const r = /^[0-9a-f]{1,32}$/.test(req.params.id) ? await pvpdb.replayGet(req.user.id, req.params.id) : null;
  if (!r) return res.status(404).json({ error: '리플레이가 없어요. (계정마다 최근 판만 보관해요)' });
  res.set('Cache-Control', 'private, max-age=3600'); res.json(r);
});
router.get('/pvp/ranking', async (req, res) => {   // v127 순위표 (v128 전체 순위 + 내 순위)
  res.set('Cache-Control', 'no-store');
  res.json({ ...(await pvpdb.ranking(100)), board: await pvpdb.publicBoard({ limit: 100 }), me: await pvpdb.rankOut(req.user.id), myRow: await pvpdb.myBoardRow(req.user.id) });
});
// v128 공개 순위 (로그인 없이): GET /api/public/ranking?offset=0&limit=50&q=이름
const publicRouter = express.Router();
const publicOk = makeBucket(60, 60000);
publicRouter.get('/public/ranking', async (req, res) => {
  const ip = req.ip || 'x'; if (!publicOk(ip)) return res.status(429).json({ error: '요청이 너무 많아요. 잠시 뒤 다시 해 주세요.' });
  res.set('Cache-Control', 'public, max-age=5');
  res.json(await pvpdb.publicBoard({ offset: req.query.offset, limit: req.query.limit, q: req.query.q }));
});

module.exports = { router, publicRouter, core, makeHandlers };
