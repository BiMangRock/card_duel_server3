// index.js — 내 컴퓨터에서 켜는 서버 시작점
//   npm start  →  http://localhost:3000
//   DB: DATABASE_URL 이 있으면 그 PostgreSQL(Supabase), 없으면 data/pglite 폴더 (설치 없이 바로)
//   실시간: SUPABASE_* 값이 있으면 Supabase Realtime, 없으면 롱 폴링 (서버 한 대라 괜찮다)
const fs = require('fs');
const path = require('path');
if (!process.env.PVP_TICK_MS) process.env.PVP_TICK_MS = '1000';    // 계속 켜져 있는 서버이므로 유저 대전 시계를 스스로 돌린다
const app = require('./app');
const db = require('./db');
const pvp = require('./pvp');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';            // 같은 와이파이의 다른 기기에서 접속하려면 HOST=0.0.0.0
const IMAGES = path.join(__dirname, '..', 'images');

db.init().then(() => {
  const server = app.listen(PORT, HOST, () => {
    console.log(`카드 결투 서버: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (DB: ${db.kind()}, 실시간: ${require('./realtime').MODE})`);
    if (!fs.existsSync(IMAGES)) console.warn('⚠ images/ 폴더가 없어요. 기존 프로젝트의 images 폴더를 이 폴더(프로젝트 루트)에 복사해 주세요.');
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { pvp.core.shutdown(); } catch (_) {} server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); });
}).catch(e => { console.error('DB 연결 실패:', e && e.message); process.exit(1); });
