// pvp-store.js (server) — 유저 대전 world(대기열·판·접속 상태)를 어디에 둘지.
//   store.run(async world => …)  : world 를 잠그고 꺼내 fn 에 넘긴 뒤, fn 이 고친 world 를 저장한다. 동시에 온 요청은 차례로.
//
//   dbStore()     : PostgreSQL 의 pvp_world 테이블 한 줄 (Vercel — 서버가 여러 대·요청마다 새로 떠도 같은 world 를 본다)
//                   잠금은 pg_advisory_xact_lock. fn 안에서 하는 DB 일(정산 등)도 같은 트랜잭션이라, 저장이 실패하면 같이 취소된다.
//   memoryStore() : 메모리 (테스트용). 그래도 매번 JSON 으로 바꿨다 되돌려서 "저장할 수 없는 값"이 섞이면 테스트에서 바로 드러나게 한다.
const db = require('./db');
const { emptyWorld } = require('./pvp-core');

const WORLD_ID = 1;
const LOCK = 'pvp_world';

function fixWorld(w) {
  const e = emptyWorld();
  if (!w || typeof w !== 'object') return e;
  return { users: w.users || e.users, matches: w.matches || e.matches, queue: Array.isArray(w.queue) ? w.queue : e.queue, invites: w.invites || e.invites };
}

function dbStore() {
  return {
    async run(fn) {
      return db.tx(async () => {
        const row = await db.prepare('SELECT data FROM pvp_world WHERE id=?').get(WORLD_ID);
        let W; try { W = fixWorld(row ? JSON.parse(row.data) : null); } catch (_) { W = emptyWorld(); }
        const before = row ? row.data : null;
        const out = await fn(W);
        const after = JSON.stringify(W);
        if (after !== before) {
          await db.prepare(`INSERT INTO pvp_world(id,data,updated_at) VALUES (?,?,?)
                            ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`).run(WORLD_ID, after, Date.now());
        }
        return out;
      }, { lock: LOCK });
    },
    async peek() { const row = await db.prepare('SELECT data FROM pvp_world WHERE id=?').get(WORLD_ID); return fixWorld(row ? JSON.parse(row.data) : null); },
  };
}

function memoryStore() {
  let data = JSON.stringify(emptyWorld()), chain = Promise.resolve();
  return {
    run(fn) {
      const p = chain.then(async () => {
        const W = fixWorld(JSON.parse(data));
        const out = await fn(W);
        data = JSON.stringify(W);
        return out;
      });
      chain = p.catch(() => {});
      return p;
    },
    async peek() { return JSON.parse(data); },
  };
}

module.exports = { dbStore, memoryStore };
