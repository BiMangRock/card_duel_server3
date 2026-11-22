// bosses.js — 보스 목록 (v116). 모든 유저가 읽고, 개발자(is_admin)만 고친다.
//  - 저장 위치: app_config 테이블의 key='bosses' (JSON 배열). 아직 한 번도 저장하지 않았으면 null → 클라이언트가 코드의 BOSS_DEFAULT 를 쓴다.
//  - 덱은 클라이언트와 같은 검사(validateDeckList)를 서버가 다시 한다.
const path = require('path');
const express = require('express');
const db = require('./db');
const { requireAuth, requireAdmin } = require('./auth');
const JS = path.join(__dirname, '..', 'public', 'js');
const { validateDeckList, HERO_POWERS: E_HP } = require(path.join(JS, 'engine.js'));
const { BOSS_DEFAULT, advCleanFields, advCleanIcon, advBossIcon } = require(path.join(JS, 'adventure.js'));
const { cleanCheatVals, cleanBossPower, cleanUnique } = require(path.join(JS, 'cheats.js'));   // v162 치트 수치 · 보스 영웅 능력(치트)

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_BOSSES = 60;

// 서버(함수)마다 몇 초 동안은 다시 읽지 않는다 (모험 요청마다 읽으므로). 이 서버에서 고치면 바로 지운다
let cache = null;
const CACHE_MS = 3000;
async function readBosses() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.v;
  const r = await db.prepare("SELECT value FROM app_config WHERE key='bosses'").get();
  let v = null;
  if (r) { try { const x = JSON.parse(r.value); v = Array.isArray(x) ? x : null; } catch (_) { v = null; } }
  cache = { at: Date.now(), v };
  return v;
}

// 클라이언트 BossBook.clean 과 같은 모양으로 정리. 잘못된 값이면 문자열(오류), 정상이면 정리된 객체
function cleanBoss(b, i) {
  if (!b || typeof b !== 'object') return `${i + 1}번째 보스가 올바르지 않아요.`;
  if (typeof b.id !== 'string' || !ID_RE.test(b.id)) return `${i + 1}번째 보스의 id 는 영문·숫자·_- 1~40자여야 해요.`;
  const bad = validateDeckList(b.deck);
  if (bad) return `보스 ${b.id}: ${bad}`;
  const high = b.tier === 'high' || (b.tier == null && b.bot === 'model');
  return {
    id: b.id,
    name: String(b.name || '이름 없음').slice(0, 20),
    icon: advBossIcon(b),                      // v117: 이모지 또는 images/… 그림 경로 · v146 이모지면 기본 초상화(BOSS_ICON_IMG)
    desc: String(b.desc || '').slice(0, 80),
    cheats: [...new Set((Array.isArray(b.cheats) ? b.cheats : []).map(x => String(x).slice(0, 40)))].slice(0, 30),
    reward: Math.max(0, Math.min(1000000, Math.floor(Number(b.reward) || 0))),
    tier: high ? 'high' : 'mid',
    bot: high ? 'model' : (b.bot === 'rule' ? 'rule' : 'rule2'),
    model: String(b.model || '').slice(0, 200),
    cheatVals: cleanCheatVals(b.cheatVals),            // v162 치트마다 정한 수치
    heroPower: E_HP[b.heroPower] ? b.heroPower : '',   // v131 영웅 능력 ('' = 판마다 무작위)
    ...(cleanBossPower(b) || {}),                      // v162 'cheat:<id>' 영웅 능력 + powerMode · powerCost
    ...cleanUnique(b),                                 // v166 고유 능력 (N수 선언 등)
    deck: b.deck.map(String),
    ...advCleanFields(b),          // v117: chapter · stage · rewardCards
  };
}
// 지금 실제로 쓰이는 보스 목록 (서버에 저장된 것 → 없으면 코드 기본값). 클리어 보상·단계 잠금 검사에 쓴다.
async function currentBosses() {
  const saved = await readBosses();
  if (saved) return saved.map((b, i) => { const c = cleanBoss(b, i); return typeof c === 'string' ? { ...b, ...advCleanFields(b) } : c; });
  return BOSS_DEFAULT.map((b, i) => { const c = cleanBoss(b, i); return typeof c === 'string' ? { ...b, ...advCleanFields(b) } : c; });
}

const router = express.Router();

router.get('/bosses', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ bosses: await readBosses() });
});

// 요청: {bosses:[...]} 저장 / {bosses:null} 코드 기본값으로 되돌리기 (둘 다 개발자만)
router.put('/bosses', requireAdmin, async (req, res) => {
  const list = (req.body || {}).bosses;
  if (list === null) {
    cache = null;
    await db.prepare("DELETE FROM app_config WHERE key='bosses'").run();
    return res.json({ bosses: null });
  }
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_BOSSES) return res.status(400).json({ error: `보스는 1~${MAX_BOSSES}명이어야 해요.` });
  const out = [], seen = new Set();
  for (let i = 0; i < list.length; i++) {
    const c = cleanBoss(list[i], i);
    if (typeof c === 'string') return res.status(400).json({ error: c });
    if (seen.has(c.id)) return res.status(400).json({ error: `보스 id 가 겹쳐요: ${c.id}` });
    seen.add(c.id); out.push(c);
  }
  cache = null;
  await db.prepare(`INSERT INTO app_config(key,value,updated_at) VALUES ('bosses',?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(JSON.stringify(out), Date.now());
  res.json({ bosses: out });
});

module.exports = { router, readBosses, cleanBoss, currentBosses };
