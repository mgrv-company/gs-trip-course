// 기존 overrides.json + manual_places.json → D1 이전용 seed.sql 생성 (1회용)
// 실행: node worker/migrate.js   (프로젝트 루트에서)
// 이후: cd worker && npx wrangler d1 execute gs_trip --remote --file=seed.sql
//
// 핵심: overrides 는 지금까지 "가게 이름"이 키였지만 D1은 sid 가 키.
// places_tagged.json 에서 이름→sid 를 찾아 변환하고, 못 찾는 이름은 삭제하지 않고
// 아래 목록으로 보고만 한다 (사용자 확인 후 수동 처리).

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

const tagged = read('data/places_tagged.json');
const overrides = read('data/overrides.json');
let manual = [];
try { manual = read('data/manual_places.json'); } catch { /* 없으면 빈 배열 */ }

// 이름→sid 매핑 (공백 무시 정확 일치 → 포함 일치 순서, apply_notion.py와 동일한 요령)
const byName = new Map(tagged.map(x => [x.name.replace(/\s/g, ''), String(x.sid)]));
function findSid(name) {
  const q = name.replace(/\s/g, '');
  if (byName.has(q)) return byName.get(q);
  // 주의: 뒤 조건은 "데이터 이름"이 3자 이상일 때만 — 1~2자 가게명이 긴 검색어에 우연히 포함돼
  // 엉뚱한 sid에 붙는 오매칭 방지 (apply_notion.py find()와 동일한 방향)
  const cands = [...byName.keys()].filter(n => n.includes(q) || (n.length >= 3 && q.includes(n)));
  if (cands.length === 1) return byName.get(cands[0]);
  return null;   // 0개 또는 애매(2개 이상) → 보고
}

const esc = s => String(s).replace(/'/g, "''");
const lines = ['-- 자동 생성: node worker/migrate.js — 기존 편집 데이터 D1 이전'];
const unmatched = [];
let nOv = 0;

for (const [name, o] of Object.entries(overrides)) {
  if (name === '_설명' || !o || typeof o !== 'object') continue;
  // manual 가게에 대한 override 일 수도 있으니 manual 에서도 sid 탐색
  const sid = findSid(name) || (manual.find(m => m.name === name)?.sid ?? null);
  if (!sid) { unmatched.push(name); continue; }
  lines.push(
    `INSERT INTO overrides (sid, name, exclude, reserve, pick, takeout, notion, note, updated_at) VALUES (` +
    `'${esc(sid)}', '${esc(name)}', ${o.exclude ? 1 : 0}, ${o.reserve ? 1 : 0}, ${o.pick ? 1 : 0}, ` +
    `${o.takeout ? 1 : 0}, ${o.notion ? 1 : 0}, '${esc(o.note || '')}', '${new Date().toISOString()}') ` +
    `ON CONFLICT(sid) DO UPDATE SET name=excluded.name, exclude=excluded.exclude, reserve=excluded.reserve, ` +
    `pick=excluded.pick, takeout=excluded.takeout, notion=excluded.notion, note=excluded.note, updated_at=excluded.updated_at;`
  );
  nOv++;
}

let nMan = 0;
for (const m of manual) {
  if (!m.sid || !m.name) continue;
  lines.push(
    `INSERT INTO manual_places (sid, json, updated_at) VALUES ('${esc(m.sid)}', '${esc(JSON.stringify(m))}', '${new Date().toISOString()}') ` +
    `ON CONFLICT(sid) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at;`
  );
  nMan++;
}

fs.writeFileSync(path.join(__dirname, 'seed.sql'), lines.join('\n') + '\n', 'utf8');

console.log(`✅ seed.sql 생성: overrides ${nOv}건 + 직접추가 ${nMan}건`);
console.log(`   (원본: overrides.json ${Object.keys(overrides).filter(k => k !== '_설명').length}건, manual ${manual.length}건)`);
if (unmatched.length) {
  console.log(`⚠️ sid 못 찾음 ${unmatched.length}건 — 이전에서 빠짐, 확인 필요:`);
  unmatched.forEach(n => console.log('   -', n));
} else {
  console.log('   미매칭 없음 — 전부 변환됨');
}
