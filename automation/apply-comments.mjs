// 트립코스 디자인 코멘트 자동 반영 엔진 (하루 1회 무인 실행에서 호출).
//   node apply-comments.mjs fetch                      → ready 코멘트 + 현재 설정을 JSON 출력(프롬프트 주입용)
//   node apply-comments.mjs apply <planfile> <slackout> → Claude 가 만든 plan(JSON) 검증·적용, 상태 갱신, 슬랙 요약 작성
//
// 안전 원칙:
//  - 실제 반영은 이 엔진이 '검증 후'에만 한다. Claude 는 계획(JSON)만 낸다.
//  - 유효한 copy key / #rrggbb 강조색 / small|normal|large 크기 만 통과. 그 외는 무시.
//  - DB 쓰기는 전부 UTF-8 .sql 파일 + `wrangler --file` (한글을 native exe argv 로 넘기지 않음 = CP949 깨짐 방지).
//  - settings 는 통째 덮지 않고 '병합'만. 손님 문구는 건드리지 않는 키는 그대로 둔다.
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB = 'gs_trip';
const WORKER_DIR = process.env.GT_WORKER_DIR || 'C:/Users/MGRV 안예지/Documents/gs-trip-course/worker';
const USER_MENTION = '<@U0AG0G63PTR>';

// home.js COPY 와 동일해야 하는 편집 가능 문구 key 목록 (검증용)
const COPY_KEYS = new Set([
  'hero.title', 'hero.sub', 'seg.auto', 'seg.meal', 'seg.cafe', 'seg.bar',
  'slotsub.auto', 'slotsub.meal', 'slotsub.cafe', 'slotsub.bar',
  'feedback.title', 'feedback.body', 'feedback.btnFb', 'feedback.btnSuggest',
  'rating.title', 'rating.body', 'rating.placeholder', 'rating.btn', 'rating.done',
  'fb.title', 'fb.desc', 'fb.place', 'fb.memo', 'fb.done',
  'sg.title', 'sg.desc', 'sg.place', 'sg.memo', 'sg.done', 'sg.name',
]);

function d1raw(argstr) {
  return execSync('npx wrangler d1 execute ' + DB + ' --remote ' + argstr, {
    cwd: WORKER_DIR, encoding: 'utf8', maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'pipe'],
  });
}
// 읽기: SQL 은 ASCII(상태값/id만) → argv 안전
function d1json(sql) {
  const out = d1raw('--json --command "' + sql + '"');
  // wrangler/npx 가 stdout 앞뒤에 배너·경고를 섞어도 JSON 배열만 도려내 파싱 (첫 '[' ~ 마지막 ']')
  const i = out.indexOf('['), k = out.lastIndexOf(']');
  const j = JSON.parse(i >= 0 && k > i ? out.slice(i, k + 1) : out);
  return (j[0] && j[0].results) || [];
}
// 쓰기: SQL 을 UTF-8 파일로 저장 후 --file (한글 안전)
function d1file(sql) {
  const f = join(tmpdir(), 'gt-apply-' + process.pid + '-' + sql.length + '.sql');
  writeFileSync(f, sql, 'utf8');
  d1raw('--file "' + f + '"');
}
const sqlEsc = s => String(s).replace(/'/g, "''");
const uniq = a => [...new Set(a)];

function readSettings() {
  const rows = d1json("SELECT value FROM settings WHERE key='site'");
  if (rows[0] && rows[0].value) { try { return JSON.parse(rows[0].value); } catch { return {}; } }
  return {};
}

const cmd = process.argv[2];

if (cmd === 'fetch') {
  const ready = d1json("SELECT id,target,label,note FROM annotations WHERE status='ready' ORDER BY id");
  const s = readSettings();
  process.stdout.write(JSON.stringify({ ready, copy: s.copy || {}, theme: s.theme || {}, keys: [...COPY_KEYS] }));
  process.exit(0);
}

if (cmd === 'apply') {
  // plan 파일에 코드펜스/여백이 섞여도 첫 '{' ~ 마지막 '}' 만 파싱
  const rawPlan = readFileSync(process.argv[3], 'utf8');
  const a0 = rawPlan.indexOf('{'), b0 = rawPlan.lastIndexOf('}');
  const plan = JSON.parse(a0 >= 0 ? rawPlan.slice(a0, b0 + 1) : '{}');
  const slackOut = process.argv[4];
  const s = readSettings();
  s.copy = s.copy || {}; s.theme = s.theme || {};
  const appliedIds = [], reviewIds = [], applog = [], reviewlog = [];

  for (const a of (plan.apply || [])) {
    if (!Number.isInteger(a.id)) continue;   // id 없는 항목은 상태를 못 바꾸니 적용 안 함 → 아래 leftover 스윕이 review 로 회수
    if (a.type === 'copy' && COPY_KEYS.has(a.key) && typeof a.value === 'string' && a.value.trim()) {
      s.copy[a.key] = a.value.slice(0, 400);
      appliedIds.push(a.id); applog.push('• ' + a.key + ' → ' + a.value.slice(0, 60));
    } else if (a.type === 'theme') {
      if (/^#[0-9a-fA-F]{6}$/.test(a.accent || '')) { s.theme.accent = a.accent; appliedIds.push(a.id); applog.push('• 강조색 → ' + a.accent); }
      if (['small', 'normal', 'large'].includes(a.scale)) { s.theme.scale = a.scale; appliedIds.push(a.id); applog.push('• 글자 크기 → ' + a.scale); }
    }
  }
  for (const r of (plan.review || [])) { if (r.id) { reviewIds.push(r.id); reviewlog.push('• ' + (r.reason || '검토 필요')); } }

  const now = new Date().toISOString();
  if (appliedIds.length) {
    const json = JSON.stringify({ copy: s.copy, theme: s.theme });
    d1file("INSERT INTO settings (key,value,updated_at) VALUES ('site','" + sqlEsc(json) + "','" + now + "') " +
           "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;");
  }
  const ints = arr => uniq(arr).filter(Number.isInteger);
  if (ints(appliedIds).length) d1file("UPDATE annotations SET status='done', resolved_at='" + now + "' WHERE id IN (" + ints(appliedIds).join(',') + ");");
  if (ints(reviewIds).length) d1file("UPDATE annotations SET status='review' WHERE id IN (" + ints(reviewIds).join(',') + ");");
  // 남은 ready(자동 분류 실패·모델 누락 등)는 review 로 회수 → 매일 재처리·재알림 무한루프 방지
  const leftover = d1json("SELECT id, note FROM annotations WHERE status='ready'");
  if (leftover.length) {
    d1file("UPDATE annotations SET status='review' WHERE status='ready';");
    leftover.forEach(r => { reviewIds.push(r.id); reviewlog.push('• (자동 분류 안 됨 — 확인 필요) ' + String(r.note).slice(0, 50)); });
  }

  const L = [];
  L.push(USER_MENTION + ' 📌 *트립코스 디자인 코멘트 자동 반영*');
  L.push('');
  L.push(':white_check_mark: *자동 반영 ' + uniq(appliedIds).length + '건*');
  (applog.length ? applog : ['• (없음)']).slice(0, 20).forEach(x => L.push(x));
  if (reviewlog.length) {
    L.push('');
    L.push(':eyes: *검토 필요 ' + uniq(reviewIds).length + '건* (코드 변경이라 사람이 확인)');
    reviewlog.slice(0, 20).forEach(x => L.push(x));
  }
  L.push('');
  L.push('_문구·색·크기는 자동 적용, 검토 필요 건은 예지님 확인 후 반영해요._');
  writeFileSync(slackOut, L.join('\n'), 'utf8');
  console.log('applied=' + uniq(appliedIds).length + ' review=' + uniq(reviewIds).length);
  process.exit(0);
}

console.error('usage: fetch | apply <planfile> <slackout>');
process.exit(1);
