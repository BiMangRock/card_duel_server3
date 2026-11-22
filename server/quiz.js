// quiz.js (server, v168) — 수능 컷신 기출 문제: 계정별 출제 기록
//  - GET  /api/quiz/seen          → { seen: { 문항id: 나온 횟수 } }   (이 계정에서 지금까지 나온 문제)
//  - POST /api/quiz/seen {ids:[]} → 나온 문제를 기록 (횟수 +1, 마지막 시각)
//  문제를 고르는 일은 화면(suneung.js)이 한다: 안 나온 문제 중 무작위 → 다 나왔으면 전체에서 무작위
//  문항 id 는 public/data/gichul.json 에 있는 것만 받는다
const path = require('path');
const fs = require('fs');
const express = require('express');
const db = require('./db');
const { requireAuth } = require('./auth');

// 테이블은 schema.sql (quiz_seen)

let IDS = null;
function knownIds() {
  if (IDS) return IDS;
  try { IDS = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'gichul.json'), 'utf8')).map(q => q.id)); }
  catch (_) { IDS = new Set(); }
  return IDS;
}

const router = express.Router();
router.use('/quiz', requireAuth);
router.get('/quiz/seen', async (req, res) => {
  const rows = await db.prepare('SELECT qid, times FROM quiz_seen WHERE user_id=?').all(req.user.id);
  const seen = {}; for (const r of rows) seen[r.qid] = r.times;
  res.json({ seen });
});
const upsert = db.prepare(`INSERT INTO quiz_seen (user_id, qid, times, last_at) VALUES (?, ?, 1, ?)
  ON CONFLICT(user_id, qid) DO UPDATE SET times = quiz_seen.times + 1, last_at = excluded.last_at`);
router.post('/quiz/seen', async (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids : [];
  const known = knownIds(), now = Date.now();
  const ok = [...new Set(ids.map(String))].filter(id => id.length <= 40 && known.has(id)).slice(0, 40);
  for (const id of ok) await upsert.run(req.user.id, id, now);   // 최대 40개라 그냥 차례로
  res.json({ ok: true, saved: ok.length });
});

module.exports = { router, knownIds };
