// test-pvp-helper.js — 테스트용: 유저 대전 코어를 만들고, 서버가 보내는 메시지를 "가짜 탭"이 바로 받게 한다.
//   예전 테스트의 core.connect(uid, name, {send}) · core.disconnect(uid, conn) 모양을 그대로 쓸 수 있게 맞춰 준다.
const { createPvp } = require('./pvp-core');
const { memoryStore, dbStore } = require('./pvp-store');

let cidN = 0;
function mkCore(opts = {}) {
  const subs = new Map();                              // uid → Set<conn>
  const publish = list => { for (const { uid, msg } of list) for (const c of [...(subs.get(Number(uid)) || [])]) { if (c.cid && msg.t === 'replaced' && msg.cid !== c.cid) continue; c.send(JSON.parse(JSON.stringify(msg))); } };
  const core = createPvp({ store: opts.db ? dbStore() : memoryStore(), publish, ...opts });
  core.connect = async (uid, name, conn) => {
    conn.cid = conn.cid || ('c' + (++cidN));
    let s = subs.get(uid); if (!s) { s = new Set(); subs.set(uid, s); } s.add(conn);
    const r = await core.hello(uid, name, conn.cid);
    for (const m of r.msgs) conn.send(JSON.parse(JSON.stringify(m)));
    return r;
  };
  core.disconnect = async (uid, conn) => { const s = subs.get(uid); if (s) s.delete(conn); await core.bye(uid, conn.cid); };
  core.unsubscribe = (uid, conn) => { const s = subs.get(uid); if (s) s.delete(conn); };   // 메시지만 끊기 (서버는 아직 모름 — ping 이 끊긴 상황)
  return core;
}
module.exports = { mkCore };
