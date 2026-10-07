// gs-trip-course 어드민 백엔드 — Cloudflare Worker + D1
//
// 역할 3가지:
//  1) 어드민: 비밀번호 로그인 → 가게 편집(제외/예약/강추/포장/메모/직접추가)을 DB에 즉시 저장
//  2) 투숙객 페이지: 편집 데이터를 공개로 읽어가 places.js 스냅샷 위에 얹음 (저장 즉시 반영)
//  3) 피드백: 방문객 의견 수신 → 검증·횟수제한 후 슬랙 #gs-routine 전송 (구 Apps Script 대체)
//
// 비밀값(코드 밖, wrangler secret): ADMIN_PASSWORD, SLACK_WEBHOOK
// 공개값(wrangler.jsonc vars): FB_TOKEN

import PICKS_BACKFILL from './picks-backfill.js';   // 모음 페이지 이전에 보낸 카드 22장 (2026-10-07)

const SITE_URL = 'https://mgrv-company.github.io/gs-trip-course';   // 투숙객 페이지 주소 (지난 카드 작은 그림이 여기 있다)
const SESSION_DAYS = 60;            // 어드민 로그인 유지 기간
const FB_LIMIT = 15;                // 피드백: 10분당 최대 건수
const LOGIN_LIMIT = 10;             // 로그인 시도: IP당 10분에 최대 횟수 (무차별 대입 방지)
const VIEW_LIMIT = 40;             // 조회수 집계: IP당 10분 최대 (부풀리기·D1 쓰기 남용 방지)
const SEND_LIMIT = 12;             // 코멘트 반영요청: IP당 10분 최대 (슬랙 스팸 방지)
const CLICK_LIMIT = 120;           // 가게 클릭 집계: IP당 10분 최대 (남용 방지, 정상 사용엔 넉넉)
const IMPRESSION_LIMIT = 300;      // 노출 집계: IP당 10분 최대 (렌더마다 1회·디바운스라 넉넉)
const PUB_CACHE_MS = 15000;
const IMG_LIMIT = 400;             // 사진 중계(/public/img): IP당 10분 최대 (카드 만들기 썸네일·본사진 — 캐시 히트는 안 셈)
const NAVER_PHOTO_LIMIT = 40;      // 네이버 사진 목록(/public/naver-photos): IP당 10분 최대 (네이버 차단 방지)
const NAVER_PHOTO_CACHE_MS = 3600000; // 네이버 사진 목록 메모리 캐시 1시간
const CARD_SEND_LIMIT = 20;        // 카드 트립코스 발송: IP당 10분 최대 (로그인 필요하지만 실수 연타 방지)
const CARD_MAX_BYTES = 6 * 1024 * 1024;   // 카드 이미지 최대 크기 (JPEG 0.9 기준 1MB 안팎, 여유 있게)
// (2026-10-07) 카드 그림 KV 보관 기한 6개월 → 없음. 추천 가게 모음(picks.html)에서 계속 보여야 해서. 지난 카드는 backfillPicks() 가 다시 넣는다.
const DRAFT_MAX_BYTES = 4 * 1024 * 1024;  // 임시저장 1건 최대 (내 사진을 넣으면 data: 주소가 포함돼 수백 KB)
const DRAFT_TTL_SEC = 90 * 86400;  // 임시저장 보관 기간 3개월 (그 뒤 자동 삭제)
const DRAFT_LIMIT = 60;            // 임시저장 읽기/쓰기: IP당 10분 최대
const CARD_TPL_KEYS = ['eyebrow', 'move', 'hours', 'closed', 'rating', 'menu', 'reviewLabel', 'closing', 'send'];   // 카드 기본 문구 허용 키
const CARD_TPL_KV = 'cardmaker/defaults';
const IMG_HOST_RE = /(^|\.)(pstatic\.net|phinf\.naver\.net)$/;   // 사진 중계 허용 호스트 — 네이버 이미지 CDN만 (열린 프록시 방지)
const NAVER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';         // 공개 읽기 메모리 캐시 (남용시 무료한도 소진 방지 — 어드민 저장하면 즉시 비움)
const GO_LIMIT = 300;              // 카드 링크 클릭 집계(/go/): IP당 10분 최대 — 넘으면 넘겨주기만 하고 세지 않음
const GO_HOST_RE = /(^|\.)(naver\.com|naver\.me)$/;   // /go/ 로 넘겨줄 수 있는 곳 — 네이버 지도만 (열린 리다이렉트 방지)
// 링크 미리보기를 만들려고 주소를 여는 프로그램(슬랙·카카오톡 스크랩·페북 등) — 사람 클릭이 아니라 세지 않는다
const PREVIEW_BOT_RE = /bot|crawl|spider|slurp|scrap|preview|facebookexternalhit|embedly|slack-imgproxy|whatsapp|headless|curl|wget|python|go-http|okhttp|java\/|axios|node-fetch|undici|^node\b/i;
const SLACK_BOT_NAME = '고성 트립 코스 봇';  // 이 서비스가 #gs-routine 에 보내는 슬랙 알림 표시 이름 (공용 웹훅이라 이름만 덮어씀)

// KST 날짜(YYYY-MM-DD) — 조회수 버킷 등 날짜 집계에 공용 사용
const kstDay = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
// KST 시(0~23) — 클릭 시간대 집계용
const kstHour = () => new Date(Date.now() + 9 * 3600 * 1000).getUTCHours();
// 슬랙 특수문법 무력화 — <!channel> 전체알림 장난·가짜 링크 방지 (모든 슬랙 전송 경로 공용)
const slackEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let pubCache = {};                  // { 경로: { data, at } } — 인스턴스 메모리 캐시

// 허용 출처 — 투숙객 사이트(GitHub Pages) + 로컬 개발
const ALLOWED_ORIGINS = [
  'https://mgrv-company.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(req, data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(req), ...extra },
  });
}

// 10분 단위 시간 창 키 (예: '2026-07-06T09:1|fb') — 날짜를 맨 앞에 둬서 청소 쿼리가 단순해짐
function bucketKey(prefix) {
  const now = new Date();
  const win = Math.floor(now.getUTCMinutes() / 10);
  return `${now.toISOString().slice(0, 13)}:${win}|${prefix}`;
}

// 카운터 증가 후 한도 초과 여부 반환 (초과 = true)
async function overLimit(db, prefix, limit) {
  const key = bucketKey(prefix);
  await db.prepare(
    'INSERT INTO rate_counters (bucket, n) VALUES (?, 1) ON CONFLICT(bucket) DO UPDATE SET n = n + 1'
  ).bind(key).run();
  const row = await db.prepare('SELECT n FROM rate_counters WHERE bucket = ?').bind(key).first();
  return (row?.n || 0) > limit;
}

// Authorization: Bearer <token> 검사 → 유효하면 true
async function checkAuth(req, db) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return false;
  const row = await db.prepare('SELECT created_at FROM sessions WHERE token = ?').bind(token).first();
  if (!row) return false;
  const ageMs = Date.now() - new Date(row.created_at).getTime();
  if (ageMs > SESSION_DAYS * 86400 * 1000) {
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return false;
  }
  return true;
}

// overrides 행 → 프론트에서 쓰는 축약 객체 (0인 플래그·빈 메모는 생략해 가볍게)
function slimOverride(r) {
  const o = {};
  if (r.exclude) o.x = 1;
  if (r.reserve) o.r = 1;
  if (r.pick) o.p = 1;
  if (r.takeout) o.to = 1;
  if (r.notion) o.nt = 1;
  if (r.natural != null) o.nat = r.natural;   // 0도 유효한 값(비자연명소 수동지정)이라 != null로 검사
  if (r.note) o.note = r.note;
  const a2 = parseAlso(r.also);
  if (a2.length) o.a2 = a2;   // 추가 노출 섹션 (원래 type 외에 뜰 곳)
  return o;
}

// also 컬럼(JSON 배열 문자열) → 문자열 배열. 깨졌거나 비었으면 빈 배열.
function parseAlso(raw) {
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.filter(t => typeof t === 'string' && t) : [];
  } catch (e) { return []; }
}

// 짧은 링크 번호 — 헷갈리는 글자(0/O, 1/l/I) 제외
function randomId(len) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(len)), x => abc[x % abc.length]).join('');
}

// 카드 링크 1개 등록 → 번호 반환. 네이버 지도 주소가 아니면 null.
async function createCardLink(db, { target, sid, name, source, card }) {
  let t;
  try { t = new URL(String(target || '').slice(0, 500)); } catch (e) { return null; }
  if (t.protocol !== 'https:' || !GO_HOST_RE.test(t.hostname)) return null;
  for (let i = 0; i < 3; i++) {
    const id = randomId(7);
    try {
      await db.prepare('INSERT INTO card_links (id, sid, name, target, source, card, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, String(sid || '').slice(0, 20), String(name || '').slice(0, 80), t.href, source, card || '', new Date().toISOString()).run();
      return id;
    } catch (e) {
      if (!/UNIQUE|constraint/i.test(String(e && e.message))) throw e;   // 번호가 겹칠 때만 다시 뽑는다
    }
  }
  throw new Error('링크 번호를 만들지 못했어요');
}

// 같은 날 같은 기기를 한 줄로 묶는 값. 공개 저장소라 코드에 있는 값만 섞으면 IP 를 역산할 수 있어 비밀값을 섞는다.
async function visitorHash(env, day, req) {
  const raw = [day, req.headers.get('CF-Connecting-IP') || 'local', req.headers.get('User-Agent') || '', env.ADMIN_PASSWORD || ''].join('|');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf).slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
}

// ── 추천 가게 모음: 모음 페이지를 만들기 전(2026-09-14~10-07)에 보낸 카드 22장을 picks 표에 넣고 그림 보관 기한을 없앤다 ──────
// 여러 번 돌아도 안전: 한 번 끝나면 settings.picks_backfill='done' 으로 건너뛰고, 날짜가 이미 있으면 그 줄은 안 건드린다.
// sid·네이버 주소는 보낼 때 만든 card_links 줄에서 가져오고(없으면 모듈의 값), 작은 그림은 사이트의 picks/thumbs/ 에 올려 둔 것.
async function backfillPicks(env) {
  const db = env.DB;
  const out = { inserted: 0, kept: 0, relinked: 0, missingImage: [] };
  const done = await db.prepare("SELECT value FROM settings WHERE key = 'picks_backfill'").first();
  if (done && done.value === 'done') return { ...out, skipped: true };
  for (const p of PICKS_BACKFILL) {
    const link = await db.prepare("SELECT sid, target FROM card_links WHERE card = ? AND source = 'send' ORDER BY created_at DESC LIMIT 1").bind(p.card).first().catch(() => null);
    const r = await db.prepare('INSERT OR IGNORE INTO picks (day, sid, name, cat, target, card, thumb, hidden, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)')
      .bind(p.day, (link && link.sid) || p.sid || '', p.name, p.cat, (link && link.target) || p.target || '', p.card, `${SITE_URL}/${p.thumb}`, `${p.day}T02:00:00.000Z`).run();
    if (r.meta && r.meta.changes) out.inserted++; else out.kept++;
    if (env.CARDS) {
      const v = await env.CARDS.getWithMetadata(p.card, { type: 'arrayBuffer' });
      if (v && v.value) { await env.CARDS.put(p.card, v.value, { metadata: v.metadata || { type: 'image/jpeg' } }); out.relinked++; }   // 기한 없이 다시 저장
      else out.missingImage.push(p.card);
    }
  }
  await db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('picks_backfill', 'done', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(new Date().toISOString()).run();
  return out;
}

// ── 트립코스 주간 보고 (2026-09-15, 2026-09-28 형식 변경) ──────
// 매주 월 10:00 KST(wrangler.jsonc cron `0 1 * * 2` — 클라우드플레어 요일은 일요일=1)에 지난주(월~일) 보고를 #gs-routine 으로 보낸다.
// PC 가 꺼져 있어도 돌도록 워커에서 실행하고, 결과를 settings 에 남겨 PC 루틴 감시(gs-deadman.sh 23번)가 빠짐을 잡는다.
// 오픈채팅 '트립코스 바로가기'(m.site.naver.com/2euku) 클릭 수는 네이버 로그인 화면에서만 보여 자동으로 못 가져온다
// → 사용자가 어드민에 주마다 입력한 값(settings SHORTLINK_KEY)으로 표를 만든다. 입력 전이면 그 칸만 '미입력'.
const REPORT_STATUS_KEY = 'weekly_link_report';
const SHORTLINK_KEY = 'shortlink_weekly';   // {"월요일 YYYY-MM-DD": 조회수}
// 네이버 통계 화면(2026-09-28 사용자 캡처) 기준 초기값. 저장된 값이 있으면 그쪽이 우선한다.
const SHORTLINK_SEED = { '2026-08-10': 37, '2026-08-17': 36, '2026-08-24': 7, '2026-08-31': 6, '2026-09-07': 1, '2026-09-14': 21, '2026-09-21': 27 };
const USER_MENTION = '<@U0AG0G63PTR>';
const shiftDay = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// 오늘 기준 마지막으로 끝난 월~일 주. 수동 발송을 화~일에 눌러도 네이버 통계와 같은 주 경계를 쓰게 한다.
function lastFullWeek(today = kstDay()) {
  const dow = new Date(today + 'T00:00:00Z').getUTCDay();   // 0=일
  const end = shiftDay(today, -(dow === 0 ? 7 : dow));
  return { start: shiftDay(end, -6), end };
}
async function loadShortlinkWeeks(db) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(SHORTLINK_KEY).first();
  let saved = {};
  try { saved = row && row.value ? JSON.parse(row.value) : {}; } catch (e) { console.error('shortlink_weekly parse failed', e.message); }
  return { ...SHORTLINK_SEED, ...saved };
}
// 슬랙 코드 블록 정렬용 — 한글은 고정폭 글꼴에서 두 칸을 차지한다
const dispWidth = s => Array.from(String(s)).reduce((w, ch) => w + (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(ch) ? 2 : 1), 0);
function padW(s, w) {
  let t = String(s);
  while (dispWidth(t) > w) t = Array.from(t).slice(0, -1).join('');
  return t + ' '.repeat(w - dispWidth(t));
}

// 보고 숫자만 모은다. 슬랙 문구(renderReportMarkdown)와 어드민 화면(/admin/weekly-report)이 같은 값을 쓴다.
async function collectWeeklyReport(db) {
  const { start, end } = lastFullWeek();
  const prevStart = shiftDay(start, -7), prevEnd = shiftDay(start, -1);
  const weeks = await loadShortlinkWeeks(db);
  const keys = Object.keys(weeks).filter(k => k <= start).sort();
  const vals = keys.map(k => weeks[k]);
  const maxN = vals.length ? Math.max(...vals) : 0, minN = vals.length ? Math.min(...vals) : 0;
  const maxAt = keys[vals.indexOf(maxN)], minAt = keys[vals.indexOf(minN)];
  const shortlink = keys.map(k => {
    const note = [];
    if (k === maxAt) note.push('최고');
    if (k === minAt && minN !== maxN) note.push('최저');
    if (k === start && weeks[prevStart] != null) note.push('직전 주 대비 ' + signed(weeks[k] - weeks[prevStart]));
    return { start: k, end: shiftDay(k, 6), n: weeks[k], note: note.join(' · ') };
  });
  // 지난주에 보낸 카드별 누적 클릭 (복사로 만든 링크는 표에서 빼고 주간 합계에만 넣는다)
  const sentRows = await db.prepare(
    'SELECT l.sid, l.name, l.created_at, COALESCE((SELECT SUM(n) FROM card_link_hits h WHERE h.id = l.id), 0) AS total ' +
    "FROM card_links l WHERE l.source = 'send' AND date(datetime(l.created_at, '+9 hours')) BETWEEN ? AND ? ORDER BY l.created_at"
  ).bind(start, end).all();
  // 같은 가게를 같은 날 다시 보낸 건 한 줄로: 클릭은 더하고 발송 시각은 마지막 것 (사용자 결정 2026-09-28)
  const merged = new Map();
  for (const r of sentRows.results) {
    const sentAt = new Date(new Date(r.created_at).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16);
    const key = (r.sid || r.name) + '|' + sentAt.slice(0, 10);
    const prevRow = merged.get(key);
    if (prevRow) { prevRow.clicks += r.total; prevRow.sentAt = sentAt; }
    else merged.set(key, { name: r.name || '(이름 없음)', sentAt, clicks: r.total });
  }
  const cards = [...merged.values()].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  const clicks = (a, b) => db.prepare('SELECT COALESCE(SUM(n), 0) AS n FROM card_link_hits WHERE day >= ? AND day <= ?').bind(a, b).first();
  const cur = await clicks(start, end), prev = await clicks(prevStart, prevEnd);
  return {
    start, end, prevStart,
    shortlink, total: vals.reduce((sum, n) => sum + n, 0), best: maxN,
    last: weeks[start] != null ? weeks[start] : null, prevN: weeks[prevStart] != null ? weeks[prevStart] : null,
    cards,
    cardClicks: cur.n, cardClicksPrev: prev.n,
  };
}
const signed = n => (n >= 0 ? '+' : '') + n;
const mdDay = ymd => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
const mdRange = (a, b) => `${mdDay(a)}~${mdDay(b)}`;

// 노션에 붙여넣으면 그대로 표·굵게가 되는 마크다운 (사용자 노션 보고 형식, 2026-09-28 캡처)
function renderReportMarkdown(d) {
  const L = ['**[오픈채팅방에 노출하는 트립코스 바로가기 링크 클릭 수 (주간)]**', ''];
  if (d.shortlink.length) {
    L.push('| 주간 | 조회수 | 비고 |', '| --- | --- | --- |');
    for (const w of d.shortlink) L.push(`| ${mdRange(w.start, w.end)} | ${w.n} | ${w.note} |`);
    L.push('');
    L.push(`- 누적(${mdRange(d.shortlink[0].start, d.shortlink[d.shortlink.length - 1].end)}): **${d.total}건**`);
  }
  if (d.last != null) {
    L.push(`- 지난주(${mdRange(d.start, d.end)}): **${d.last}건**`);
    if (d.prevN != null) L.push(`    - 직전 주 ${d.prevN}건 대비 ${signed(d.last - d.prevN)}`);
    if (d.best > 0 && d.last < d.best) L.push(`    - 최고치(${d.best}건)의 ${Math.round(d.last / d.best * 100)}% 수준`);
  } else {
    L.push(`- ${mdRange(d.start, d.end)} 숫자 미입력 (어드민 📊 조회수 탭에서 입력)`);
  }
  L.push('', '**[오픈채팅방 카드뉴스 클릭 수]**', '');
  if (d.cards.length) {
    L.push('| 카드 | 발송 | 클릭 |', '| --- | --- | --- |');
    for (const c of d.cards) L.push(`| ${c.name.replace(/\|/g, '/')} | ${mdDay(c.sentAt.slice(0, 10))} ${c.sentAt.slice(11, 16)} | ${c.clicks} |`);
    L.push('');
  } else {
    L.push('- 지난주에 보낸 카드 없음');
  }
  L.push(`- 발송 ${d.cards.length}장 · 카드 링크 클릭 ${d.cardClicks}회 (직전 주 ${d.cardClicksPrev}회, ${signed(d.cardClicks - d.cardClicksPrev)})`);
  L.push('- 카드별 클릭은 보낸 뒤 지금까지 누적, 합계는 그 주에 눌린 횟수');
  return L.join('\n');
}

// 슬랙: 제목 한 줄 + 마크다운 전체를 코드 블록 하나에 담는다 → 블록째 복사해 노션에 붙이면 표로 들어간다
async function buildWeeklyLinkReport(db) {
  const d = await collectWeeklyReport(db);
  const text = `${USER_MENTION} *[고성] 트립코스 관련 데이터 (${mdRange(d.start, d.end)})*\n\`\`\`\n${renderReportMarkdown(d)}\n\`\`\``;
  return { text, start: d.start, end: d.end };
}

// source: 'cron'(정기) | 'manual'(어드민 버튼). 감시는 cron 기록만 본다 — 수동 발송이 정기 실행 고장을 가리지 않게.
async function runWeeklyLinkReport(env, source) {
  const at = new Date().toISOString();
  let status;
  try {
    if (!env.SLACK_WEBHOOK) throw new Error('SLACK_WEBHOOK 미설정');
    const { text, start, end } = await buildWeeklyLinkReport(env.DB);
    const r = await fetch(env.SLACK_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, username: SLACK_BOT_NAME }) });
    if (!r.ok) throw new Error(`슬랙 발송 실패 (${r.status}) ${(await r.text()).slice(0, 200)}`);
    status = { at, ok: true, range: `${start}~${end}` };
  } catch (e) {
    status = { at, ok: false, error: String((e && e.message) || e).slice(0, 300) };
    console.error('weekly link report failed', source, status.error);
  }
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(REPORT_STATUS_KEY).first();
  let all = {};
  try { all = row && row.value ? JSON.parse(row.value) : {}; } catch (e) { all = {}; }
  all[source] = status;
  await env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(REPORT_STATUS_KEY, JSON.stringify(all), at).run();
  return status;
}

// 네이버 플레이스 홈 페이지에서 가게 등록 사진 목록을 뽑는다 (카드 만들기 사진 고르기용).
// data/fetch_photos.py 의 fetch() 와 같은 규칙: placeDetail 대표사진 → 등록사진(클립보다 사진 우선, 표시순서) — https 만.
async function fetchNaverPhotos(sid) {
  const res = await fetch(`https://m.place.naver.com/place/${sid}/home`, {
    headers: { 'User-Agent': NAVER_UA, 'Accept-Language': 'ko', 'Referer': 'https://map.naver.com/' },
    cf: { cacheTtl: 0 },
  });
  if (!res.ok) return { ok: false, error: 'naver ' + res.status, photos: [] };
  const html = await res.text();
  const m = html.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\});\s*\n/) || html.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*\})/);
  if (!m) return { ok: false, error: 'no state', photos: [] };
  let state;
  try { state = JSON.parse(m[1]); } catch (e) { return { ok: false, error: 'parse', photos: [] }; }
  const photos = [];
  const seen = new Set();
  const push = (u, type) => { if (u && u.startsWith('https://') && !seen.has(u)) { seen.add(u); photos.push({ url: u, type }); } };
  for (const [k, v] of Object.entries(state)) {
    if (k.startsWith('ROOT_QUERY') && v && typeof v === 'object') {
      for (const [kk, vv] of Object.entries(v)) if (kk.startsWith('placeDetail') && vv && vv.imageUrl) push(vv.imageUrl, 'main');
    }
  }
  // 2026-09 기준 필드: originalUrl/thumbnailUrl/mediaFormat(image|video)/mediaSource(business|clip|…). 구버전 origin/type 도 같이 본다.
  const items = Object.entries(state).filter(([k, v]) => k.startsWith('PlaceDetailTopPhotoItem:') && v && (v.originalUrl || v.origin)).map(([, v]) => v);
  const isVideo = v => v.mediaFormat === 'video' || v.type === 'clip' || !!v.video;
  items.sort((a, b) => (isVideo(a) - isVideo(b)) || ((a.no ?? 999) - (b.no ?? 999)));   // 사진 먼저, 그다음 원래 순서
  for (const it of items) if (!isVideo(it)) push(it.originalUrl || it.origin, it.mediaSource || it.type || 'photo');
  return { ok: true, photos: photos.slice(0, 40) };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    const db = env.DB;

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });

    try {
      // ── 공개 읽기 2종 (투숙객 페이지용 + 주간 빌드용) ──────────
      // 15초 메모리 캐시: 아무나 무한 새로고침해도 DB를 계속 두드리지 못하게 (무료한도 보호).
      // 어드민이 저장하면 pubCache 를 비우므로 편집 반영은 사실상 즉시.
      if ((path === '/public/data' || path === '/public/export') && req.method === 'GET') {
        const pubHdr = { 'Cache-Control': 'public, max-age=15' };
        const hit = pubCache[path];
        if (hit && Date.now() - hit.at < PUB_CACHE_MS) return json(req, hit.data, 200, pubHdr);

        const ov = await db.prepare('SELECT * FROM overrides').all();
        const man = await db.prepare('SELECT json FROM manual_places').all();
        let data;
        if (path === '/public/data') {
          const overrides = {};
          for (const r of ov.results) {
            const s = slimOverride(r);
            if (Object.keys(s).length) overrides[r.sid] = s;
          }
          data = { ov: overrides, manual: man.results.map(r => JSON.parse(r.json)) };
        } else {
          // build_places.py 가 기대하는 이름 키 형식 (하위 호환) — sid 도 같이 실어 이름 변경에 대비
          const legacy = {};
          for (const r of ov.results) {
            const o = {};
            if (r.exclude) o.exclude = true;
            if (r.reserve) o.reserve = true;
            if (r.pick) o.pick = true;
            if (r.takeout) o.takeout = true;
            if (r.notion) o.notion = true;
            if (r.natural != null) o.natural = !!r.natural;
            if (r.note) o.note = r.note;
            const a2 = parseAlso(r.also);
            if (a2.length) o.also = a2;
            if (Object.keys(o).length) { o.sid = r.sid; legacy[r.name] = o; }
          }
          data = { overrides: legacy, manual_places: man.results.map(r => JSON.parse(r.json)) };
        }
        pubCache[path] = { data, at: Date.now() };
        return json(req, data, 200, pubHdr);
      }

      // ── 공개: 사이트 문구·테마 (투숙객 페이지가 기본값 위에 덮어씀) ──
      // 캐시 정책은 /public/data 와 동일. 어드민 저장 시 pubCache 비워져 즉시 반영.
      // ── 공개: 추천 가게 모음 (picks.html, 2026-10-07) — 숨기지 않은 카드를 카드 날짜 최신순으로 ──────
      if (path === '/public/picks' && req.method === 'GET') {
        const rows = await db.prepare('SELECT day, sid, name, cat, target, card, thumb FROM picks WHERE hidden = 0 ORDER BY day DESC').all().then(r => r.results || []);
        const abs = k => !k ? '' : /^https?:/.test(k) ? k : `${url.origin}/public/card/${k}`;
        const picks = rows.map(r => ({ day: r.day, sid: r.sid, name: r.name, cat: r.cat, target: r.target, card: abs(r.card), thumb: abs(r.thumb) || abs(r.card) }));
        return json(req, { picks }, 200, { 'Cache-Control': 'public, max-age=300' });
      }

      if (path === '/public/settings' && req.method === 'GET') {
        const pubHdr = { 'Cache-Control': 'public, max-age=15' };
        const hit = pubCache[path];
        if (hit && Date.now() - hit.at < PUB_CACHE_MS) return json(req, hit.data, 200, pubHdr);
        const row = await db.prepare("SELECT value FROM settings WHERE key = 'site'").first();
        let data = {};
        if (row?.value) { try { data = JSON.parse(row.value); } catch { data = {}; } }
        pubCache[path] = { data, at: Date.now() };
        return json(req, data, 200, pubHdr);
      }

      // ── 공개: 카드 만들기 사진 중계 (2026-09-11) ──────────────
      // 네이버 사진(pstatic)은 CORS 헤더가 없어 브라우저가 캔버스로 PNG를 못 굽는다. 워커가 대신 받아
      // 허용 출처 헤더를 붙여 돌려준다. 네이버 이미지 호스트만 허용(열린 프록시 방지) + 엣지 캐시 + 횟수 제한.
      if (path === '/public/img' && req.method === 'GET') {
        let target;
        try { target = new URL(url.searchParams.get('u') || ''); } catch (e) { return json(req, { ok: false, error: 'bad url' }, 400); }
        if (target.protocol !== 'https:' || !IMG_HOST_RE.test(target.hostname)) return json(req, { ok: false, error: 'host not allowed' }, 403);
        const cache = caches.default;
        const cacheKey = new Request(target.href, { method: 'GET' });
        let up = await cache.match(cacheKey);
        if (!up) {
          const ip = req.headers.get('CF-Connecting-IP') || 'local';
          if (await overLimit(db, 'img@' + ip, IMG_LIMIT)) return json(req, { ok: false, error: 'too many' }, 429);
          const r = await fetch(target.href, { headers: { 'User-Agent': NAVER_UA, 'Referer': 'https://map.naver.com/' } });
          if (!r.ok) return json(req, { ok: false, error: 'upstream ' + r.status }, 502);
          up = new Response(r.body, { status: 200, headers: { 'Content-Type': r.headers.get('Content-Type') || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } });
          if (ctx) ctx.waitUntil(cache.put(cacheKey, up.clone()));
        }
        const h = new Headers(up.headers);
        for (const [k, v] of Object.entries(corsHeaders(req))) h.set(k, v);
        return new Response(up.body, { status: 200, headers: h });
      }

      // ── 공개: 네이버 등록 사진 목록 (카드 만들기 사진 고르기) ──────
      // 네이버가 클라우드 IP 를 막을 수 있어 실패해도 ok:false 로 조용히 돌려주고, 화면은 대표 사진만으로 계속 간다.
      if (path === '/public/naver-photos' && req.method === 'GET') {
        const sid = url.searchParams.get('sid') || '';
        if (!/^\d{5,15}$/.test(sid)) return json(req, { ok: false, error: 'bad sid', photos: [] }, 400);
        const ck = 'np:' + sid;
        const hit = pubCache[ck];
        if (hit && Date.now() - hit.at < NAVER_PHOTO_CACHE_MS) return json(req, hit.data);
        const ip = req.headers.get('CF-Connecting-IP') || 'local';
        if (await overLimit(db, 'np@' + ip, NAVER_PHOTO_LIMIT)) return json(req, { ok: false, error: 'too many', photos: [] }, 429);
        let data;
        try { data = await fetchNaverPhotos(sid); } catch (e) { data = { ok: false, error: String(e && e.message || e), photos: [] }; }
        if (data.ok) pubCache[ck] = { data, at: Date.now() };   // 실패는 캐시하지 않음 (일시 차단이면 다음 요청에 재시도)
        return json(req, data);
      }

      // ── 공개: 카드 이미지 서빙 (카드 만들기 → 트립코스 발송분, KV 보관) ──────
      // 슬랙은 사진을 보여주기 전에 HEAD(내용만 확인하는 요청)로 이 주소가 진짜 사진인지 먼저 묻는다.
      // GET 만 받던 동안 HEAD 에는 JSON 404 가 나갔고, 그래서 슬랙이 사진 블록을 invalid_blocks 로 거부하고
      // 첨부 방식으로 보내도 사진이 안 보였다(2026-09-19 확인). → HEAD 도 같은 헤더로 받아준다.
      if (path.startsWith('/public/card/') && (req.method === 'GET' || req.method === 'HEAD')) {
        if (!env.CARDS) return json(req, { ok: false, error: 'CARDS 미설정' }, 501);
        const key = path.slice('/public/card/'.length);
        if (!/^[0-9a-zA-Z._-]{8,80}$/.test(key)) return json(req, { ok: false, error: 'bad key' }, 400);
        // 슬랙은 메시지를 받은 직후 이 주소로 사진을 가지러 온다. KV 를 매번 읽으면 1초 가까이 걸려
        // 슬랙이 기다려주지 않고 거부하는 일이 있었다 → 엣지 캐시에 올려 두 번째부터는 즉시 내려준다.
        const imgCache = caches.default;
        const cacheReq = new Request(req.url, { method: 'GET' });   // 캐시는 GET 으로만 넣고 뺄 수 있다
        const cached = await imgCache.match(cacheReq);
        // 슬랙이 사진을 가지러 왔을 때 무엇을 받아갔는지 남긴다(settings.card_fetch_log, 최근 30건) — 다음에 안 보일 때 원인을 볼 수 있게
        const ua = req.headers.get('User-Agent') || '';
        const noteFetch = (status, from) => {
          if (!ctx || !/slack/i.test(ua)) return;
          ctx.waitUntil((async () => {
            const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('card_fetch_log').first().catch(() => null);
            let log = []; try { log = JSON.parse((row && row.value) || '[]'); } catch (e) { log = []; }
            log.unshift({ at: new Date().toISOString(), key, method: req.method, status, from, ua: ua.slice(0, 40), colo: (req.cf && req.cf.colo) || '' });
            await db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
              .bind('card_fetch_log', JSON.stringify(log.slice(0, 30)), new Date().toISOString()).run();
          })().catch(() => {}));
        };
        if (cached) { noteFetch(200, 'cache'); return req.method === 'HEAD' ? new Response(null, { status: 200, headers: cached.headers }) : cached; }
        let value = null, metadata = null, from = 'r2';
        // 읽는 순서: R2(2026-09-19 이후 새 카드) → KV(예전 카드) → D1 사본(KV 가 아직 안 퍼진 직후)
        if (env.CARD_R2) {
          const obj = await env.CARD_R2.get(key).catch(() => null);
          if (obj) { value = await obj.arrayBuffer(); metadata = { type: (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg' }; }
        }
        if (!value && env.CARDS) { ({ value, metadata } = await env.CARDS.getWithMetadata(key, { type: 'arrayBuffer' })); from = 'kv'; }
        if (!value) {
          // 워커가 KV 에 막 저장한 키는 슬랙이 미국(IAD)에서 가져갈 때 몇 초~수십 초 동안 안 보인다(KV 는 최종 일관성).
          // 2026-09-19 22:00 실제 발송에서 새 키 3개가 연달아 IAD 에서 404 → invalid_blocks. 그래서 발송 때 같은 사진을
          // D1(어디서 읽어도 즉시 보이는 단일 DB)에도 조각으로 넣어 두고, KV 에 없으면 D1 에서 꺼내 준다.
          const rows = await db.prepare('SELECT idx, type, data FROM card_blobs WHERE key = ? ORDER BY idx').bind(key).all().then(r => r.results || []).catch(() => []);
          if (rows.length) {
            const parts = rows.map(r => new Uint8Array(r.data));
            const joined = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
            let off = 0; for (const p of parts) { joined.set(p, off); off += p.byteLength; }
            value = joined.buffer; metadata = { type: rows[0].type || 'image/jpeg' }; from = 'd1';
          }
        }
        if (!value) { noteFetch(404, from); return json(req, { ok: false, error: 'not found' }, 404); }
        const headers = { 'Content-Type': (metadata && metadata.type) || 'image/jpeg', 'Content-Length': String(value.byteLength), 'Cache-Control': 'public, max-age=31536000, immutable', ...corsHeaders(req) };
        const cardResp = new Response(value, { status: 200, headers });
        if (ctx) ctx.waitUntil(imgCache.put(cacheReq, cardResp.clone()));
        noteFetch(200, from);
        return req.method === 'HEAD' ? new Response(null, { status: 200, headers }) : cardResp;
      }

      // ── 공개: 카드 만들기 기본 문구 (card-maker.html 이 열릴 때 읽음) ──────
      if (path === '/public/card-defaults' && req.method === 'GET') {
        if (!env.CARDS) return json(req, {});
        const hit = pubCache['card-defaults'];
        if (hit && Date.now() - hit.at < PUB_CACHE_MS) return json(req, hit.data, 200, { 'Cache-Control': 'no-store' });
        let data = {};
        try { data = (await env.CARDS.get(CARD_TPL_KV, { type: 'json' })) || {}; } catch (e) { data = {}; }
        pubCache['card-defaults'] = { data, at: Date.now() };
        return json(req, data, 200, { 'Cache-Control': 'no-store' });
      }

      // ── 공개: 카드 링크 주간 보고 실행 결과 (PC 루틴 감시가 읽음) ──────
      if (path === '/public/report-status' && req.method === 'GET') {
        const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(REPORT_STATUS_KEY).first();
        let data = {};
        try { data = row && row.value ? JSON.parse(row.value) : {}; } catch (e) { data = {}; }
        return json(req, { cron: data.cron || null, manual: data.manual || null }, 200, { 'Cache-Control': 'no-store' });
      }

      // ── 공개: 카드 링크 거쳐 가기 (2026-09-15) ──────
      // 카드 만들기에서 보내거나 복사한 가게 링크. 1회 기록하고 네이버 지도로 넘긴다.
      // 기록은 응답 뒤에 해서(waitUntil) 넘어가는 속도에 영향이 없게 하고, 미리보기 봇은 넘겨주기만 한다.
      if (path.startsWith('/go/') && (req.method === 'GET' || req.method === 'HEAD')) {
        const notFound = () => new Response('링크를 찾을 수 없어요.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        const id = path.slice('/go/'.length);
        if (!/^[0-9A-Za-z]{6,12}$/.test(id)) return notFound();
        const row = await db.prepare('SELECT target FROM card_links WHERE id = ?').bind(id).first();
        if (!row) return notFound();
        const ua = req.headers.get('User-Agent') || '';
        if (req.method === 'GET' && ua && !PREVIEW_BOT_RE.test(ua)) {
          const ip = req.headers.get('CF-Connecting-IP') || 'local';
          const record = (async () => {
            if (await overLimit(db, 'go@' + ip, GO_LIMIT)) return;
            const day = kstDay();
            const visitor = await visitorHash(env, day, req);
            await db.prepare('INSERT INTO card_link_hits (id, day, visitor, n) VALUES (?, ?, ?, 1) ON CONFLICT(id, day, visitor) DO UPDATE SET n = n + 1')
              .bind(id, day, visitor).run();
          })().catch(e => console.error('card link hit record failed', id, e && e.message));
          if (ctx) ctx.waitUntil(record); else await record;
        }
        return new Response(null, { status: 302, headers: { Location: row.target, 'Cache-Control': 'no-store' } });
      }

      // ── 공개: 조회수 집계 (손님 페이지 로드 시 1회) ──────────
      // 브라우저당 하루 1회는 프론트(localStorage)에서 거른다. KST 날짜별로 누적.
      if (path === '/view' && req.method === 'POST') {
        const ip = req.headers.get('CF-Connecting-IP') || 'local';
        if (await overLimit(db, 'view@' + ip, VIEW_LIMIT)) return json(req, { ok: true });   // 초과 시 집계 생략(응답은 동일)
        let b = {}; try { b = await req.json(); } catch { /* 홈(body 없음)은 그대로 진행 */ }
        const day = kstDay();
        const table = b && b.page === 'course' ? 'course_views' : 'pageviews';
        await db.prepare(`INSERT INTO ${table} (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1`).bind(day).run();
        return json(req, { ok: true });
      }

      // ── 공개: 화면 UI 이벤트(탭 전환·하단 모음 열람) 집계 ──────
      if (path === '/event' && req.method === 'POST') {
        const ip = req.headers.get('CF-Connecting-IP') || 'local';
        if (await overLimit(db, 'event@' + ip, IMPRESSION_LIMIT)) return json(req, { ok: true });
        let b; try { b = await req.json(); } catch { return json(req, { ok: true }); }
        const key = String(b.key || '');
        if (!/^[a-z0-9:_-]{1,40}$/i.test(key)) return json(req, { ok: true });   // 허용 형식 아니면 조용히 무시
        await db.prepare('INSERT INTO ui_events (key, n) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET n = n + 1').bind(key).run();
        return json(req, { ok: true });
      }

      // ── 공개: 가게 클릭 집계 (카드의 '네이버 지도에서 보기' 클릭) ──
      if (path === '/click' && req.method === 'POST') {
        const ip = req.headers.get('CF-Connecting-IP') || 'local';
        if (await overLimit(db, 'click@' + ip, CLICK_LIMIT)) return json(req, { ok: true });
        let b; try { b = await req.json(); } catch { return json(req, { ok: true }); }
        const key = String(b.sid || b.name || '').slice(0, 80).trim();
        if (!key) return json(req, { ok: true });
        const name = String(b.name || '').slice(0, 100);
        await db.prepare('INSERT INTO place_clicks (key, name, n) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET n = n + 1, name = excluded.name')
          .bind(key, name).run();
        await db.prepare('INSERT INTO click_hours (hour, n) VALUES (?, 1) ON CONFLICT(hour) DO UPDATE SET n = n + 1')
          .bind(kstHour()).run();
        await db.prepare('INSERT INTO place_clicks_daily (day, key, name, n) VALUES (?, ?, ?, 1) ON CONFLICT(day, key) DO UPDATE SET n = n + 1, name = excluded.name')
          .bind(kstDay(), key, name).run();
        return json(req, { ok: true });
      }

      // ── 공개: 가게 노출 집계 (추천 리스트에 보여진 가게들, 렌더마다 배치) ──
      // 클릭÷노출 = CTR. 손님만(프론트가 어드민 제외), 한 요청에 여러 가게(최대 10).
      if (path === '/impression' && req.method === 'POST') {
        const ip = req.headers.get('CF-Connecting-IP') || 'local';
        if (await overLimit(db, 'imp@' + ip, IMPRESSION_LIMIT)) return json(req, { ok: true });
        let b; try { b = await req.json(); } catch { return json(req, { ok: true }); }
        const items = Array.isArray(b.items) ? b.items.slice(0, 10) : [];
        const stmts = [];
        const seen = new Set();
        for (const it of items) {
          const key = String((it && (it.sid || it.name)) || '').slice(0, 80).trim();
          if (!key || seen.has(key)) continue;                  // 같은 렌더 내 중복 방지
          seen.add(key);
          const name = String((it && it.name) || '').slice(0, 100);
          stmts.push(db.prepare('INSERT INTO place_impressions (key, name, n) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET n = n + 1, name = excluded.name').bind(key, name));
          stmts.push(db.prepare('INSERT INTO place_impressions_daily (day, key, name, n) VALUES (?, ?, ?, 1) ON CONFLICT(day, key) DO UPDATE SET n = n + 1, name = excluded.name').bind(kstDay(), key, name));
        }
        if (stmts.length) await db.batch(stmts);
        return json(req, { ok: true });
      }

      // ── 공개: 피드백 수신 → 슬랙 (구 Apps Script 대체) ─────────
      if (path === '/feedback' && req.method === 'POST') {
        const ok = json(req, { ok: true });          // 스팸/거절도 동일 응답 (정보 노출 방지)
        let data;
        try { data = await req.json(); } catch { return ok; }
        if (data.t !== env.FB_TOKEN) return ok;                       // (1) 토큰 검증

        // 서비스 별점 평가 (kind: 'rating') — DB 보관(집계용) + 슬랙 알림
        if (data.kind === 'rating') {
          const score = Math.round(Number(data.score));
          if (!(score >= 1 && score <= 5)) return ok;
          const rMemo = String(data.memo || '').slice(0, 300).trim();
          if (await overLimit(db, 'fb', FB_LIMIT)) return ok;
          await db.prepare('INSERT INTO ratings (score, memo, at) VALUES (?, ?, ?)')
            .bind(score, rMemo, new Date().toISOString()).run();
          const rText = '⭐ 트립코스 서비스 평가: ' + '★'.repeat(score) + '☆'.repeat(5 - score) + ` (${score}/5)`
            + (rMemo ? '\n• 한줄: ' + slackEsc(rMemo) : '');
          try {
            await fetch(env.SLACK_WEBHOOK, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: rText, username: SLACK_BOT_NAME }),
            });
          } catch (e) { console.error('슬랙 전송 실패:', e.message); }
          return ok;
        }

        // 좋았던 곳 직접 추천 (kind: 'suggest') — 리스트에 없는 가게 제보
        if (data.kind === 'suggest') {
          const sPlace = String(data.place || '').slice(0, 100).trim();
          if (!sPlace) return ok;
          const sMemo = String(data.memo || '').slice(0, 500).trim();
          const sName = String(data.name || '').slice(0, 40).trim();
          if (await overLimit(db, 'fb', FB_LIMIT)) return ok;
          const sText = '💚 투숙객 가게 추천\n'
            + '• 가게: ' + slackEsc(sPlace) + '\n'
            + (sMemo ? '• 좋았던 점: ' + slackEsc(sMemo) + '\n' : '')
            + (sName ? '• 성함: ' + slackEsc(sName) + '\n' : '')
            + '• 시각: ' + slackEsc(String(data.at || '').slice(0, 30));
          try {
            await fetch(env.SLACK_WEBHOOK, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: sText, username: SLACK_BOT_NAME }),
            });
          } catch (e) { console.error('슬랙 전송 실패:', e.message); }
          return ok;
        }

        const place = String(data.place || '').slice(0, 100);
        const memo = String(data.memo || '').slice(0, 500).trim();
        if (!memo) return ok;                                          // (2) 입력 검증
        if (await overLimit(db, 'fb', FB_LIMIT)) return ok;            // (3) 횟수 제한
        await db.prepare('INSERT INTO feedback (place, memo, at) VALUES (?, ?, ?)')
          .bind(place, memo, new Date().toISOString()).run();
        const text = '📝 트립코스 피드백\n'
          + '• 가게: ' + (slackEsc(place) || '(미지정)') + '\n'
          + '• 내용: ' + slackEsc(memo) + '\n'
          + '• 시각: ' + slackEsc(String(data.at || '').slice(0, 30));
        try {
          await fetch(env.SLACK_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, username: SLACK_BOT_NAME }),
          });
        } catch (e) {
          console.error('슬랙 전송 실패:', e.message);   // 실패해도 응답은 동일 (내부 상태 노출 안 함)
        }
        return ok;
      }

      // ── 어드민: 로그인 ───────────────────────────────────────
      if (path === '/login' && req.method === 'POST') {
        // IP별 제한 — 남이 로그인 시도를 퍼부어도 어드민 본인은 안 잠기게
        const ip = req.headers.get('CF-Connecting-IP') || 'local';
        if (await overLimit(db, 'login@' + ip, LOGIN_LIMIT)) {
          return json(req, { error: '시도가 너무 많아요. 10분 뒤 다시 해주세요.' }, 429);
        }
        let body;
        try { body = await req.json(); } catch { return json(req, { error: '형식 오류' }, 400); }
        if (!body.password || body.password !== env.ADMIN_PASSWORD) {
          return json(req, { error: '비밀번호가 맞지 않아요.' }, 401);
        }
        const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
        const now = new Date().toISOString();
        await db.prepare('INSERT INTO sessions (token, created_at) VALUES (?, ?)').bind(token, now).run();
        // 만료 세션·오래된 카운터 청소 (로그인 때마다 가볍게)
        // created_at 은 ISO 형식('...T...Z')이라 SQLite datetime()과 문자열 형식이 달라,
        // 기준 시각도 JS에서 같은 ISO 로 만들어 비교 (형식 불일치로 인한 경계일 오차 방지)
        const cutoff = new Date(Date.now() - SESSION_DAYS * 86400 * 1000).toISOString();
        await db.prepare('DELETE FROM sessions WHERE created_at < ?').bind(cutoff).run();
        // 카운터 키는 '2026-07-06T08:1|fb' 꼴 — 맨 앞 날짜가 어제보다 오래되면 삭제
        await db.prepare(
          "DELETE FROM rate_counters WHERE substr(bucket, 1, 10) < date('now', '-1 day')"
        ).run();
        return json(req, { token });
      }

      // ── 여기부터는 로그인 필요 ────────────────────────────────
      if (path.startsWith('/admin/') || path === '/logout' || path === '/card/send' || path === '/card/link' || path.startsWith('/card/drafts') || path === '/card/defaults') {
        if (!(await checkAuth(req, db))) return json(req, { error: '로그인이 필요해요.' }, 401);
      }

      // ── 카드 만들기: 확정한 카드를 트립코스 슬랙으로 보내기 (2026-09-11) ──────
      // 사용자가 card-maker.html 에서 만든 이미지를 KV 에 보관하고, 그 공개 주소를 incoming webhook 의
      // image 블록으로 붙여 보낸다(웹훅은 파일 업로드가 안 되므로 daily_pick.py 와 같은 방식).
      // 매일 11시 자동 추천(GS_DailyPick)은 이날부로 끄고 이 수동 발송으로 대체.
      if (path === '/card/send' && req.method === 'POST') {
        if (!env.CARDS) return json(req, { ok: false, error: 'CARDS(KV) 미설정' }, 501);
        if (!env.CARD_WEBHOOK) return json(req, { ok: false, error: 'CARD_WEBHOOK 미설정' }, 501);
        const ip = req.headers.get('CF-Connecting-IP') || 'local';
        if (await overLimit(db, 'cardsend@' + ip, CARD_SEND_LIMIT)) return json(req, { ok: false, error: '발송이 너무 잦아요. 10분 뒤 다시 해주세요.' }, 429);
        let form;
        try { form = await req.formData(); } catch (e) { return json(req, { ok: false, error: '형식 오류' }, 400); }
        const file = form.get('image');
        const text = String(form.get('text') || '').trim().slice(0, 2000);
        const name = String(form.get('name') || '').trim().slice(0, 80);
        // 추천 가게 모음용(2026-10-07): 카드에 찍힌 날짜(묶음으로 미리 보내면 보낸 날과 다르다)·업종·목록용 작은 그림
        const day = /^\d{4}-\d{2}-\d{2}$/.test(String(form.get('day') || '')) ? String(form.get('day')) : kstDay();
        const cat = String(form.get('cat') || '').trim().slice(0, 40);
        const thumbFile = form.get('thumb');
        if (!file || typeof file === 'string' || !file.size) return json(req, { ok: false, error: '이미지가 없어요' }, 400);
        if (file.size > CARD_MAX_BYTES) return json(req, { ok: false, error: '이미지가 너무 커요 (6MB 초과)' }, 413);
        if (!text) return json(req, { ok: false, error: '보낼 문구가 비어 있어요' }, 400);
        const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        const bytes = await file.arrayBuffer();
        // 같은 사진을 새 주소로 다시 저장할 수 있게 함수로 둔다 — 슬랙은 한 번 거부한 주소를 고친 뒤에도 계속 거부하므로(2026-09-19 실측) 재시도는 새 주소여야 한다
        const storeCard = async () => {
          const k = `${kstDay()}-${crypto.randomUUID().slice(0, 8)}.${type === 'image/png' ? 'png' : 'jpg'}`;
          storedKeys.push(k);
          const at = new Date().toISOString();
          // R2 가 연결돼 있으면 거기 한 곳에만 넣는다 — R2 는 어느 지역에서 읽어도 저장 직후 바로 보인다(강한 일관성).
          // 보관 기간은 버킷 수명 규칙(180일)이 맡는다. 예전 카드는 아래 KV/D1 경로로 계속 읽힌다.
          if (env.CARD_R2) {
            await env.CARD_R2.put(k, bytes, { httpMetadata: { contentType: type }, customMetadata: { name: name.slice(0, 80), at } });
            return k;
          }
          // (R2 없을 때) KV(장기 보관·엣지 캐시) + D1(즉시 보이는 사본, 조각 200KB) 두 곳에 넣는다. 슬랙은 보낸 직후 미국에서 가져가는데
          // KV 는 거기서 몇 초~수십 초 뒤에야 보여서 404 → 거부됐다(2026-09-19 22:00 실측). D1 사본은 7일 뒤 지운다(그때면 KV 가 다 퍼져 있다).
          const CHUNK = 200 * 1024, stmts = [];
          for (let i = 0, idx = 0; i < bytes.byteLength; i += CHUNK, idx++) {
            stmts.push(db.prepare('INSERT INTO card_blobs (key, idx, type, data, created_at) VALUES (?, ?, ?, ?, ?)').bind(k, idx, type, bytes.slice(i, i + CHUNK), at));
          }
          await Promise.all([
            env.CARDS.put(k, bytes, { metadata: { type, name, at } }),   // 기한 없음
            db.batch(stmts).catch(e => { d1Err = String(e && e.message || e).slice(0, 120); }),   // D1 사본 실패는 발송을 막지 않고 기록만
          ]);
          return k;
        };
        let d1Err = '';
        const storedKeys = [];   // 저장한 키 전부 — 재시도로 버려진 키는 발송 뒤 지운다(기한이 없어졌으므로)
        // 7일 지난 D1 사본 정리 (발송 때마다 한 번, 실패해도 발송엔 영향 없음)
        if (ctx) ctx.waitUntil(db.prepare("DELETE FROM card_blobs WHERE created_at < datetime('now', '-7 days')").run().catch(() => {}));
        let key = await storeCard();
        const firstKey = key;
        let imageUrl = `${url.origin}/public/card/${key}`;
        // 문구 속 네이버 링크를 클릭 수를 세는 /go/ 주소로 바꾼다 (사용자가 링크를 지웠으면 그대로 보냄)
        const link = String(form.get('link') || '').trim();
        let linkId = null, sendText = text;
        if (link && text.includes(link)) {
          linkId = await createCardLink(db, { target: link, sid: form.get('sid'), name, source: 'send', card: key });
          if (linkId) sendText = text.split(link).join(`${url.origin}/go/${linkId}`);
        }
        // 슬랙 전송 — 2026-09-18 부터 사진(image) 블록이 담긴 메시지를 슬랙이 invalid_blocks 로 거부하기 시작했다.
        //   · 9/17 09:29 까지는 같은 형식이 정상 발송됐고, 워커는 9/15 이후 배포된 적이 없다(코드 변경 아님).
        //   · 1차 원래 형식 → 거부되면 1.5초 쉬고 2차로 같은 형식 재시도(거부가 간헐적이다) → 그래도 안 되면 3차로 첨부(attachments) 방식.
        //     글만 보내는 우회는 쓰지 않는다 — 슬랙이 사진 주소를 안 펼쳐서 카드가 안 보였다(2026-09-19 12:10 실제 발생).
        //   · 어느 쪽으로 나갔는지와 거부 사유는 settings 에 남겨 나중에 원인을 볼 수 있게 한다.
        const postSlack = (body) => fetch(env.CARD_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const withImage = () => ({
          text: sendText,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: sendText } },
            { type: 'image', image_url: imageUrl, alt_text: name || '고성 추천 카드' },
          ],
        });
        // 사진이 안 보이면 카드의 의미가 없다. 글만 보내는 우회는 실패로 본다(2026-09-19 실측: 슬랙이 주소를 안 펼쳐 글만 나갔다).
        const asAttachment = () => ({
          text: sendText,
          attachments: [{ fallback: name || '고성 추천 카드', image_url: imageUrl, color: '#b23bd6' }],
        });
        const sleep = (ms) => new Promise(s => setTimeout(s, ms));
        // 슬랙은 메시지를 받자마자 미국(IAD)·일본(NRT)에서 사진 주소를 직접 가져가 확인한다(2026-09-19 서버 로그 실측).
        // 거부되면 같은 주소는 다시 보내도 계속 거부되므로, 새 주소로 다시 저장해 최대 2번 더 보낸다(2초·4초 간격).
        const errs = [];
        let r = await postSlack(withImage());
        let mode = 'image-block';
        for (let n = 1; !r.ok && n <= 2; n++) {
          errs.push(`${r.status} ${(await r.text()).slice(0, 80)}`);
          await sleep(2000 * n);
          key = await storeCard(); imageUrl = `${url.origin}/public/card/${key}`;
          r = await postSlack(withImage());
          if (r.ok) mode = `image-block(새 주소로 ${n}번째 재시도 성공)`;
        }
        if (!r.ok) {
          errs.push(`${r.status} ${(await r.text()).slice(0, 80)}`);
          r = await postSlack(asAttachment());              // 마지막: 첨부 방식
          mode = r.ok ? 'attachment(블록 거부됨)' : '실패';
        }
        const firstErr = errs.join(' → ');
        // 새 주소로 나갔으면 어드민 링크 목록의 카드 키도 맞춰 둔다
        if (r.ok && linkId && key !== firstKey) await db.prepare('UPDATE card_links SET card = ? WHERE id = ?').bind(key, linkId).run().catch(() => {});
        await db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
          .bind('card_send_last', JSON.stringify({ at: new Date().toISOString(), mode, firstErr, d1Err, imageUrl, ok: r.ok }), new Date().toISOString())
          .run().catch(() => {});
        if (!r.ok) {
          const body2 = (await r.text()).slice(0, 200);
          // 안 나간 카드의 링크가 어드민 목록에 '보냄'으로 남지 않게 지운다
          if (linkId) await db.prepare('DELETE FROM card_links WHERE id = ?').bind(linkId).run();
          return json(req, { ok: false, error: `슬랙 발송 실패 (${r.status}) ${body2}${firstErr ? ' / 1차: ' + firstErr : ''}`, imageUrl }, 502);
        }
        // 추천 가게 모음(picks.html)에 넣는다 — 같은 날짜 카드를 다시 보내면 마지막 것이 이전 것을 대신한다(수정본 재발송)
        let thumbKey = '';
        if (thumbFile && typeof thumbFile !== 'string' && thumbFile.size && thumbFile.size <= CARD_MAX_BYTES) {
          thumbKey = key.replace(/\.(jpe?g|png)$/i, '') + '-s.jpg';
          await env.CARDS.put(thumbKey, await thumbFile.arrayBuffer(), { metadata: { type: 'image/jpeg', name, at: new Date().toISOString() } }).catch(() => { thumbKey = ''; });
        }
        let pickTarget = '';
        try { const t = new URL(link); if (t.protocol === 'https:' && GO_HOST_RE.test(t.hostname)) pickTarget = t.href.slice(0, 500); } catch (e) { /* 네이버 주소가 아니면 비워 둔다 */ }
        let pickErr = '';
        await db.prepare('INSERT INTO picks (day, sid, name, cat, target, card, thumb, hidden, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?) '
          + 'ON CONFLICT(day) DO UPDATE SET sid = excluded.sid, name = excluded.name, cat = excluded.cat, target = excluded.target, card = excluded.card, thumb = excluded.thumb, hidden = 0, sent_at = excluded.sent_at')
          .bind(day, String(form.get('sid') || '').slice(0, 20), name, cat, pickTarget, key, thumbKey, new Date().toISOString()).run()
          .catch(e => { pickErr = String(e && e.message || e).slice(0, 120); console.error('picks upsert:', pickErr); });
        if (ctx) ctx.waitUntil(Promise.all(storedKeys.filter(k => k !== key).map(k => env.CARDS.delete(k).catch(() => {}))));
        return json(req, { ok: true, mode, imageUrl, goUrl: linkId ? `${url.origin}/go/${linkId}` : null, pick: { day, thumb: thumbKey, error: pickErr } });
      }

      // ── 카드 만들기: '복사' 버튼용 추적 링크 만들기 (2026-09-15) ──────
      if (path === '/card/link' && req.method === 'POST') {
        const ip = req.headers.get('CF-Connecting-IP') || 'local';
        if (await overLimit(db, 'cardlink@' + ip, DRAFT_LIMIT)) return json(req, { ok: false, error: '너무 잦아요. 10분 뒤 다시 해주세요.' }, 429);
        let b;
        try { b = await req.json(); } catch (e) { return json(req, { ok: false, error: '형식 오류' }, 400); }
        const id = await createCardLink(db, { target: b.link, sid: b.sid, name: b.name, source: 'copy', card: '' });
        if (!id) return json(req, { ok: false, error: '네이버 지도 주소만 쓸 수 있어요' }, 400);
        return json(req, { ok: true, id, url: `${url.origin}/go/${id}` });
      }

      // ── 카드 만들기: 임시저장 (서버 보관 — 폰·PC 어디서든 이어서 편집, 2026-09-11) ──────
      // KV 키 'draft/<id>' 에 편집 상태(JSON)를 통째로 보관. 목록은 metadata(이름·시각)만 읽는다.
      // KV 목록은 반영이 수십 초 늦을 수 있어(최종 일관성) 화면 쪽에서 저장 직후엔 목록을 직접 갱신한다.
      if (path === '/card/drafts' && req.method === 'GET') {
        if (!env.CARDS) return json(req, { ok: false, error: 'CARDS(KV) 미설정' }, 501);
        const ip = req.headers.get('CF-Connecting-IP') || 'local';
        if (await overLimit(db, 'draft@' + ip, DRAFT_LIMIT)) return json(req, { ok: false, error: '요청이 너무 잦아요. 10분 뒤 다시 해주세요.' }, 429);
        const list = await env.CARDS.list({ prefix: 'draft/', limit: 200 });
        const drafts = list.keys.map(k => ({ id: k.name.slice('draft/'.length), ...(k.metadata || {}) }))
          .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
        return json(req, { ok: true, drafts });
      }
      if (path.startsWith('/card/drafts/') && ['GET', 'PUT', 'DELETE'].includes(req.method)) {
        if (!env.CARDS) return json(req, { ok: false, error: 'CARDS(KV) 미설정' }, 501);
        const id = path.slice('/card/drafts/'.length);
        if (!/^[0-9a-zA-Z_-]{6,60}$/.test(id)) return json(req, { ok: false, error: 'bad id' }, 400);
        const ip = req.headers.get('CF-Connecting-IP') || 'local';
        if (await overLimit(db, 'draft@' + ip, DRAFT_LIMIT)) return json(req, { ok: false, error: '요청이 너무 잦아요. 10분 뒤 다시 해주세요.' }, 429);
        const key = 'draft/' + id;
        if (req.method === 'GET') {
          const v = await env.CARDS.get(key, { type: 'text' });
          if (!v) return json(req, { ok: false, error: 'not found' }, 404);
          return new Response(v, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(req) } });
        }
        if (req.method === 'DELETE') { await env.CARDS.delete(key); return json(req, { ok: true }); }
        const raw = await req.text();
        if (raw.length > DRAFT_MAX_BYTES) return json(req, { ok: false, error: '임시저장이 너무 커요 (4MB 초과)' }, 413);
        let state;
        try { state = JSON.parse(raw); } catch (e) { return json(req, { ok: false, error: '형식 오류' }, 400); }
        const at = new Date().toISOString();
        const title = String(state.title || state.name || '').slice(0, 60);
        await env.CARDS.put(key, raw, { expirationTtl: DRAFT_TTL_SEC, metadata: { title, place: String(state.placeName || '').slice(0, 40), at } });
        return json(req, { ok: true, id, at, title });
      }

      // ── 카드 만들기: 기본 문구 저장 (로그인 필요) ──────
      if (path === '/card/defaults' && req.method === 'PUT') {
        if (!env.CARDS) return json(req, { ok: false, error: 'CARDS(KV) 미설정' }, 501);
        let body;
        try { body = await req.json(); } catch (e) { return json(req, { ok: false, error: '형식 오류' }, 400); }
        const clean = {};
        for (const k of CARD_TPL_KEYS) if (typeof body[k] === 'string') clean[k] = body[k].slice(0, 600);
        await env.CARDS.put(CARD_TPL_KV, JSON.stringify(clean));
        pubCache = {};   // 공개 읽기 캐시 비움 → 다른 기기에서 곧바로 새 문구
        return json(req, { ok: true, saved: Object.keys(clean).length });
      }

      if (path === '/logout' && req.method === 'POST') {
        const token = (req.headers.get('Authorization') || '').slice(7).trim();
        await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
        return json(req, { ok: true });
      }

      // 어드민: 사이트 스냅샷 재빌드 트리거 (GitHub Actions workflow_dispatch)
      // GH_TOKEN(fine-grained, 이 저장소 Actions write 전용)은 서버 비밀값 — 브라우저에 노출 안 됨
      if (path === '/admin/rebuild' && req.method === 'POST') {
        if (!env.GH_TOKEN) return json(req, { error: 'GH_TOKEN 미설정 — Cloudflare 대시보드에서 추가 필요' }, 501);
        const r = await fetch('https://api.github.com/repos/mgrv-company/gs-trip-course/actions/workflows/build.yml/dispatches', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + env.GH_TOKEN,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'gs-trip-admin-worker',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ref: 'main' }),
        });
        if (r.status === 204) return json(req, { ok: true });
        return json(req, { error: 'GitHub 응답 ' + r.status }, 502);
      }

      // 어드민: 전체 편집 데이터 (원본 그대로)
      if (path === '/admin/data' && req.method === 'GET') {
        const ov = await db.prepare('SELECT * FROM overrides ORDER BY updated_at DESC').all();
        const man = await db.prepare('SELECT * FROM manual_places ORDER BY updated_at DESC').all();
        return json(req, {
          overrides: ov.results,
          manual: man.results.map(r => ({ ...JSON.parse(r.json), _updated: r.updated_at })),
        });
      }

      // 어드민: 가게 편집 저장 (upsert — 모든 값이 비면 행 삭제)
      if (path === '/admin/override' && req.method === 'PUT') {
        const b = await req.json();
        if (!b.sid) return json(req, { error: 'sid 누락' }, 400);
        const flags = ['exclude', 'reserve', 'pick', 'takeout', 'notion'].map(k => (b[k] ? 1 : 0));
        const note = String(b.note || '').slice(0, 300);
        // natural: 3상태(null=자동분류 따름/true=자연명소/false=그 외로 수동지정) — 다른 플래그와 달리 0도 유효값
        const natural = b.natural === true ? 1 : b.natural === false ? 0 : null;
        // also: 추가 노출 섹션 목록. 허용된 type만 남기고 중복 제거 후 JSON 문자열로 저장.
        const ALSO_TYPES = ['식사', '카페', '술집', '명소', '해변'];
        const alsoArr = Array.isArray(b.also)
          ? [...new Set(b.also.filter(t => ALSO_TYPES.includes(t)))] : [];
        const also = alsoArr.length ? JSON.stringify(alsoArr) : '';
        const empty = flags.every(f => !f) && !note && natural === null && !also;
        if (empty) {
          await db.prepare('DELETE FROM overrides WHERE sid = ?').bind(String(b.sid)).run();
        } else {
          await db.prepare(`
            INSERT INTO overrides (sid, name, exclude, reserve, pick, takeout, notion, natural, note, also, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(sid) DO UPDATE SET
              name=excluded.name, exclude=excluded.exclude, reserve=excluded.reserve,
              pick=excluded.pick, takeout=excluded.takeout, notion=excluded.notion,
              natural=excluded.natural, note=excluded.note, also=excluded.also, updated_at=excluded.updated_at
          `).bind(String(b.sid), String(b.name || '').slice(0, 100),
                  ...flags, natural, note, also, new Date().toISOString()).run();
        }
        pubCache = {};   // 편집됐으니 공개 캐시 즉시 무효화 (즉시 반영 유지)
        return json(req, { ok: true });
      }

      // 어드민: 직접 추가 가게 저장/삭제
      if (path === '/admin/manual' && req.method === 'PUT') {
        const b = await req.json();
        const place = b.place;
        if (!place || !place.sid || !place.name) return json(req, { error: 'sid/name 누락' }, 400);
        await db.prepare(`
          INSERT INTO manual_places (sid, json, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(sid) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at
        `).bind(String(place.sid), JSON.stringify(place), new Date().toISOString()).run();
        pubCache = {};
        return json(req, { ok: true });
      }
      if (path === '/admin/manual' && req.method === 'DELETE') {
        const sid = url.searchParams.get('sid');
        if (!sid) return json(req, { error: 'sid 누락' }, 400);
        await db.prepare('DELETE FROM manual_places WHERE sid = ?').bind(sid).run();
        pubCache = {};
        return json(req, { ok: true });
      }

      // 어드민: 사이트 문구·테마 읽기
      if (path === '/admin/settings' && req.method === 'GET') {
        const row = await db.prepare("SELECT value FROM settings WHERE key = 'site'").first();
        let data = {};
        if (row?.value) { try { data = JSON.parse(row.value); } catch { data = {}; } }
        return json(req, data);
      }

      // 어드민: 사이트 문구·테마 저장 (검증 후 통째로 덮어씀)
      if (path === '/admin/settings' && req.method === 'PUT') {
        let b;
        try { b = await req.json(); } catch { return json(req, { error: '형식 오류' }, 400); }
        // 문구: 문자열만, 각 400자 제한, 빈 값은 저장 안 함(→ 프론트 기본값 fallback)
        const copy = {};
        if (b.copy && typeof b.copy === 'object') {
          for (const [k, v] of Object.entries(b.copy)) {
            if (typeof k !== 'string' || typeof v !== 'string') continue;
            const val = v.slice(0, 400);
            if (val.trim()) copy[k.slice(0, 40)] = val;
          }
        }
        // 테마: 강조색은 #rrggbb 형식만(CSS 주입 차단), 크기는 정해진 값만
        const theme = {};
        if (b.theme && typeof b.theme === 'object') {
          const acc = String(b.theme.accent || '');
          if (/^#[0-9a-fA-F]{6}$/.test(acc)) theme.accent = acc;
          const scale = String(b.theme.scale || '');
          if (['small', 'normal', 'large'].includes(scale)) theme.scale = scale;
        }
        const value = JSON.stringify({ copy, theme });
        if (value.length > 20000) return json(req, { error: '내용이 너무 커요.' }, 400);
        await db.prepare(`
          INSERT INTO settings (key, value, updated_at) VALUES ('site', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
        `).bind(value, new Date().toISOString()).run();
        pubCache = {};
        return json(req, { ok: true });
      }

      // 어드민: 디자인 코멘트 남기기 (메인 페이지에서 요소 클릭 → 메모)
      if (path === '/admin/annotations' && req.method === 'POST') {
        let b;
        try { b = await req.json(); } catch { return json(req, { error: '형식 오류' }, 400); }
        const note = String(b.note || '').slice(0, 1000).trim();
        if (!note) return json(req, { error: '메모가 비었어요.' }, 400);
        await db.prepare(
          'INSERT INTO annotations (target, label, note, page, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(
          String(b.target || '').slice(0, 300),
          String(b.label || '').slice(0, 300),
          note,
          String(b.page || '').slice(0, 60),
          'open',
          new Date().toISOString()
        ).run();
        return json(req, { ok: true });
      }

      // 어드민: 코멘트 목록 (기본 미완료 전체 = 작성/반영대기 — 목록 표시용)
      if (path === '/admin/annotations' && req.method === 'GET') {
        const all = url.searchParams.get('all') === '1';
        const rows = all
          ? await db.prepare('SELECT * FROM annotations ORDER BY created_at DESC').all()
          : await db.prepare("SELECT * FROM annotations WHERE status != 'done' ORDER BY created_at DESC").all();
        return json(req, { annotations: rows.results });
      }

      // 어드민: 반영 요청(전송) — open 코멘트를 ready 로 표시하고 #gs-routine 에 알림.
      // 실제 반영은 하루 1회 무인 실행이 ready 만 처리한다.
      if (path === '/admin/annotations/send' && req.method === 'POST') {
        const ip = req.headers.get('CF-Connecting-IP') || 'local';
        if (await overLimit(db, 'send@' + ip, SEND_LIMIT)) return json(req, { error: '잠시 후 다시 시도해주세요.' }, 429);
        const open = await db.prepare("SELECT label, note FROM annotations WHERE status = 'open'").all();
        const n = open.results.length;
        if (n === 0) return json(req, { count: 0 });
        await db.prepare("UPDATE annotations SET status = 'ready' WHERE status = 'open'").run();
        if (env.SLACK_WEBHOOK) {
          const lines = open.results.slice(0, 15)
            .map(r => '• ' + slackEsc(r.note) + (r.label ? '  _(' + slackEsc(String(r.label)).slice(0, 40) + ')_' : '')).join('\n');
          const text = '<@U0AG0G63PTR> 📌 *트립코스 디자인 코멘트 ' + n + '건 반영 요청됨*\n\n' + lines
            + '\n\n_다음 자동 반영 때 문구·색·크기는 자동 적용, 구조 변경은 검토 후 반영돼요._';
          try {
            await fetch(env.SLACK_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text, username: SLACK_BOT_NAME }) });
          } catch (e) { console.error('슬랙 전송 실패:', e.message); }
        }
        return json(req, { count: n });
      }

      // 어드민: 조회수 (오늘/누적/최근 일자별) — 나만 보기
      if (path === '/admin/views' && req.method === 'GET') {
        const day = kstDay();
        const total = await db.prepare('SELECT COALESCE(SUM(n),0) AS t FROM pageviews').first();
        const days = await db.prepare('SELECT day, n FROM pageviews ORDER BY day DESC LIMIT 30').all();
        const todayRow = days.results.find(r => r.day === day);   // 오늘치는 days 첫 구간에 이미 있음(별도 쿼리 불필요)
        return json(req, { total: total?.t || 0, today: todayRow ? todayRow.n : 0, days: days.results });
      }

      // 어드민: 서비스 별점 요약 (평균·분포·최근 낮은 평가) — 나만 보기
      if (path === '/admin/ratings' && req.method === 'GET') {
        const total = await db.prepare('SELECT COUNT(*) c, AVG(score) a FROM ratings').first();
        const distRows = await db.prepare('SELECT score, COUNT(*) c FROM ratings GROUP BY score').all();
        const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        for (const r of distRows.results) dist[r.score] = r.c;
        const low = await db.prepare('SELECT score, memo, at FROM ratings WHERE score <= 2 ORDER BY at DESC LIMIT 10').all();
        const recent = await db.prepare('SELECT score, memo, at FROM ratings ORDER BY at DESC LIMIT 200').all();
        return json(req, { count: total?.c || 0, avg: total?.a || 0, dist, low: low.results, recent: recent.results });
      }

      // 어드민: 가게별 클릭수 (많이 눌린 순) — 나만 보기
      if (path === '/admin/clicks' && req.method === 'GET') {
        const rows = await db.prepare(
          'SELECT c.key AS key, c.name AS name, c.n AS n, COALESCE(i.n, 0) AS imp ' +
          'FROM place_clicks c LEFT JOIN place_impressions i ON i.key = c.key ' +
          'ORDER BY c.n DESC LIMIT 100'
        ).all();
        return json(req, { clicks: rows.results });
      }

      // 어드민: 시간대별(0~23시, KST) 클릭 분포 — 나만 보기. 이 기능 배포 이후 클릭부터 집계됨.
      if (path === '/admin/click-hours' && req.method === 'GET') {
        const rows = await db.prepare('SELECT hour, n FROM click_hours').all();
        const hours = Array.from({ length: 24 }, (_, h) => 0);
        for (const r of rows.results) hours[r.hour] = r.n;
        return json(req, { hours });
      }

      // 어드민: 트립코스 3종(course/course3/course-pick) 조회수 — 나만 보기
      if (path === '/admin/course-views' && req.method === 'GET') {
        const day = kstDay();
        const total = await db.prepare('SELECT COALESCE(SUM(n),0) AS t FROM course_views').first();
        const days = await db.prepare('SELECT day, n FROM course_views ORDER BY day DESC LIMIT 30').all();
        const todayRow = days.results.find(r => r.day === day);
        return json(req, { total: total?.t || 0, today: todayRow ? todayRow.n : 0, days: days.results });
      }

      // 어드민: 화면 UI 이벤트(탭 전환·하단 모음 열람) 순위 — 나만 보기
      if (path === '/admin/events' && req.method === 'GET') {
        const rows = await db.prepare('SELECT key, n FROM ui_events ORDER BY n DESC').all();
        return json(req, { events: rows.results });
      }

      // 어드민: 이번 주(월요일~) 클릭 Top10 — "요즘 뜨는 가게" (전체 누적 Top10과 별개)
      if (path === '/admin/clicks-weekly' && req.method === 'GET') {
        const now = new Date(Date.now() + 9 * 3600 * 1000);
        const monday = new Date(now); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
        const mondayStr = monday.toISOString().slice(0, 10);
        const rows = await db.prepare(
          'SELECT key, name, SUM(n) AS n FROM place_clicks_daily WHERE day >= ? GROUP BY key ORDER BY n DESC LIMIT 10'
        ).bind(mondayStr).all();
        return json(req, { clicks: rows.results, since: mondayStr });
      }

      // 어드민: 기간(직접 지정) 클릭수+클릭율 Top10 — from~to(YYYY-MM-DD, KST 날짜 기준, 둘 다 포함)
      // 노출(imp)은 2026-07-28부터 날짜별로 쌓여서, 그 이전을 포함한 기간은 imp가 실제보다 적게 잡힘
      if (path === '/admin/clicks-range' && req.method === 'GET') {
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
        if (!isYmd(from) || !isYmd(to)) return json(req, { error: 'from, to 날짜(YYYY-MM-DD)가 필요해요.' }, 400);
        const rows = await db.prepare(
          'SELECT c.key AS key, c.name AS name, c.n AS n, COALESCE(i.n, 0) AS imp FROM ' +
          '(SELECT key, name, SUM(n) AS n FROM place_clicks_daily WHERE day >= ? AND day <= ? GROUP BY key) c ' +
          'LEFT JOIN (SELECT key, SUM(n) AS n FROM place_impressions_daily WHERE day >= ? AND day <= ? GROUP BY key) i ON i.key = c.key ' +
          'ORDER BY c.n DESC LIMIT 10'
        ).bind(from, to, from, to).all();
        return json(req, { clicks: rows.results, from, to });
      }

      // 어드민: 오픈채팅 트립코스 바로가기(네이버 짧은 주소) 주간 조회수 — 네이버에서 본 숫자를 사용자가 입력
      if (path === '/admin/shortlink-weekly' && req.method === 'GET') {
        const weeks = await loadShortlinkWeeks(db);
        return json(req, { weeks, target: lastFullWeek() });
      }
      if (path === '/admin/shortlink-weekly' && req.method === 'PUT') {
        let b; try { b = await req.json(); } catch { return json(req, { error: '형식 오류' }, 400); }
        const start = String(b.start || ''), n = Number(b.n);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || new Date(start + 'T00:00:00Z').getUTCDay() !== 1) return json(req, { error: '주 시작일(월요일)이 아니에요' }, 400);
        if (!Number.isInteger(n) || n < 0 || n > 1000000) return json(req, { error: '0 이상의 정수를 넣어주세요' }, 400);
        const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(SHORTLINK_KEY).first();
        let saved = {};
        try { saved = row && row.value ? JSON.parse(row.value) : {}; } catch (e) { console.error('shortlink_weekly parse failed', e.message); }
        saved[start] = n;
        await db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
          .bind(SHORTLINK_KEY, JSON.stringify(saved), new Date().toISOString()).run();
        return json(req, { ok: true, start, n });
      }

      // 어드민: 주간 보고 미리보기 (슬랙에 가는 것과 같은 숫자 + 복사용 마크다운)
      if (path === '/admin/weekly-report' && req.method === 'GET') {
        const d = await collectWeeklyReport(db);
        return json(req, { ...d, markdown: renderReportMarkdown(d) });
      }

      // 어드민: 카드 링크 주간 보고 지금 보내기 (시험·수동 발송용)
      if (path === '/admin/weekly-link-report' && req.method === 'POST') {
        const ip = req.headers.get('CF-Connecting-IP') || 'local';
        if (await overLimit(db, 'report@' + ip, 5)) return json(req, { ok: false, error: '너무 잦아요. 10분 뒤 다시 해주세요.' }, 429);
        const status = await runWeeklyLinkReport(env, 'manual');
        return json(req, status, status.ok ? 200 : 502);
      }

      // 어드민: 카드 만들기에서 만든 링크별 클릭 수 — 최근 100개
      // devices 는 (날짜, 기기) 줄 수라 같은 기기가 다른 날 또 누르면 1 더해진다
      // ── 어드민: 추천 가게 모음 (2026-10-07) ──────
      if (path === '/admin/picks' && req.method === 'GET') {
        const rows = await db.prepare('SELECT day, name, cat, card, thumb, hidden, sent_at FROM picks ORDER BY day DESC').all();
        return json(req, { picks: rows.results });
      }
      // 보냈지만 카톡에 안 올린 카드를 모음에서 빼거나 다시 넣는다
      if (path === '/admin/picks/hide' && req.method === 'POST') {
        let b; try { b = await req.json(); } catch (e) { return json(req, { ok: false, error: '형식 오류' }, 400); }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.day || ''))) return json(req, { ok: false, error: '날짜 형식' }, 400);
        const r = await db.prepare('UPDATE picks SET hidden = ? WHERE day = ?').bind(b.hidden ? 1 : 0, b.day).run();
        return json(req, { ok: true, changed: (r.meta && r.meta.changes) || 0 });
      }
      if (path === '/admin/picks/backfill' && req.method === 'POST') {
        return json(req, await backfillPicks(env));
      }

      if (path === '/admin/card-links' && req.method === 'GET') {
        const rows = await db.prepare(
          'SELECT l.id, l.name, l.source, l.card, l.created_at, COALESCE(SUM(h.n), 0) AS clicks, COUNT(h.visitor) AS devices ' +
          'FROM card_links l LEFT JOIN card_link_hits h ON h.id = l.id GROUP BY l.id ORDER BY l.created_at DESC LIMIT 100'
        ).all();
        return json(req, { links: rows.results });
      }

      // 어드민: 가게 피드백(한줄 의견) 최근 목록 — 나만 보기
      if (path === '/admin/feedback' && req.method === 'GET') {
        const rows = await db.prepare('SELECT place, memo, at FROM feedback ORDER BY at DESC LIMIT 100').all();
        return json(req, { feedback: rows.results });
      }

      // 어드민: 코멘트 삭제
      if (path === '/admin/annotations' && req.method === 'DELETE') {
        const id = url.searchParams.get('id');
        if (!id) return json(req, { error: 'id 누락' }, 400);
        await db.prepare('DELETE FROM annotations WHERE id = ?').bind(id).run();
        return json(req, { ok: true });
      }

      return json(req, { error: '없는 주소예요.' }, 404);
    } catch (e) {
      // 내부 오류 상세는 숨기고 로그로만 (wrangler tail 로 확인)
      console.error('worker error:', e.message, e.stack);
      return json(req, { error: '서버 오류가 났어요. 잠시 후 다시 시도해주세요.' }, 500);
    }
  },

  // 예약 실행 (wrangler.jsonc triggers) — 월 10:00 KST 트립코스 주간 보고 + 추천 가게 모음 지난 카드 넣기(1회, 끝나면 건너뜀)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runWeeklyLinkReport(env, 'cron'));
    ctx.waitUntil(backfillPicks(env).catch(e => console.error('picks backfill:', e.message)));
  },
};
