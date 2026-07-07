// gs-trip-course 어드민 백엔드 — Cloudflare Worker + D1
//
// 역할 3가지:
//  1) 어드민: 비밀번호 로그인 → 가게 편집(제외/예약/강추/포장/메모/직접추가)을 DB에 즉시 저장
//  2) 투숙객 페이지: 편집 데이터를 공개로 읽어가 places.js 스냅샷 위에 얹음 (저장 즉시 반영)
//  3) 피드백: 방문객 의견 수신 → 검증·횟수제한 후 슬랙 #gs-routine 전송 (구 Apps Script 대체)
//
// 비밀값(코드 밖, wrangler secret): ADMIN_PASSWORD, SLACK_WEBHOOK
// 공개값(wrangler.jsonc vars): FB_TOKEN

const SESSION_DAYS = 60;            // 어드민 로그인 유지 기간
const FB_LIMIT = 15;                // 피드백: 10분당 최대 건수
const LOGIN_LIMIT = 10;             // 로그인 시도: IP당 10분에 최대 횟수 (무차별 대입 방지)
const PUB_CACHE_MS = 15000;         // 공개 읽기 메모리 캐시 (남용시 무료한도 소진 방지 — 어드민 저장하면 즉시 비움)

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
  if (r.note) o.note = r.note;
  return o;
}

export default {
  async fetch(req, env) {
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
            if (r.note) o.note = r.note;
            if (Object.keys(o).length) { o.sid = r.sid; legacy[r.name] = o; }
          }
          data = { overrides: legacy, manual_places: man.results.map(r => JSON.parse(r.json)) };
        }
        pubCache[path] = { data, at: Date.now() };
        return json(req, data, 200, pubHdr);
      }

      // ── 공개: 피드백 수신 → 슬랙 (구 Apps Script 대체) ─────────
      if (path === '/feedback' && req.method === 'POST') {
        const ok = json(req, { ok: true });          // 스팸/거절도 동일 응답 (정보 노출 방지)
        let data;
        try { data = await req.json(); } catch { return ok; }
        if (data.t !== env.FB_TOKEN) return ok;                       // (1) 토큰 검증
        // 슬랙 특수문법 무력화 — <!channel> 전체알림 장난·가짜 링크 방지
        const slackEsc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
              body: JSON.stringify({ text: rText }),
            });
          } catch (e) { console.error('슬랙 전송 실패:', e.message); }
          return ok;
        }

        const place = String(data.place || '').slice(0, 100);
        const memo = String(data.memo || '').slice(0, 500).trim();
        if (!memo) return ok;                                          // (2) 입력 검증
        if (await overLimit(db, 'fb', FB_LIMIT)) return ok;            // (3) 횟수 제한
        const text = '📝 트립코스 피드백\n'
          + '• 가게: ' + (slackEsc(place) || '(미지정)') + '\n'
          + '• 내용: ' + slackEsc(memo) + '\n'
          + '• 시각: ' + slackEsc(String(data.at || '').slice(0, 30));
        try {
          await fetch(env.SLACK_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
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
      if (path.startsWith('/admin/') || path === '/logout') {
        if (!(await checkAuth(req, db))) return json(req, { error: '로그인이 필요해요.' }, 401);
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
        const empty = flags.every(f => !f) && !note;
        if (empty) {
          await db.prepare('DELETE FROM overrides WHERE sid = ?').bind(String(b.sid)).run();
        } else {
          await db.prepare(`
            INSERT INTO overrides (sid, name, exclude, reserve, pick, takeout, notion, note, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(sid) DO UPDATE SET
              name=excluded.name, exclude=excluded.exclude, reserve=excluded.reserve,
              pick=excluded.pick, takeout=excluded.takeout, notion=excluded.notion,
              note=excluded.note, updated_at=excluded.updated_at
          `).bind(String(b.sid), String(b.name || '').slice(0, 100),
                  ...flags, note, new Date().toISOString()).run();
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

      return json(req, { error: '없는 주소예요.' }, 404);
    } catch (e) {
      // 내부 오류 상세는 숨기고 로그로만 (wrangler tail 로 확인)
      console.error('worker error:', e.message, e.stack);
      return json(req, { error: '서버 오류가 났어요. 잠시 후 다시 시도해주세요.' }, 500);
    }
  },
};
