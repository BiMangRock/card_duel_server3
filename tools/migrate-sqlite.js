// migrate-sqlite.js — 예전 서버의 SQLite 파일(data/game.db)을 PostgreSQL(Supabase)로 옮긴다. 한 번만 쓰면 된다.
//
//   1) .env 에 DATABASE_URL (Supabase) 을 넣는다
//   2) node tools/migrate-sqlite.js <예전 game.db 경로>
//        예) node tools/migrate-sqlite.js ../card_duel_server2/data/game.db
//
//   - 예전 서버는 꺼 두고 실행한다 (쓰는 중인 파일을 읽지 않게).
//   - 옮겨 받을 DB 는 비어 있어야 한다 (이미 가입한 사람이 있으면 멈춘다 → --force 로 무시할 수 있지만 id 가 겹치면 실패한다).
//   - 진행 중이던 유저 대전·대기열은 옮기지 않는다 (서버 메모리에만 있던 것).
//   - Node 22.13 이상 필요 (SQLite 파일을 읽는 node:sqlite).
require('../server/env');
const path = require('path');
const fs = require('fs');

const file = process.argv[2];
const force = process.argv.includes('--force');
if (!file || !fs.existsSync(file)) { console.log('사용법: node tools/migrate-sqlite.js <예전 game.db 경로> [--force]'); process.exit(1); }
if (!process.env.DATABASE_URL && !process.env.DB_PATH) { console.log('⚠ DATABASE_URL 이 없어요. .env 에 Supabase 주소를 넣은 뒤 다시 실행하세요. (그냥 하면 내 컴퓨터 data/pglite 로 옮겨집니다)'); }

const { DatabaseSync } = require('node:sqlite');
const db = require('../server/db');

// 부모 테이블이 먼저 오도록 (외래 키 순서)
const ORDER = [
  'users', 'sessions', 'wallets', 'decks', 'collection', 'collection_init', 'shop_state', 'pack_log', 'adventure_progress', 'pvp_matches',
  'app_config', 'adventure_decks', 'adventure_offers', 'adventure_runs', 'rank_state', 'friends', 'friend_requests', 'pvp_replays', 'replay_owners',
  'friend_messages', 'quiz_seen', 'tutorial_progress', 'deck_slots', 'deck_meta', 'player_progress', 'cheat_codex', 'craft_log',
  'custom_cards', 'custom_card_versions', 'gold_log', 'custom_card_images', 'card_proposals',
];
const IDENTITY = ['users', 'pack_log', 'pvp_matches', 'friend_messages', 'craft_log', 'custom_cards', 'gold_log', 'custom_card_images', 'card_proposals'];

(async () => {
  const src = new DatabaseSync(file, { readOnly: true });
  const srcTables = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  await db.init();
  const have = (await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n;
  if (have && !force) { console.error(`옮겨 받을 DB 에 이미 사용자가 ${have}명 있어요. 비어 있는 DB 에만 옮길 수 있어요. (무시하려면 --force)`); process.exit(1); }

  await db.tx(async () => {
    for (const t of ORDER) {
      if (!srcTables.has(t)) { console.log(`- ${t}: 예전 DB 에 없음 (건너뜀)`); continue; }
      const dstCols = (await db.prepare("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=?").all(t)).map(r => r.column_name);
      const srcCols = src.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
      const cols = srcCols.filter(c => dstCols.includes(c));
      const extra = t === 'replay_owners' && dstCols.includes('seq') ? ['seq'] : [];        // SQLite rowid 순서를 seq 로
      const rows = src.prepare(`SELECT ${cols.map(c => `"${c}"`).join(',')}${extra.length ? ', rowid AS seq' : ''} FROM ${t} ORDER BY rowid`).all();
      const all = cols.concat(extra);
      const ident = IDENTITY.includes(t) && all.includes('id') ? ' OVERRIDING SYSTEM VALUE' : '';
      const sql = `INSERT INTO ${t}(${all.map(c => `"${c}"`).join(',')})${ident} VALUES (${all.map(() => '?').join(',')}) ON CONFLICT DO NOTHING`;
      let n = 0;
      for (const r of rows) {
        const vals = all.map(c => { const v = r[c]; return v instanceof Uint8Array ? Buffer.from(v) : typeof v === 'bigint' ? Number(v) : v; });
        n += (await db.prepare(sql).run(...vals)).changes;
      }
      if (t === 'custom_cards' && dstCols.includes('updated_at')) await db.prepare('UPDATE custom_cards SET updated_at=?').run(Date.now());
      console.log(`✔ ${t}: ${n}/${rows.length}줄`);
    }
    // 새로 만드는 줄의 번호가 옮긴 번호 다음부터 이어지게
    for (const t of IDENTITY.concat(['replay_owners'])) {
      const col = t === 'replay_owners' ? 'seq' : 'id';
      await db.exec(`SELECT setval(pg_get_serial_sequence('${t}', '${col}'), GREATEST((SELECT COALESCE(MAX(${col}), 0) FROM ${t}), 1))`);
    }
  });
  console.log('✔ 옮기기 끝. 진행 중이던 유저 대전·대기열은 옮기지 않았어요.');
  await db.close();
})().catch(async e => { console.error('✘ 실패 (아무것도 바뀌지 않았어요):', e.message); try { await db.close(); } catch (_) {} process.exit(1); });
