// friends-db.js (server) — v136 닉네임 · 친구 · 친구 요청의 DB 쪽. express·SSE 와 무관 (social.js · pvp.js 가 쓴다)
const db = require('./db');

const FRIENDS = {
  MAX_FRIENDS: 100,             // 한 계정의 친구 수 상한
  MAX_PENDING: 30,              // 아직 답을 못 받은 "보낸 요청" 상한
};
// 닉네임: 2~12자, 한글·영문·숫자·밑줄
const NICK_RE = /^[A-Za-z0-9_가-힣]{2,12}$/;

const displayName = u => (u && (u.nickname || u.username)) || '';
const userRow = id => db.prepare('SELECT id, username, nickname FROM users WHERE id=?').get(id);
const publicUser = u => ({ id: u.id, username: u.username, nickname: u.nickname || null, name: displayName(u) });

// 아이디 또는 닉네임으로 찾기 (대소문자 구분 없음). 닉네임이 남의 아이디와 겹치지 않게 막아 두었으므로 한 명만 나온다
async function findUser(q) {
  q = String(q || '').trim();
  if (!q || q.length > 16) return null;
  return await db.prepare('SELECT id, username, nickname FROM users WHERE lower(username)=lower(?)').get(q)
      || await db.prepare('SELECT id, username, nickname FROM users WHERE lower(nickname)=lower(?)').get(q) || null;
}

// ---------- 닉네임 ----------
async function checkNickname(uid, nick) {
  if (typeof nick !== 'string' || !NICK_RE.test(nick)) return '닉네임은 2~12자의 한글·영문·숫자·밑줄(_)만 쓸 수 있어요.';
  const taken = await db.prepare('SELECT id FROM users WHERE lower(nickname)=lower(?) AND id!=?').get(nick, uid);
  if (taken) return '이미 다른 사람이 쓰는 닉네임이에요.';
  const asId = await db.prepare('SELECT id FROM users WHERE lower(username)=lower(?) AND id!=?').get(nick, uid);
  if (asId) return '다른 사람의 아이디와 같은 닉네임은 쓸 수 없어요.';
  return null;
}
// v141 닉네임은 한 번 정하면 바꿀 수 없다 (회원가입 때 정한다. 닉네임 없이 만든 옛 계정만 한 번 정할 수 있다)
//  반환: {ok, error?, nickname}
async function setNickname(uid, nick) {
  const cur = await userRow(uid);
  if (!cur) return { ok: false, error: '없는 사용자예요.' };
  if (cur.nickname) return { ok: false, error: '닉네임은 한 번 정하면 바꿀 수 없어요.', locked: true };
  nick = typeof nick === 'string' ? nick.trim() : nick;
  const bad = await checkNickname(uid, nick);
  if (bad) return { ok: false, error: bad };
  let r;
  try { r = await db.prepare('UPDATE users SET nickname=? WHERE id=? AND nickname IS NULL').run(nick, uid); }
  catch (e) {                                                       // 동시에 같은 닉네임을 정한 경우 (UNIQUE 인덱스가 막는다)
    if (db.isUnique(e)) return { ok: false, error: '이미 다른 사람이 쓰는 닉네임이에요.' };
    throw e;
  }
  if (!r.changes) return { ok: false, error: '닉네임은 한 번 정하면 바꿀 수 없어요.', locked: true };
  return { ok: true, nickname: nick };
}
// 가입할 아이디가 남의 닉네임과 같은지 (auth.js 가 쓴다)
const nicknameTaken = async name => !!(await db.prepare('SELECT 1 FROM users WHERE lower(nickname)=lower(?)').get(String(name)));

// ---------- 친구 ----------
const areFriends = async (a, b) => !!(await db.prepare('SELECT 1 FROM friends WHERE user_id=? AND friend_id=?').get(a, b));
const friendIds = async uid => (await db.prepare('SELECT friend_id AS id FROM friends WHERE user_id=?').all(uid)).map(r => r.id);
const friendCount = async uid => (await db.prepare('SELECT COUNT(*) AS n FROM friends WHERE user_id=?').get(uid)).n;
const hasRequest = async (from, to) => !!(await db.prepare('SELECT 1 FROM friend_requests WHERE from_id=? AND to_id=?').get(from, to));

async function makeFriends(a, b, now = Date.now()) {
  await db.tx(async () => {
    await db.prepare('INSERT INTO friends(user_id,friend_id,since) VALUES (?,?,?) ON CONFLICT DO NOTHING').run(a, b, now);
    await db.prepare('INSERT INTO friends(user_id,friend_id,since) VALUES (?,?,?) ON CONFLICT DO NOTHING').run(b, a, now);
    await db.prepare('DELETE FROM friend_requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)').run(a, b, b, a);
  });
}

// 친구 요청 보내기. 상대가 이미 나에게 요청했으면 바로 친구가 된다.
// 반환: {ok, error?, status:'sent'|'accepted', user}
async function sendRequest(uid, q) {
  const t = await findUser(q);
  if (!t) return { ok: false, error: '그런 아이디·닉네임의 사람이 없어요.' };
  if (t.id === uid) return { ok: false, error: '나 자신에게는 친구 요청을 보낼 수 없어요.' };
  const user = publicUser(t);
  if (await areFriends(uid, t.id)) return { ok: false, error: '이미 친구예요.', user };
  if (await hasRequest(t.id, uid)) {                                 // 서로 보냄 → 수락으로 처리
    if (await friendCount(uid) >= FRIENDS.MAX_FRIENDS) return { ok: false, error: `친구는 ${FRIENDS.MAX_FRIENDS}명까지예요.` };
    if (await friendCount(t.id) >= FRIENDS.MAX_FRIENDS) return { ok: false, error: '상대의 친구 목록이 가득 찼어요.' };
    await makeFriends(uid, t.id); return { ok: true, status: 'accepted', user };
  }
  if (await hasRequest(uid, t.id)) return { ok: false, error: '이미 요청을 보냈어요. 상대가 수락하기를 기다려 주세요.', user };
  if (await friendCount(uid) >= FRIENDS.MAX_FRIENDS) return { ok: false, error: `친구는 ${FRIENDS.MAX_FRIENDS}명까지예요.` };
  const pending = (await db.prepare('SELECT COUNT(*) AS n FROM friend_requests WHERE from_id=?').get(uid)).n;
  if (pending >= FRIENDS.MAX_PENDING) return { ok: false, error: `답을 기다리는 요청이 너무 많아요 (최대 ${FRIENDS.MAX_PENDING}개). 보낸 요청을 정리해 주세요.` };
  await db.prepare('INSERT INTO friend_requests(from_id,to_id,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING').run(uid, t.id, Date.now());
  return { ok: true, status: 'sent', user };
}
// 받은 요청에 답하기 (accept=true 수락 / false 거절)
async function answerRequest(uid, fromId, accept) {
  if (!(await hasRequest(fromId, uid))) return { ok: false, error: '이미 처리됐거나 없는 요청이에요.' };
  const u = await userRow(fromId); if (!u) return { ok: false, error: '없는 사용자예요.' };
  if (!accept) { await db.prepare('DELETE FROM friend_requests WHERE from_id=? AND to_id=?').run(fromId, uid); return { ok: true, status: 'declined', user: publicUser(u) }; }
  if (await friendCount(uid) >= FRIENDS.MAX_FRIENDS) return { ok: false, error: `친구는 ${FRIENDS.MAX_FRIENDS}명까지예요.` };
  if (await friendCount(fromId) >= FRIENDS.MAX_FRIENDS) return { ok: false, error: '상대의 친구 목록이 가득 찼어요.' };
  await makeFriends(uid, fromId);
  return { ok: true, status: 'accepted', user: publicUser(u) };
}
async function cancelRequest(uid, toId) {
  const r = await db.prepare('DELETE FROM friend_requests WHERE from_id=? AND to_id=?').run(uid, toId);
  return r.changes ? { ok: true } : { ok: false, error: '이미 처리됐거나 없는 요청이에요.' };
}
async function removeFriend(uid, fid) {
  const r = await db.prepare('DELETE FROM friends WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)').run(uid, fid, fid, uid);
  if (r.changes) await db.prepare('DELETE FROM friend_messages WHERE pair_key=?').run(pairKey(uid, fid));   // v141 친구를 끊으면 대화도 지운다
  return r.changes ? { ok: true } : { ok: false, error: '친구가 아니에요.' };
}

// ---------- v141 친구 채팅 ----------
const CHAT = {
  MAX_LEN: 300,                 // 메시지 한 개 최대 글자 수
  KEEP: 300,                    // 두 사람 사이에 남겨 두는 최근 메시지 수
  PAGE: 50,                     // 한 번에 불러오는 메시지 수
};
const pairKey = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;
const msgOut = m => ({ id: m.id, from: m.from_id, to: m.to_id, text: m.body, at: m.created_at, read: m.read_at != null });
// 줄바꿈은 살리고 나머지 제어 문자는 지운다. 앞뒤 공백 제거
function cleanText(t) {
  if (typeof t !== 'string') return '';
  return t.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}
async function sendChat(uid, to, text) {
  if (!Number.isInteger(to)) return { ok: false, error: '잘못된 요청이에요.' };
  if (!(await areFriends(uid, to))) return { ok: false, error: '친구에게만 메시지를 보낼 수 있어요.' };
  text = cleanText(text);
  if (!text) return { ok: false, error: '메시지를 입력해 주세요.' };
  if ([...text].length > CHAT.MAX_LEN) return { ok: false, error: `메시지는 ${CHAT.MAX_LEN}자까지예요.` };
  const key = pairKey(uid, to), now = Date.now();
  const id = Number((await db.prepare('INSERT INTO friend_messages(pair_key,from_id,to_id,body,created_at) VALUES (?,?,?,?,?) RETURNING id').get(key, uid, to, text, now)).id);
  const cut = await db.prepare('SELECT id FROM friend_messages WHERE pair_key=? ORDER BY id DESC LIMIT 1 OFFSET ?').get(key, CHAT.KEEP);
  if (cut) await db.prepare('DELETE FROM friend_messages WHERE pair_key=? AND id<=?').run(key, cut.id);
  return { ok: true, msg: { id, from: uid, to, text, at: now, read: false } };
}
// 대화 불러오기 (최근 것부터 PAGE 개, before 를 주면 그보다 옛날 것). 오래된 것이 앞에 오게 돌려준다
async function chatHistory(uid, fid, before) {
  if (!(await areFriends(uid, fid))) return { ok: false, error: '친구가 아니에요.' };
  const key = pairKey(uid, fid);
  const rows = Number.isInteger(before) && before > 0
    ? await db.prepare('SELECT * FROM friend_messages WHERE pair_key=? AND id<? ORDER BY id DESC LIMIT ?').all(key, before, CHAT.PAGE + 1)
    : await db.prepare('SELECT * FROM friend_messages WHERE pair_key=? ORDER BY id DESC LIMIT ?').all(key, CHAT.PAGE + 1);
  const more = rows.length > CHAT.PAGE;
  return { ok: true, messages: rows.slice(0, CHAT.PAGE).reverse().map(msgOut), more };
}
// fid 가 나에게 보낸 메시지를 upTo(포함)까지 읽음으로. 반환: 읽음 처리한 개수
async function markRead(uid, fid, upTo) {
  const lim = Number.isInteger(upTo) && upTo > 0 ? upTo : 2147483647;   // id 는 INTEGER
  return (await db.prepare('UPDATE friend_messages SET read_at=? WHERE to_id=? AND from_id=? AND read_at IS NULL AND id<=?').run(Date.now(), uid, fid, lim)).changes;
}
// 친구별 안 읽은 메시지 수 {친구id: n}
async function unreadCounts(uid) {
  const out = {};
  for (const r of await db.prepare('SELECT from_id, COUNT(*) AS n FROM friend_messages WHERE to_id=? AND read_at IS NULL GROUP BY from_id').all(uid)) out[r.from_id] = r.n;
  return out;
}

// 화면용 목록: 친구 · 받은 요청 · 보낸 요청
async function listOf(uid) {
  const unread = await unreadCounts(uid);
  const friends = (await db.prepare(`SELECT u.id, u.username, u.nickname, f.since FROM friends f JOIN users u ON u.id=f.friend_id WHERE f.user_id=?`).all(uid))
    .map(u => ({ ...publicUser(u), since: u.since, unread: unread[u.id] || 0 }));
  const incoming = (await db.prepare(`SELECT u.id, u.username, u.nickname, r.created_at AS at FROM friend_requests r JOIN users u ON u.id=r.from_id WHERE r.to_id=? ORDER BY r.created_at DESC`).all(uid))
    .map(u => ({ ...publicUser(u), at: u.at }));
  const outgoing = (await db.prepare(`SELECT u.id, u.username, u.nickname, r.created_at AS at FROM friend_requests r JOIN users u ON u.id=r.to_id WHERE r.from_id=? ORDER BY r.created_at DESC`).all(uid))
    .map(u => ({ ...publicUser(u), at: u.at }));
  return { friends, incoming, outgoing };
}

module.exports = { FRIENDS, NICK_RE, displayName, userRow, publicUser, findUser, checkNickname, setNickname, nicknameTaken,
  areFriends, friendIds, sendRequest, answerRequest, cancelRequest, removeFriend, listOf,
  CHAT, cleanText, sendChat, chatHistory, markRead, unreadCounts };
