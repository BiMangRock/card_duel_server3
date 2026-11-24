// rename-cards.js — public/js/cardrenames.js 의 표(옛 이름 → 새 이름)로 server/schema.sql 맨 아래의 "카드 이름 이관" 블록을 다시 만든다.
//   node tools/rename-cards.js
//  · 이관은 서버가 켜질 때(schema.sql 실행) 한 번만 돈다. 끝나면 app_config 에 key='card_rename_<버전>' 을 남긴다
//  · 표에 줄을 추가했으면 아래 VERSION 을 올려서 다시 실행한다 (예전 버전 표시가 있어도 새 버전은 다시 돈다)
const fs = require('fs');
const path = require('path');
const { CARD_RENAMES } = require('../public/js/cardrenames.js');

const VERSION = 'v1';
const FILE = path.join(__dirname, '..', 'server', 'schema.sql');
const BEGIN = '-- >>> 카드 이름 이관 (tools/rename-cards.js 가 만든다. 직접 고치지 말 것)';
const END = '-- <<< 카드 이름 이관 끝';

const q = s => `'${String(s).replace(/'/g, "''")}'`;
const pairs = Object.entries(CARD_RENAMES);
const jsonCols = [['decks', 'deck_json'], ['deck_slots', 'deck_json'], ['adventure_decks', 'deck_json'], ['adventure_runs', 'deck_json'], ['adventure_offers', 'bundles_json']];
const block = `${BEGIN}
--  저장된 보유 카드 · 덱 · 모험 덱 · 보상 묶음 · 보스 덱(app_config 'bosses') 의 옛 카드 이름을 새 이름으로 바꾼다
DO $$
DECLARE
  o text[] := ARRAY[${pairs.map(p => q(p[0])).join(',')}];
  n text[] := ARRAY[${pairs.map(p => q(p[1])).join(',')}];
  i int;
BEGIN
  IF EXISTS (SELECT 1 FROM app_config WHERE key = ${q('card_rename_' + VERSION)}) THEN RETURN; END IF;
  FOR i IN 1..array_length(o, 1) LOOP
    INSERT INTO collection(user_id, card_name, count) SELECT user_id, n[i], count FROM collection WHERE card_name = o[i]
      ON CONFLICT (user_id, card_name) DO UPDATE SET count = collection.count + EXCLUDED.count;
    DELETE FROM collection WHERE card_name = o[i];
    UPDATE craft_log SET card_name = n[i] WHERE card_name = o[i];
${jsonCols.map(([t, c]) => `    UPDATE ${t} SET ${c} = replace(${c}, '"' || o[i] || '"', '"' || n[i] || '"') WHERE ${c} LIKE '%"' || o[i] || '"%';`).join('\n')}
    UPDATE app_config SET value = replace(value, '"' || o[i] || '"', '"' || n[i] || '"') WHERE key = 'bosses' AND value LIKE '%"' || o[i] || '"%';
  END LOOP;
  -- 유저가 만든 카드에 저장된 효과 문구의 옛 용어
  UPDATE custom_cards SET card_json = replace(replace(replace(replace(card_json, '전투의 함성', '등장'), '죽음의 메아리', '유언'), '천상의 보호막', '보호막'), '주문폭주', '과충전'),
                          lines_json = replace(replace(replace(replace(lines_json, '전투의 함성', '등장'), '죽음의 메아리', '유언'), '천상의 보호막', '보호막'), '주문폭주', '과충전');
  INSERT INTO app_config(key, value, updated_at) VALUES (${q('card_rename_' + VERSION)}, 'done', (extract(epoch from now()) * 1000)::bigint)
    ON CONFLICT (key) DO NOTHING;
END $$;
${END}`;

let sql = fs.readFileSync(FILE, 'utf8');
const a = sql.indexOf(BEGIN), b = sql.indexOf(END);
sql = (a >= 0 && b > a) ? sql.slice(0, a) + block + sql.slice(b + END.length) : sql.replace(/\s*$/, '\n\n') + block + '\n';
fs.writeFileSync(FILE, sql);
console.log(`schema.sql 이관 블록: ${pairs.length}개 이름 (${VERSION})`);
