// make-admin.js — 개발자(관리자) 권한 주기/빼기
//   node server/make-admin.js <아이디>          개발자로 지정
//   node server/make-admin.js <아이디> off      개발자 해제
// 개발자만 보스 덱 편집·테스트 메뉴를 볼 수 있고, 보스 목록을 서버에 저장할 수 있다. Supabase(DATABASE_URL)면 서버가 켜져 있어도 되고, 내 컴퓨터 DB(data/pglite)면 서버를 끄고 실행한다. 적용은 다시 로그인/새로고침하면 된다.
const db = require('./db');
const [, , username, off] = process.argv;
if (!username) { console.log('사용법: node server/make-admin.js <아이디> [off]'); process.exit(1); }
(async () => {
  const u = await db.prepare('SELECT id, username FROM users WHERE lower(username)=lower(?)').get(username);
  if (!u) { console.error('없는 아이디예요: ' + username); process.exit(1); }
  await db.prepare('UPDATE users SET is_admin=? WHERE id=?').run(off === 'off' ? 0 : 1, u.id);
  console.log(`${u.username}: 개발자 권한 ${off === 'off' ? '해제' : '부여'}`);
  await db.close();
})().catch(e => { console.error(e); process.exit(1); });
