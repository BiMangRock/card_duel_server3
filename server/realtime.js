// realtime.js (server) — 서버 → 브라우저 실시간 메시지 (예전 웹소켓 대신)
//
//  Supabase 모드 (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SUPABASE_ANON_KEY 가 있을 때, Vercel 에서는 이것):
//   - 사용자마다 "채널 이름(topic)"이 하나 있다. 이름은 서버만 아는 비밀 값으로 만든 해시라 남의 채널 이름을 짐작할 수 없다.
//   - 서버는 Supabase Realtime 의 Broadcast REST API 로 그 채널에 메시지를 보낸다 (서버 키는 서버에만 있다).
//   - 브라우저는 /api/pvp/hello 로 자기 채널 이름과 공개 키(anon)를 받아 supabase-js 로 구독한다.
//
//  로컬 모드 (위 값이 없을 때 — 내 컴퓨터에서 npm start · 테스트):
//   - 서버 메모리에 사용자별 메시지를 잠깐 쌓아 두고, 브라우저가 /api/pvp/poll 로 가져간다 (롱 폴링).
//   - 서버가 한 대일 때만 맞다. Vercel 에서는 반드시 Supabase 값을 넣어야 한다.
require('./env');
const crypto = require('crypto');

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const SB_ANON = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '';
const MODE = SB_URL && SB_SERVICE && SB_ANON ? 'supabase' : 'local';
const SECRET = process.env.REALTIME_SECRET || (SB_SERVICE ? crypto.createHash('sha256').update('cd-rt:' + SB_SERVICE).digest('hex') : crypto.randomBytes(16).toString('hex'));

const topicOf = uid => 'cd-' + crypto.createHmac('sha256', SECRET).update(String(uid)).digest('base64url').slice(0, 24);

// ---------- Supabase ----------
const MAX_BATCH_BYTES = 200 * 1024;       // 한 번에 보내는 양 (넘으면 나눠 보낸다)
async function sbPost(messages) {
  const r = await fetch(SB_URL + '/realtime/v1/api/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SB_SERVICE, ...(SB_SERVICE.startsWith('eyJ') ? { Authorization: 'Bearer ' + SB_SERVICE } : {}) },   // 새 형식 키(sb_secret_…)는 apikey 만
    body: JSON.stringify({ messages }),
  });
  if (!r.ok) throw new Error('Supabase broadcast ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 200));
}
async function sbPublish(list) {
  let batch = [], size = 0;
  for (const { uid, msg } of list) {
    const m = { topic: topicOf(uid), event: 'm', payload: msg, private: false };
    const n = JSON.stringify(m).length;
    if (batch.length && size + n > MAX_BATCH_BYTES) { await sbPost(batch); batch = []; size = 0; }
    batch.push(m); size += n;
  }
  if (batch.length) await sbPost(batch);
}

// ---------- 로컬 (메모리 + 롱 폴링) ----------
const KEEP = 300, KEEP_MS = 5 * 60 * 1000;
const boxes = new Map();                 // uid → { seq, list:[{id, at, msg}], waiters:Set<fn> }
const listeners = new Map();             // uid → Set<fn(msg)>  (테스트가 바로 받아 보는 용도)
const boxOf = uid => { let b = boxes.get(uid); if (!b) { b = { seq: 0, list: [], waiters: new Set() }; boxes.set(uid, b); } return b; };
function localPublish(list) {
  const now = Date.now();
  for (const { uid, msg } of list) {
    const b = boxOf(uid), m = JSON.parse(JSON.stringify(msg));
    b.list.push({ id: ++b.seq, at: now, msg: m });
    while (b.list.length > KEEP || (b.list.length && now - b.list[0].at > KEEP_MS)) b.list.shift();
    for (const w of [...b.waiters]) w();
    for (const f of listeners.get(uid) || []) { try { f(JSON.parse(JSON.stringify(msg))); } catch (_) {} }
  }
}
// after 보다 뒤의 메시지. 없으면 waitMs 동안 기다린다
async function poll(uid, after, waitMs = 20000) {
  const b = boxOf(uid);
  const take = () => b.list.filter(x => x.id > after).map(x => ({ id: x.id, msg: x.msg }));
  let got = take();
  if (got.length || waitMs <= 0) return { last: b.seq, msgs: got };
  await new Promise(res => { const w = () => { clearTimeout(t); b.waiters.delete(w); res(); }; const t = setTimeout(w, waitMs); b.waiters.add(w); });
  got = take();
  return { last: b.seq, msgs: got };
}
const lastId = uid => boxOf(uid).seq;
function listen(uid, fn) { let s = listeners.get(uid); if (!s) { s = new Set(); listeners.set(uid, s); } s.add(fn); return () => s.delete(fn); }

// ---------- 공통 ----------
async function publish(list) {
  if (!list || !list.length) return;
  if (MODE === 'supabase') return sbPublish(list);
  localPublish(list);
}
// 브라우저에 알려 줄 접속 정보
function clientInfo(uid) {
  return MODE === 'supabase' ? { mode: 'supabase', url: SB_URL, key: SB_ANON, topic: topicOf(uid) } : { mode: 'poll', after: lastId(uid) };
}

module.exports = { MODE, publish, clientInfo, topicOf, poll, listen, lastId };
