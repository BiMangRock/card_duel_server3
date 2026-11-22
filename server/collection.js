// collection.js (server) — 내 카드 컬렉션 DB 도우미. express 와 무관해서 grant.js 같은 도구에서도 쓴다.
const path = require('path');
const db = require('./db');
const JS = path.join(__dirname, '..', 'public', 'js');
const { CARD_POOL, defaultDeckList } = require(path.join(JS, 'engine.js'));
const Col = require(path.join(JS, 'collection.js'));

// 스타터 카드를 아직 못 받은 계정이면 지급한다 (가입 직후 / 3단계까지 쓰던 기존 계정의 첫 접속 때). 한 번만.
async function ensureCollection(uid) {
  if (await db.prepare('SELECT 1 FROM collection_init WHERE user_id=?').get(uid)) return;
  const starter = Col.starterCollection(CARD_POOL, defaultDeckList());
  await db.tx(async () => {
    if (await db.prepare('SELECT 1 FROM collection_init WHERE user_id=?').get(uid)) return;   // 잠근 뒤 다시 확인 (동시에 두 번 들어온 경우)
    const E = Object.entries(starter);                                                          // 한 번에 넣는다 (DB 왕복 1번)
    if (E.length) await db.prepare('INSERT INTO collection(user_id,card_name,count) SELECT ?::int, n, c FROM unnest(?::text[], ?::int[]) AS t(n, c) ON CONFLICT DO NOTHING')
      .run(uid, E.map(e => e[0]), E.map(e => e[1]));
    await db.prepare('INSERT INTO collection_init(user_id,granted_at) VALUES (?,?) ON CONFLICT DO NOTHING').run(uid, Date.now());
  }, { lock: uid });
}
async function collectionOf(uid) {
  const out = {};
  for (const r of await db.prepare('SELECT card_name,count FROM collection WHERE user_id=?').all(uid)) out[r.card_name] = r.count;
  return out;
}
// 카드를 "최소 n장" 갖게 한다 (이미 그 이상이면 그대로). 팩 개봉(5단계)에서도 이 자리에 +n 로직이 붙는다.
async function ensureAtLeast(uid, cardName, n) {
  await db.prepare(`INSERT INTO collection(user_id,card_name,count) VALUES (?,?,?)
              ON CONFLICT(user_id,card_name) DO UPDATE SET count=GREATEST(collection.count, excluded.count)`).run(uid, cardName, n);
}
module.exports = { ensureCollection, collectionOf, ensureAtLeast, CARD_POOL, RARITY_ORDER: Col.RARITY_ORDER };
