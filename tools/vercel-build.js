// vercel-build.js — Vercel 이 배포할 때 실행하는 준비 단계 (vercel.json 의 buildCommand)
//   Vercel 은 public/ 폴더를 그대로 정적 파일로 내보낸다. 그런데 카드 그림은 프로젝트 맨 위 images/ 에 있으므로
//   여기서 public/images/ 로 복사해 둔다. (이미 public/images/ 에 넣어 두었다면 그대로 쓴다)
//   소리(public/sounds)·글꼴(public/fonts)은 원래 public 안에 있으니 할 일이 없다.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'images'), DST = path.join(ROOT, 'public', 'images');

function copyDir(src, dst) {
  let n = 0;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) n += copyDir(s, d);
    else if (!fs.existsSync(d)) { fs.copyFileSync(s, d); n++; }
  }
  return n;
}

if (fs.existsSync(SRC)) console.log(`[build] images/ → public/images/ : ${copyDir(SRC, DST)}개 복사`);
else if (fs.existsSync(DST)) console.log('[build] public/images/ 를 그대로 씁니다');
else console.warn('[build] ⚠ images/ 폴더가 없어요. 카드 그림이 안 보입니다. 프로젝트 맨 위에 images/ 를 넣고 다시 배포하세요.');

if (!fs.existsSync(path.join(ROOT, 'public', 'sounds'))) console.warn('[build] ⚠ public/sounds/ 가 없어요. 효과음이 안 납니다.');
if (!fs.existsSync(path.join(ROOT, 'public', 'data', 'gichul.json'))) console.warn('[build] ⚠ public/data/gichul.json 이 없어요. 수능 기출 문제가 안 나옵니다.');
for (const k of ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY'])
  if (!process.env[k] && !(k === 'DATABASE_URL' && process.env.POSTGRES_URL)) console.warn(`[build] ⚠ 환경변수 ${k} 가 없어요. Vercel 프로젝트 설정 → Environment Variables 에 넣어 주세요.`);
