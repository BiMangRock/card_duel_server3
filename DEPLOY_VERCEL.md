# Vercel + Supabase 로 올리기

이 저장소(card_duel_server3)는 card_duel_server2 를 **Vercel(서버리스) + Supabase(PostgreSQL · Realtime)** 에서 돌아가게 바꾼 판입니다.
게임 화면·규칙(`public/`)은 그대로이고, 바뀐 것은 서버의 **저장소(DB)** 와 **실시간 통신**입니다.

## 무엇이 바뀌었나

| | 예전 (server2) | 지금 (server3) |
|---|---|---|
| DB | SQLite 파일 `data/game.db` | PostgreSQL (Supabase). 설정이 없으면 내 컴퓨터의 `data/pglite` 폴더 |
| 서버 → 브라우저 | 웹소켓 `/api/pvp/ws` (서버가 연결을 계속 붙잡음) | Supabase Realtime 채널. 설정이 없으면 롱 폴링 `/api/pvp/poll` |
| 유저 대전 상태 | 서버 메모리 | DB 의 `pvp_world` 한 줄 (요청마다 잠그고 읽고 저장) |
| 턴 제한 시간·끊김 처리 | 서버가 0.25초마다 스스로 확인 | 화면이 보내는 `/api/pvp/ping`(10초마다, 판 도중엔 5초)이 올 때 처리 |
| 접속 상태 | 웹소켓이 열려 있는지 | ping 이 30초 안에 왔는지 |

브라우저 쪽 흐름 (`public/js/pvpclient.js`): `POST /api/pvp/hello` → 알려 준 통로 구독 → 10초마다 `POST /api/pvp/ping` → 탭을 닫으면 `POST /api/pvp/bye`.

## 1. Supabase 준비

1. https://supabase.com 에서 새 프로젝트를 만든다. **Region 은 Northeast Asia (Seoul)** 를 고른다 (Vercel 함수도 서울 `icn1` 로 맞춰 두었다). DB 비밀번호는 따로 적어 둔다.
2. **Project Settings → Database → Connection string** 에서 **Transaction pooler** (포트 `6543`) 주소를 복사한다. `[YOUR-PASSWORD]` 자리를 DB 비밀번호로 바꾼다 → 이게 `DATABASE_URL`.
3. **Project Settings → API** 에서 복사한다.
   - Project URL → `SUPABASE_URL`
   - `anon` `public` 키 (또는 publishable 키) → `SUPABASE_ANON_KEY` (브라우저에 보내도 되는 키)
   - `service_role` 키 (또는 secret 키) → `SUPABASE_SERVICE_ROLE_KEY` (**절대 GitHub·브라우저에 올리면 안 됨**)
4. **Realtime → Settings** 에서 "Allow public access"(또는 "Private channels only" 가 꺼져 있는지)를 확인한다. 이 게임은 사용자마다 이름을 짐작할 수 없는 공개 채널을 쓴다.
5. 테이블은 서버가 처음 DB 에 붙을 때 `server/schema.sql` 로 알아서 만든다. 미리 만들고 싶으면 SQL Editor 에 `server/schema.sql` 내용을 붙여 넣고 실행해도 된다 (여러 번 실행해도 안전).
   - 테이블마다 RLS 를 켜 두므로 브라우저가 anon 키로 DB 를 직접 읽을 수 없다. 읽고 쓰는 건 서버만 한다.

## 2. 예전 데이터 옮기기 (지금 쓰던 계정·골드·카드를 그대로 쓰려면)

예전 서버를 끄고, 이 폴더에서:

```
cp .env.example .env          # 그리고 .env 에 DATABASE_URL 을 채운다
npm install
node tools/migrate-sqlite.js ../card_duel_server2/data/game.db
```

- Node 22.13 이상이 필요하다 (SQLite 파일을 읽는 `node:sqlite`).
- 옮겨 받을 DB 가 비어 있어야 한다. 중간에 실패하면 아무것도 바뀌지 않는다.
- 진행 중이던 유저 대전·대기열은 옮기지 않는다.

## 3. 그림 · 소리 · 기출 문제 넣기

이 세 가지는 코드가 아니라서 아직 이 저장소에 없다. 내 컴퓨터에서 복사해 넣고 push 한다.

| 무엇 | 어디에 | 비고 |
|---|---|---|
| 카드 그림 폴더 `images/` | 프로젝트 맨 위 `images/` | 배포할 때 `tools/vercel-build.js` 가 `public/images/` 로 복사한다 |
| 소리 폴더 | `public/sounds/` | |
| 수능 기출 `gichul.json` | `public/data/gichul.json` | 예전 저장소는 `.gitignore` 의 `data/` 때문에 이 파일이 GitHub 에 안 올라가 있었다. 지금은 `/data/` (맨 위 폴더만)로 고쳐서 올릴 수 있다 |

- GitHub 은 파일 하나가 100MB 를 넘으면 받지 않는다. 한 번 올린 파일은 지워도 기록에 남으니, 올리기 전에 크기를 확인한다.
- 그림에 다른 게임의 저작물이 섞여 있다면, 공개 저장소·공개 사이트에 올리기 전에 정리한다.

## 4. Vercel 에 올리기

1. https://vercel.com → **Add New → Project** → GitHub 의 `card_duel_server3` 를 고른다.
2. Framework Preset 은 **Other**. Build Command · Output Directory 는 `vercel.json` 에 들어 있으니 비워 둔다.
3. **Environment Variables** 에 넣는다:
   - `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - (선택) `GEMINI_API_KEY`, `GEMINI_MODEL` — 카드 제안 AI
4. **Deploy**. 이후로는 `main` 에 push 할 때마다 자동으로 다시 배포된다. 다른 브랜치에 push 하면 미리보기 주소가 따로 생긴다.
5. 배포된 주소의 `/api/health` 를 열어 `{"ok":true,"db":"pg","realtime":"supabase"}` 가 나오면 연결 성공.
6. 개발자 계정 만들기: 내 컴퓨터에서 `.env` 에 `DATABASE_URL` 을 넣은 채로 `node server/make-admin.js <아이디>`.

## 5. 내 컴퓨터에서 켜기

```
npm install
npm start          # http://localhost:3000
```

- `.env` 가 없으면 DB 는 `data/pglite` 폴더(설치 없음), 실시간은 롱 폴링으로 그냥 돌아간다. 친구 PC 에서 테스트할 때 예전처럼 터널을 써도 된다.
- `.env` 에 Supabase 값을 넣으면 내 컴퓨터 서버도 Supabase 를 쓴다 (Vercel 과 같은 데이터).
- `grant.js` · `make-admin.js` · `seed-samples.js` 는 Supabase 를 쓸 때는 서버가 켜져 있어도 되지만, `data/pglite` 를 쓸 때는 서버를 끄고 실행한다 (한 번에 한 프로그램만 열 수 있음).
- `npm test` — 테스트는 메모리 DB(PGlite)로 돈다. `test-adventure.js` · `test-gichul.js` 는 예전 저장소에서도 실패하던 테스트다 (기출 파일 없음 · 오래된 기대값).

## 알아 둘 점

- **요금제**: Vercel 무료(Hobby)는 개인·비상업용이다. 인앱결제·광고 등 돈을 받을 계획이면 유료 요금제가 필요할 수 있다. Supabase 무료 프로젝트는 한동안 아무도 안 쓰면 일시정지될 수 있다 (대시보드에서 다시 켬). 정확한 조건은 각 사이트에서 확인.
- **ping 요청**: 접속해 있는 사람마다 10초에 한 번(판 도중엔 5초) 요청이 간다. Vercel 함수 실행 횟수에 잡힌다.
- **유저 대전은 한 줄(`pvp_world`)을 잠그고 처리**한다. 친구들끼리 하는 규모에서는 문제없지만, 동시 접속이 수백 명이 되면 구조를 다시 봐야 한다.
- **로그인 확인**: 예전에는 서버가 `/` 에서 로그인 안 한 사람을 바로 로그인 화면으로 보냈다. Vercel 에서는 `index.html` 을 정적으로 보내므로, 화면의 `auth.js` 가 확인해서 로그인 화면으로 보낸다 (잠깐 화면이 보였다가 넘어갈 수 있음).
- **그림 webp 우선 보내기**: 예전 서버는 같은 이름의 `.webp` 가 있으면 `.png/.jpg` 대신 보냈다. Vercel 정적 파일은 요청한 파일을 그대로 보낸다 (조금 더 무겁지만 결과는 같음).
- **직접 만든 카드**: 서버가 여러 대일 수 있으므로 5초마다 DB 를 확인해 카드 풀을 맞춘다.
- **요청 횟수 제한**(로그인 실패·채팅 도배 등)은 서버(함수)마다 따로 센다. 예전보다 조금 느슨하다.
