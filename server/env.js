// env.js — 프로젝트 맨 위 폴더의 .env 파일을 읽어 환경변수로 넣는다 (이미 있는 값은 그대로). Vercel 에서는 대시보드의 값을 쓴다.
//   .env 예시는 .env.example 참고. .env 는 비밀 값이라 GitHub 에 올리지 않는다 (.gitignore)
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', '.env');
if (!process.env.VERCEL && fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2]; if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
