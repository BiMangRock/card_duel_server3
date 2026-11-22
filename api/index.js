// api/index.js — Vercel 함수 입구. express 앱을 그대로 내보낸다 (vercel.json 이 /api/* · / · /ranking 을 여기로 보낸다)
module.exports = require('../server/app');
