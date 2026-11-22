// seed-samples.js — 샘플 계정 sample1 ~ sample20 을 만든다 (모든 카드 2장씩 보유 + 시작 골드).
//   npm run seed                 → 기본: 20개, 비밀번호 11111111, 골드 1000
//   node server/seed-samples.js [개수=20] [비밀번호=11111111] [골드=1000]
// 이미 있는 계정은 비밀번호·골드는 그대로 두고, 카드만 전부 갖게 다시 맞춥니다 (여러 번 실행해도 안전).
// ⚠ 비밀번호가 다 같고 공개돼 있으니, 인터넷에 공개하는 서버에서는 쓰지 마세요 (친구들과 로컬/테스트용).
// Supabase(DATABASE_URL)면 서버가 켜져 있어도 됩니다. 내 컴퓨터 DB(data/pglite)면 서버를 끄고 실행하세요.
const db = require('./db');
const { hashPassword } = require('./auth');
const { ensureWallet } = require('./saves');
const { ensureCollection, ensureAtLeast, CARD_POOL } = require('./collection');

const COUNT = Number(process.argv[2] || 20), PASSWORD = process.argv[3] || '11111111', GOLD = Number(process.argv[4] ?? 1000);
if (!Number.isInteger(COUNT) || COUNT < 1 || COUNT > 200) { console.error('개수는 1~200 사이 정수여야 해요.'); process.exit(1); }
if (PASSWORD.length < 8) { console.error('비밀번호는 8자 이상이어야 해요.'); process.exit(1); }
if (!Number.isInteger(GOLD) || GOLD < 0) { console.error('골드는 0 이상 정수여야 해요.'); process.exit(1); }

(async () => {
  const pwHash = await hashPassword(PASSWORD);
  let created = 0;
  for (let i = 1; i <= COUNT; i++) {
    const name = 'sample' + i;
    let u = await db.prepare('SELECT id FROM users WHERE lower(username)=lower(?)').get(name);
    if (!u) {
      const id = (await db.prepare('INSERT INTO users(username,pw_hash,created_at) VALUES (?,?,?) RETURNING id').get(name, pwHash, Date.now())).id;
      u = { id: Number(id) }; created++;
      await ensureWallet(u.id); await db.prepare('UPDATE wallets SET gold=? WHERE user_id=?').run(GOLD, u.id);
    }
    await ensureCollection(u.id);
    await db.prepare(`INSERT INTO collection(user_id,card_name,count) SELECT ?::int, n, 2 FROM unnest(?::text[]) AS t(n)
                      ON CONFLICT(user_id,card_name) DO UPDATE SET count=GREATEST(collection.count, 2)`).run(u.id, CARD_POOL.map(c => c.name));   // 모든 카드 2장 (한 번에)
  }
  console.log(`sample1 ~ sample${COUNT}: 새로 만든 계정 ${created}개, 나머지는 카드만 보충. 비밀번호 ${PASSWORD} · 새 계정 골드 ${GOLD} · 모든 카드 ${CARD_POOL.length}종 2장씩`);
  await db.close();
})().catch(e => { console.error(e); process.exit(1); });
