// db.js — PostgreSQL 연결 (Supabase). 예전 SQLite(node:sqlite) 코드와 비슷하게 쓸 수 있게 감싼다.
//
//   await db.prepare('SELECT * FROM users WHERE id=?').get(id)    → 첫 줄 (없으면 undefined)
//   await db.prepare('SELECT …').all(a, b)                         → 줄 배열
//   await db.prepare('UPDATE …').run(a, b)                         → { changes }   (INSERT … RETURNING id 는 .get() 으로)
//   await db.exec('여러 문장;')                                     → 결과 없음
//   await db.tx(async () => { … })                                 → 트랜잭션. 안에서 부르는 db.* 는 전부 같은 연결을 쓴다
//   await db.tx(async () => { … }, { lock: uid })                   → 같은 lock 번호끼리는 한 번에 하나씩 (예전 BEGIN IMMEDIATE 대신)
//
//  '?' 자리는 PostgreSQL 의 $1, $2 … 로 바꿔서 보낸다 (작은따옴표 안의 ? 는 그대로).
//
//  어디에 붙나:
//   - DATABASE_URL 이 있으면 그 PostgreSQL (Supabase 의 "Transaction pooler" 주소 권장, Vercel 에서 쓸 때)
//   - 없으면 PGlite (PostgreSQL 을 Node 안에서 돌리는 것). 내 컴퓨터에서 바로 켜 볼 때 · 테스트용
//       DB_PATH=':memory:' → 메모리 (테스트) / 아니면 data/pglite 폴더에 저장
require('./env');
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();            // 지금 트랜잭션 중이면 그 연결
const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

// ---------- '?' → $n ----------
const sqlCache = new Map();
function toPg(sql) {
  let out = sqlCache.get(sql);
  if (out) return out;
  let n = 0, q = false; out = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") q = !q;
    out += (ch === '?' && !q) ? '$' + (++n) : ch;
  }
  if (sqlCache.size < 2000) sqlCache.set(sql, out);
  return out;
}
// PGlite 는 bytea 를 Uint8Array 로 준다 → express 가 그대로 보낼 수 있게 Buffer 로
function fixRows(rows) {
  for (const r of rows) for (const k in r) { const v = r[k]; if (v instanceof Uint8Array && !Buffer.isBuffer(v)) r[k] = Buffer.from(v.buffer, v.byteOffset, v.byteLength); }
  return rows;
}
const toParam = v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v;

// ---------- 드라이버 ----------
//  driver.query(sql, params) → {rows, rowCount}    driver.begin() → {query, end(ok)}
function pgDriver(url) {
  const pg = require('pg');
  pg.types.setTypeParser(20, v => (v === null ? null : Number(v)));     // BIGINT·COUNT(*) → 숫자 (epoch ms 는 안전한 정수 범위)
  pg.types.setTypeParser(1700, v => (v === null ? null : Number(v)));   // NUMERIC → 숫자
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX) || 5,
    idleTimeoutMillis: 10000,
    ssl: /localhost|127\.0\.0\.1/.test(url) || process.env.DB_SSL === '0' ? false : { rejectUnauthorized: false },
  });
  pool.on('error', e => console.error('[db] 연결 오류', e && e.message));
  return {
    kind: 'pg',
    query: (sql, params) => pool.query(sql, params),
    async begin() {
      const c = await pool.connect();
      try { await c.query('BEGIN'); } catch (e) { c.release(true); throw e; }
      return { query: (sql, params) => c.query(sql, params), async end(ok) { try { await c.query(ok ? 'COMMIT' : 'ROLLBACK'); c.release(); } catch (e) { c.release(true); if (ok) throw e; } } };
    },
    close: () => pool.end(),
  };
}
function pgliteDriver(where) {
  // PGlite 는 연결이 하나뿐이다 → 트랜잭션이 열려 있는 동안 다른 요청의 쿼리가 끼어들지 않게 차례를 지킨다
  let ready = null, chain = Promise.resolve();
  const open = () => ready || (ready = (async () => {
    const mod = '@electric-sql/pglite';                     // 변수로 불러서 Vercel 함수 묶음에는 안 들어가게 (Vercel 에서는 DATABASE_URL 을 쓴다)
    const { PGlite } = await import(mod);
    if (where !== 'memory://') fs.mkdirSync(where, { recursive: true });
    const pg = new PGlite(where === 'memory://' ? undefined : where, { parsers: { 20: Number, 1700: Number } });
    await pg.waitReady;
    return pg;
  })());
  const lock = () => { let release; const p = new Promise(r => { release = r; }); const prev = chain; chain = chain.then(() => p); return prev.then(() => release); };
  const run = async (pg, sql, params) => { const r = await pg.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; };
  return {
    kind: 'pglite',
    async query(sql, params) { const pg = await open(); const release = await lock(); try { return await run(pg, sql, params); } finally { release(); } },
    async exec(sql) { const pg = await open(); const release = await lock(); try { await pg.exec(sql); } finally { release(); } },
    async begin() {
      const pg = await open(); const release = await lock();
      try { await pg.query('BEGIN'); } catch (e) { release(); throw e; }
      return { query: (sql, params) => run(pg, sql, params), async end(ok) { try { await pg.query(ok ? 'COMMIT' : 'ROLLBACK'); } finally { release(); } } };
    },
    close: async () => { if (ready) { const pg = await ready; await pg.close(); } },
  };
}

let driver = null;
function getDriver() {
  if (driver) return driver;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (url) driver = pgDriver(url);
  else if (process.env.VERCEL) throw new Error('DATABASE_URL 이 없어요. Vercel 프로젝트 설정 → Environment Variables 에 Supabase 주소를 넣어 주세요.');
  else {
    const p = process.env.DB_PATH;
    driver = pgliteDriver(p === ':memory:' ? 'memory://' : (p || path.join(__dirname, '..', 'data', 'pglite')));
  }
  return driver;
}

// ---------- 테이블 만들기 (서버가 처음 쿼리할 때 한 번) ----------
let initP = null;
function init() {
  if (!initP) initP = (async () => {
    const d = getDriver();
    if (process.env.DB_SKIP_SCHEMA === '1') return;
    if (d.exec) await d.exec(SCHEMA);
    else {
      // 서버 여러 대가 동시에 켜져도 한 대만 만들게 잠근다
      const t = await d.begin(); let ok = false;
      try { await t.query('SELECT pg_advisory_xact_lock(7340001)'); await t.query(SCHEMA); ok = true; } finally { await t.end(ok); }
    }
  })().catch(e => { initP = null; throw e; });
  return initP;
}

async function query(sql, params) {
  const t = als.getStore();
  if (t) return t.query(toPg(sql), params.map(toParam));
  await init();
  return getDriver().query(toPg(sql), params.map(toParam));
}

function prepare(sql) {
  return {
    async get(...a) { const r = await query(sql, a); return r.rows.length ? fixRows(r.rows)[0] : undefined; },
    async all(...a) { const r = await query(sql, a); return fixRows(r.rows); },
    async run(...a) { const r = await query(sql, a); return { changes: r.rowCount || 0, rows: r.rows }; },
  };
}
async function exec(sql) {
  const t = als.getStore();
  if (t) { await t.query(sql, []); return; }
  await init();
  const d = getDriver();
  if (d.exec) await d.exec(sql); else await d.query(sql, []);
}

// 트랜잭션. 이미 트랜잭션 안이면 SAVEPOINT 로 이어서 쓴다
//  → 안쪽 db.tx 가 에러를 던지면 안쪽에서 한 일만 취소되고, 바깥은 try/catch 로 받아서 계속할 수 있다
//    (PostgreSQL 은 트랜잭션 안에서 에러가 한 번 나면 ROLLBACK 전까지 다른 쿼리를 모두 거부하기 때문)
let spN = 0;
async function tx(fn, opts = {}) {
  const cur = als.getStore();
  if (cur) {
    const sp = 'sp' + (++spN);
    await cur.query('SAVEPOINT ' + sp, []);
    try {
      if (opts.lock != null) await cur.query('SELECT pg_advisory_xact_lock($1)', [lockKey(opts.lock)]);
      const out = await fn();
      await cur.query('RELEASE SAVEPOINT ' + sp, []);
      return out;
    } catch (e) { try { await cur.query('ROLLBACK TO SAVEPOINT ' + sp, []); } catch (_) {} throw e; }
  }
  await init();
  const t = await getDriver().begin();
  let ok = false;
  try {
    if (opts.lock != null) await t.query('SELECT pg_advisory_xact_lock($1)', [lockKey(opts.lock)]);
    const out = await als.run(t, fn);
    ok = true;
    return out;
  } finally { await t.end(ok); }
}
// 잠금 번호: 숫자(user id)는 그대로, 글자는 해시
function lockKey(k) {
  if (Number.isInteger(k)) return k;
  let h = 0; for (const ch of String(k)) h = (h * 31 + ch.codePointAt(0)) | 0;
  return 1000000000 + Math.abs(h % 1000000000);
}

// UNIQUE 제약에 걸렸는지 (동시에 같은 아이디로 가입 등)
const isUnique = e => !!e && (e.code === '23505' || /unique constraint|duplicate key/i.test(String(e.message)));

module.exports = { prepare, exec, tx, init, isUnique, kind: () => getDriver().kind, close: async () => { if (driver) await driver.close(); driver = null; initP = null; } };
