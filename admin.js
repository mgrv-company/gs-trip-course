// 트립코스 새 어드민 — Cloudflare 백엔드(D1) 기반
// 핵심: 저장 버튼 없음. 토글/메모 저장 순간 백엔드에 기록되고 사이트에 즉시 반영(최대 15초).
// 데이터: places.js(주간 스냅샷, 전체 가게 목록) + GET /admin/data(최신 편집) 병합.
// 스냅샷에서 빠진(제외된) 가게는 편집 행에서 이름을 살려 목록에 표시 → 복구 가능.
// 단, 복구된 가게가 사이트에 다시 '보이는' 건 다음 주간 갱신부터 (스냅샷에 없어서).

const API = 'https://gs-trip-admin.mangrove-goseong.workers.dev';
const SESSION_KEY = 'gstAdminSession';
const FOOD_TAGS = ['고기', '면', '분식', '아시안', '양식', '일식', '한식', '해산물'];
const VIBE_TAGS = ['감성', '로컬·노포', '무난'];
const DIST_BY_ZONE = { '도보권': 0.8, '고성권(차 10~15분)': 10, '속초권(차 20~35분)': 25 };

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let token = localStorage.getItem(SESSION_KEY) || '';
let items = [];        // 통합 목록 [{sid, name, type, cat, zone, man, ghost, img, rv, h, d}]
let ov = {};           // sid → {exclude,reserve,pick,takeout,notion,note}
let updAt = {};        // sid → 마지막 수정 시각 (최근 수정 순 정렬용)
let curFilter = 'all';
let curType = null;    // 종류 필터 (식사/카페/술집/기타)
let curZone = null;    // 구역 필터 (도보/고성/속초)
let curSort = '기본';
let openNote = null;   // 메모 편집창 열린 sid
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
function todayHours(it) {
  if (!it.h) return '';
  const r = it.h[DAYS[new Date().getDay()]];
  if (r === null) return '오늘 휴무';
  if (r === undefined) return '';
  return '오늘 ' + r.replace('-', '~');
}

// ── 공통 ────────────────────────────────────────────
function toast(text, isErr) {
  const t = $('#toast');
  t.textContent = text;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toast._tm);
  toast._tm = setTimeout(() => { t.className = ''; }, isErr ? 3200 : 1600);
}
function authFail() {
  localStorage.removeItem(SESSION_KEY);
  token = '';
  $('#app').classList.add('hidden');
  $('#logoutBtn').style.display = 'none';
  $('#loginCard').classList.remove('hidden');
  showMsg('loginMsg', 'err', '로그인이 만료됐어요. 다시 로그인해주세요.');
}
async function api(path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(opts.headers || {}) },
  });
  if (r.status === 401) { authFail(); throw new Error('로그인 필요'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('오류 ' + r.status));
  return j;
}
function showMsg(id, kind, text) {
  const el = $('#' + id);
  el.className = 'msg show ' + kind;
  el.textContent = text;
}

// ── 로그인 ──────────────────────────────────────────
async function doLogin() {
  const pw = $('#pwInput').value;
  if (!pw) { showMsg('loginMsg', 'err', '비밀번호를 입력하세요.'); return; }
  $('#loginBtn').disabled = true;
  try {
    const r = await fetch(API + '/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { showMsg('loginMsg', 'err', j.error || '로그인 실패'); return; }
    token = j.token;
    localStorage.setItem(SESSION_KEY, token);
    $('#pwInput').value = '';
    enterApp();
  } catch (e) {
    showMsg('loginMsg', 'err', '연결 실패 — 인터넷 상태를 확인해주세요.');
  } finally {
    $('#loginBtn').disabled = false;
  }
}
$('#loginBtn').addEventListener('click', doLogin);
$('#pwInput').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST' }); } catch (e) { /* 만료돼도 로컬은 지움 */ }
  localStorage.removeItem(SESSION_KEY);
  location.reload();
});

// ── 데이터 로드·병합 ─────────────────────────────────
async function loadAll() {
  const data = await api('/admin/data');
  ov = {}; updAt = {};
  for (const r of data.overrides) {
    ov[r.sid] = { exclude: !!r.exclude, reserve: !!r.reserve, pick: !!r.pick,
                  takeout: !!r.takeout, notion: !!r.notion, natural: r.natural == null ? null : !!r.natural,
                  note: r.note || '', name: r.name };
    updAt[r.sid] = r.updated_at || '';
  }
  const seen = new Set();
  items = [];
  // 1) 직접추가 (맨 위 — 눈에 잘 띄게)
  for (const m of data.manual) {
    items.push({ sid: String(m.sid), name: m.name, type: m.type || '', cat: m.category || m.type || '', zone: (m.zone || '').slice(0, 2), man: true,
                 img: m.thumb || '', rv: null, h: null, d: m.dist_km != null ? m.dist_km : null });
    if (m._updated && !updAt[String(m.sid)]) updAt[String(m.sid)] = m._updated;
    seen.add(String(m.sid));
  }
  // 2) 스냅샷 전체 가게 (사진·평점·영업시간·거리 포함)
  for (const p of (typeof PLACES !== 'undefined' ? PLACES : [])) {
    if (!p.s || seen.has(p.s)) continue;
    items.push({ sid: p.s, name: p.n, type: p.t, cat: p.c || '', zone: p.z || '', man: p.s.charAt(0) === 'm',
                 img: p.img || '', rv: p.rv || null, h: p.h || null, d: p.d != null ? p.d : null, nat: p.nat });
    seen.add(p.s);
  }
  // 3) 스냅샷에 없는 편집 행(=제외돼서 스냅샷에서 빠진 가게) — 이름 살려 표시, 복구 가능
  for (const [sid, o] of Object.entries(ov)) {
    if (seen.has(sid)) continue;
    items.push({ sid, name: o.name || '(이름 미상)', type: '', cat: '', zone: '', man: sid.charAt(0) === 'm', ghost: true });
    seen.add(sid);
  }
  render();
}

// ── 목록 렌더 ────────────────────────────────────────
const FILTERS = [
  ['all', '전체'], ['pick', '📌 강추'], ['reserve', '☎ 예약'], ['takeout', '🍱 포장'],
  ['exclude', '✕ 제외'], ['note', '📝 메모'], ['man', '➕ 직접추가'],
];
const TYPES = ['식사', '카페', '술집', '기타'];
const ZONES = ['도보', '고성', '속초'];
function renderFilterChips() {
  $('#filterChips').innerHTML = FILTERS.map(([k, l]) =>
    `<span class="chip${curFilter === k ? ' on' : ''}" data-f="${k}">${l}</span>`).join('');
  $('#typeChips').innerHTML =
    TYPES.map(t => `<span class="chip${curType === t ? ' on' : ''}" data-t="${t}">${t}</span>`).join('') +
    '<span style="width:6px"></span>' +
    ZONES.map(z => `<span class="chip${curZone === z ? ' on' : ''}" data-z="${z}">${z}</span>`).join('');
}
function matches(it) {
  const o = ov[it.sid] || {};
  const q = ($('#search').value || '').trim().toLowerCase();
  if (q && !((it.name || '').toLowerCase().includes(q) || (it.cat || '').toLowerCase().includes(q))) return false;
  if (curType) {
    if (curType === '기타' ? ['식사', '카페', '술집'].includes(it.type) : it.type !== curType) return false;
  }
  if (curZone && it.zone !== curZone) return false;
  if (curFilter === 'all') return true;
  if (curFilter === 'man') return it.man;
  if (curFilter === 'note') return !!o.note;
  return !!o[curFilter];
}
function sortItems(arr) {
  if (curSort === '이름') return arr.slice().sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  if (curSort === '거리') return arr.slice().sort((a, b) => (a.d == null ? 9e9 : a.d) - (b.d == null ? 9e9 : b.d));
  if (curSort === '수정') return arr.slice().sort((a, b) => (updAt[b.sid] || '').localeCompare(updAt[a.sid] || ''));
  return arr;   // 기본: 직접추가 → 스냅샷 순
}
function itemHTML(it) {
  const o = ov[it.sid] || {};
  const pills = [];
  if (it.man) pills.push('<span class="pill man">직접추가</span>');
  if (o.notion) pills.push('<span class="pill nt">노션코스</span>');
  const sub = [it.type, it.cat !== it.type ? it.cat : '', it.zone, it.ghost ? '(현재 사이트에서 제외됨)' : '']
    .filter(Boolean).join(' · ');
  const noteOpen = openNote === it.sid;
  const meta = [];
  if (it.rv) meta.push(`<b>★ ${esc(it.rv[0])}</b> (${esc(it.rv[1])})`);
  const th = todayHours(it);
  if (th) meta.push(esc(th));
  return `<div class="listitem${o.exclude ? ' excluded' : ''}" data-sid="${esc(it.sid)}">
    <div class="li-top">
      ${it.img ? `<img class="li-th" src="${esc(it.img)}" loading="lazy" alt="">` : '<div class="li-th"></div>'}
      <div class="li-body">
        <div class="nm">${esc(it.name)}${pills.join('')}</div>
        <div class="ct">${esc(sub)}</div>
        ${meta.length ? `<div class="meta">${meta.join(' · ')}</div>` : ''}
      </div>
    </div>
    ${o.note && !noteOpen ? `<div class="notepreview">📝 ${esc(o.note)}</div>` : ''}
    <div class="togs">
      <span class="tog${o.pick ? ' on-pick' : ''}" data-act="pick">📌 강추</span>
      <span class="tog${o.reserve ? ' on-rsv' : ''}" data-act="reserve">☎ 예약필수</span>
      <span class="tog${o.takeout ? ' on-to' : ''}" data-act="takeout">🍱 포장·배달</span>
      ${it.type === '명소' ? `<span class="tog${(o.natural != null ? o.natural : it.nat) ? ' on-pick' : ''}" data-act="natural">${(o.natural != null ? o.natural : it.nat) ? '🌲 자연명소' : '🏛 그 외'}</span>` : ''}
      <span class="tog${o.exclude ? ' on-exc' : ''}" data-act="exclude">${o.exclude ? '↩ 복구' : '✕ 제외'}</span>
      <span class="tog" data-act="note">📝 메모</span>
      ${it.man ? '<span class="tog del" data-act="delman">🗑 삭제</span>' : ''}
    </div>
    <div class="noteedit${noteOpen ? ' show' : ''}">
      <textarea data-notefor="${esc(it.sid)}" placeholder="카드에 표시할 한두 줄 메모 (비우고 저장하면 삭제)">${noteOpen ? esc(o.note || '') : ''}</textarea>
      <div class="row">
        <button class="btn sm" data-act="notesave">메모 저장</button>
        <button class="btn ghost sm" data-act="notecancel">취소</button>
      </div>
    </div>
  </div>`;
}
function render() {
  renderFilterChips();
  const shown = sortItems(items.filter(matches));
  const total = items.length;
  const excl = Object.values(ov).filter(o => o.exclude).length;
  const manN = items.filter(i => i.man).length;
  $('#countLine').textContent = `전체 ${total} · 직접추가 ${manN} · 제외 ${excl} · 표시 중 ${Math.min(shown.length, 300)}${shown.length > 300 ? ' (검색으로 좁혀보세요)' : ''}`;
  $('#list').innerHTML = shown.slice(0, 300).map(itemHTML).join('') ||
    '<p class="small" style="margin-top:16px;text-align:center">조건에 맞는 가게가 없어요.</p>';
}
$('#search').addEventListener('input', render);
$('#filterChips').addEventListener('click', e => {
  const c = e.target.closest('[data-f]');
  if (!c) return;
  curFilter = c.dataset.f;
  render();
});
$('#typeChips').addEventListener('click', e => {
  const t = e.target.closest('[data-t]'), z = e.target.closest('[data-z]');
  if (t) curType = curType === t.dataset.t ? null : t.dataset.t;      // 다시 누르면 해제
  else if (z) curZone = curZone === z.dataset.z ? null : z.dataset.z;
  else return;
  render();
});
$('#sortSel').addEventListener('change', () => { curSort = $('#sortSel').value; render(); });

// 사이트 스냅샷 재빌드 (평소 불필요 — 매일 아침 자동. 급할 때 수동 트리거)
$('#rebuildBtn').addEventListener('click', async () => {
  if (!confirm('사이트 스냅샷을 지금 다시 만들까요?\n(편집은 이미 즉시 반영되고 있어요. 1~2분 걸립니다.)')) return;
  $('#rebuildBtn').disabled = true;
  try {
    await api('/admin/rebuild', { method: 'POST' });
    toast('🔄 재빌드 시작 — 1~2분 후 스냅샷 갱신');
  } catch (e) {
    toast('재빌드 실패: ' + e.message, true);
  } finally {
    $('#rebuildBtn').disabled = false;
  }
});

// ── 편집 저장 (누르는 순간 반영) ─────────────────────
function rowPayload(sid) {
  const it = items.find(i => i.sid === sid);
  const o = ov[sid] || {};
  return { sid, name: (it && it.name) || o.name || '',
           exclude: !!o.exclude, reserve: !!o.reserve, pick: !!o.pick,
           takeout: !!o.takeout, notion: !!o.notion,
           natural: o.natural === undefined ? null : o.natural,
           note: o.note || '' };
}
async function saveOverride(sid, el) {
  if (el) el.classList.add('busy');
  try {
    await api('/admin/override', { method: 'PUT', body: JSON.stringify(rowPayload(sid)) });
    toast('✓ 저장됨 — 사이트 즉시 반영');
    return true;
  } catch (e) {
    toast('저장 실패: ' + e.message, true);
    return false;
  } finally {
    if (el) el.classList.remove('busy');
  }
}

$('#list').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const itemEl = e.target.closest('.listitem');
  const sid = itemEl && itemEl.dataset.sid;
  if (!sid) return;
  const act = b.dataset.act;
  const it = items.find(i => i.sid === sid);
  ov[sid] = ov[sid] || { exclude: false, reserve: false, pick: false, takeout: false, notion: false, note: '' };

  if (act === 'pick' || act === 'reserve' || act === 'takeout' || act === 'exclude') {
    const before = ov[sid][act];
    ov[sid][act] = !before;                    // 낙관적 반영
    render();
    const okSave = await saveOverride(sid);
    if (!okSave) { ov[sid][act] = before; render(); }   // 실패 시 되돌림
  } else if (act === 'natural') {
    const before = ov[sid].natural;                        // null=자동분류 따름, true/false=수동지정
    const effective = before != null ? before : it.nat;     // 지금 화면에 보이는 상태 기준으로 반전
    ov[sid].natural = !effective;
    render();
    const okSave = await saveOverride(sid);
    if (!okSave) { ov[sid].natural = before; render(); }
  } else if (act === 'note') {
    openNote = openNote === sid ? null : sid;
    render();
    if (openNote === sid) {
      const ta = document.querySelector(`textarea[data-notefor="${CSS.escape(sid)}"]`);
      if (ta) ta.focus();
    }
  } else if (act === 'notesave') {
    const ta = itemEl.querySelector('textarea');
    const before = ov[sid].note;
    ov[sid].note = (ta.value || '').trim().slice(0, 300);
    const okSave = await saveOverride(sid, b);
    if (okSave) { openNote = null; render(); }
    else { ov[sid].note = before; }
  } else if (act === 'notecancel') {
    openNote = null;
    render();
  } else if (act === 'delman') {
    if (!confirm(`직접 추가한 "${it ? it.name : sid}"를 삭제할까요? 사이트에서도 바로 사라집니다.`)) return;
    try {
      await api('/admin/manual?sid=' + encodeURIComponent(sid), { method: 'DELETE' });
      // 편집 행도 같이 정리 (빈 값 저장 = 행 삭제)
      ov[sid] = { exclude: false, reserve: false, pick: false, takeout: false, notion: false, note: '' };
      await api('/admin/override', { method: 'PUT', body: JSON.stringify(rowPayload(sid)) }).catch(() => {});
      items = items.filter(i => i.sid !== sid);
      delete ov[sid];
      render();
      toast('🗑 삭제됨 — 사이트 즉시 반영');
    } catch (e2) {
      toast('삭제 실패: ' + e2.message, true);
    }
  }
});

// ── 탭 ──────────────────────────────────────────────
$$('.tab').forEach(t => t.addEventListener('click', () => {
  $$('.tab').forEach(x => x.classList.remove('on'));
  t.classList.add('on');
  $('#tabManage').classList.toggle('hidden', t.dataset.tab !== 'manage');
  $('#tabCopy').classList.toggle('hidden', t.dataset.tab !== 'copy');
  $('#tabViews').classList.toggle('hidden', t.dataset.tab !== 'views');
  if (t.dataset.tab === 'copy' && !settingsLoaded) {
    loadSettings().catch(e => toast('문구 불러오기 실패: ' + e.message, true));
  }
  if (t.dataset.tab === 'views') loadViews();
}));

// ── 대시보드 (조회수·인기 가게, 나만 보기) ─────────────
const _ymd = d => { const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
const _mondayOf = d => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return _ymd(x); };  // 이번 주 월요일
let _dash = null;   // 공유 리포트용 최근 데이터 스냅샷

async function loadViews() {
  // 1) 조회수 4종 + 추이
  try {
    const v = await api('/admin/views');
    const days = v.days || [];
    const now = new Date(), todayStr = _ymd(now), monStr = _mondayOf(now), monthPre = todayStr.slice(0, 7);
    const sumIf = pred => days.reduce((s, d) => s + (pred(String(d.day)) ? d.n : 0), 0);
    const week = sumIf(day => day >= monStr), month = sumIf(day => day.startsWith(monthPre));
    $('#vToday').textContent = v.today ?? 0;
    $('#vWeek').textContent = week;
    $('#vMonth').textContent = month;
    $('#vTotal').textContent = v.total ?? 0;
    const recent = days.slice(0, 14).reverse();               // 오래된→최근(왼→오)
    const cmax = Math.max.apply(null, recent.map(d => d.n).concat(1));
    $('#vChart').innerHTML = recent.length ? recent.map(d => {
      const md = String(d.day).slice(5).replace('-', '/'), h = Math.round(d.n / cmax * 88);
      return '<div class="cbar"><span class="cval">' + d.n + '</span><span class="bar' + (d.day === todayStr ? ' today' : '') + '" style="height:' + h + 'px"></span><span class="cday">' + md + '</span></div>';
    }).join('') : '<span class="small">아직 방문 기록이 없어요.</span>';
    _dash = { today: v.today ?? 0, week, month, total: v.total ?? 0, recent, todayStr };
  } catch (e) {
    $('#vChart').textContent = '불러오기 실패: ' + e.message;
  }
  // 2) 클릭 Top10 + CTR Top10 + 종류·구역별 분포
  try {
    const clicks = (await api('/admin/clicks')).clicks || [];
    const byClicks = clicks.slice().sort((a, b) => b.n - a.n).slice(0, 10);
    $('#vTopClicks').innerHTML = byClicks.length
      ? byClicks.map(c => '<li><span class="rname">' + esc(c.name || c.key) + '</span><span class="rval">' + c.n + '<span class="rsub">클릭</span></span></li>').join('')
      : '<li class="empty">아직 클릭 기록이 없어요.</li>';
    const byCTR = clicks.filter(c => c.imp > 0).map(c => Object.assign({ ctr: c.n / c.imp }, c)).sort((a, b) => b.ctr - a.ctr || b.imp - a.imp).slice(0, 10);
    $('#vTopCTR').innerHTML = byCTR.length
      ? byCTR.map(c => '<li><span class="rname">' + esc(c.name || c.key) + '</span><span class="rval">' + Math.round(c.ctr * 100) + '%<span class="rsub">클릭 ' + c.n + ' · 노출 ' + c.imp + '</span></span></li>').join('')
      : '<li class="empty">노출 데이터가 쌓이면 표시돼요.</li>';
    renderClickBreakdown(clicks);
    if (_dash) { _dash.byClicks = byClicks; _dash.byCTR = byCTR; }
  } catch (e) {
    $('#vTopClicks').textContent = '불러오기 실패: ' + e.message;
  }
  // 3) 서비스 별점 요약
  try {
    const r = await api('/admin/ratings');
    $('#vRateAvg').textContent = r.count ? Number(r.avg).toFixed(1) : '–';
    $('#vRateCount').textContent = r.count || 0;
    const dmax = Math.max.apply(null, [1, 2, 3, 4, 5].map(s => r.dist[s] || 0));
    $('#vRateDist').innerHTML = [5, 4, 3, 2, 1].map(s => {
      const n = r.dist[s] || 0, w = Math.round(n / dmax * 100);
      return '<div class="rdrow"><span class="rdlabel">' + s + '★</span><span class="rdbar"><span style="width:' + w + '%"></span></span><span class="rdn">' + n + '</span></div>';
    }).join('');
    $('#vRateLow').innerHTML = r.low.length
      ? r.low.map(x => '<div class="lowitem"><span class="lowscore">' + '★'.repeat(x.score) + '☆'.repeat(5 - x.score) + '</span>'
          + (x.memo ? '<div class="lowmemo">' + esc(x.memo) + '</div>' : '') + '<div class="lowat">' + esc((x.at || '').slice(0, 16).replace('T', ' ')) + '</div></div>').join('')
      : '<div class="lowitem small">1~2점 평가가 없어요.</div>';
    _ratingsAll = r.recent || [];
    const _allBox = $('#vRateAll');
    _allBox.innerHTML = '';
    _allBox.style.display = 'none';   // 새로고침 시 접어둠 — 다음 클릭 때 최신 데이터로 다시 열림
    if (_dash) _dash.rating = r;
  } catch (e) {
    $('#vRateAvg').textContent = '실패';
  }
  // 4) 시간대별(0~23시) 클릭 분포
  try {
    const h = (await api('/admin/click-hours')).hours || [];
    const hmax = Math.max.apply(null, h.concat(1));
    $('#vHourChart').innerHTML = h.map((n, hour) =>
      '<div class="cbar"><span class="cval">' + (n || '') + '</span><span class="bar" style="height:' + Math.round(n / hmax * 88) + 'px"></span><span class="cday">' + hour + '시</span></div>'
    ).join('');
  } catch (e) {
    $('#vHourChart').textContent = '불러오기 실패: ' + e.message;
  }
  // 5) 트립코스 3종 조회수
  try {
    const cv = await api('/admin/course-views');
    $('#vCourseToday').textContent = cv.today ?? 0;
    $('#vCourseTotal').textContent = cv.total ?? 0;
  } catch (e) {
    $('#vCourseToday').textContent = '실패';
  }
  // 6) 이번 주 뜨는 가게 Top10
  try {
    const cw = (await api('/admin/clicks-weekly')).clicks || [];
    $('#vClicksWeekly').innerHTML = cw.length
      ? cw.map(c => '<li><span class="rname">' + esc(c.name || c.key) + '</span><span class="rval">' + c.n + '<span class="rsub">클릭</span></span></li>').join('')
      : '<li class="empty">이번 주 클릭 기록이 아직 없어요.</li>';
  } catch (e) {
    $('#vClicksWeekly').textContent = '불러오기 실패: ' + e.message;
  }
  // 7) 화면 UI 이벤트(탭·모음) 순위
  try {
    const ev = (await api('/admin/events')).events || [];
    const LABELS = { 'tab:auto': '탭: 영업중', 'tab:meal': '탭: 든든한 한끼', 'tab:cafe': '탭: 카페', 'tab:bar': '탭: 술과 함께',
      'coll:walk': '모음: 걸어서 갈 곳', 'coll:capick': '모음: CA 강추', 'coll:time': '모음: 아침·심야', 'coll:makguksu': '모음: 막국수 모음',
      'coll:takeout': '모음: 포장·배달', 'coll:activity': '모음: 액티비티', 'coll:beach': '모음: 해수욕장', 'coll:festival': '모음: 축제' };
    $('#vEvents').innerHTML = ev.length
      ? ev.map(e => '<li><span class="rname">' + esc(LABELS[e.key] || e.key) + '</span><span class="rval">' + e.n + '<span class="rsub">회</span></span></li>').join('')
      : '<li class="empty">아직 기록이 없어요.</li>';
  } catch (e) {
    $('#vEvents').textContent = '불러오기 실패: ' + e.message;
  }
  // 8) 가게 피드백 최근 목록
  try {
    const fb = (await api('/admin/feedback')).feedback || [];
    $('#vFeedback').innerHTML = fb.length
      ? fb.map(x => '<div class="lowitem">' + (x.place ? '<b>' + esc(x.place) + '</b><br>' : '')
          + esc(x.memo) + '<div class="lowat">' + esc((x.at || '').slice(0, 16).replace('T', ' ')) + '</div></div>').join('')
      : '<div class="lowitem small">아직 피드백이 없어요.</div>';
  } catch (e) {
    $('#vFeedback').textContent = '불러오기 실패: ' + e.message;
  }
}
let _ratingsAll = [];
const _vRateCountBox = $('#vRateCountBox');
if (_vRateCountBox) _vRateCountBox.addEventListener('click', () => {
  const el = $('#vRateAll');
  const show = el.style.display === 'none';
  el.style.display = show ? '' : 'none';
  if (show) {
    el.innerHTML = _ratingsAll.length
      ? '<div class="charttitle" style="margin-top:0">전체 평가 (최근 ' + _ratingsAll.length + '건)</div>'
        + _ratingsAll.map(x => '<div class="lowitem"><span class="lowscore">' + '★'.repeat(x.score) + '☆'.repeat(5 - x.score) + '</span>'
            + (x.memo ? '<div class="lowmemo">' + esc(x.memo) + '</div>' : '<div class="lowmemo small">(한줄평 없음)</div>')
            + '<div class="lowat">' + esc((x.at || '').slice(0, 16).replace('T', ' ')) + '</div></div>').join('')
      : '<div class="lowitem small">아직 평가가 없어요.</div>';
  }
});

// 종류·구역별 클릭 분포 — 백엔드 집계 없이 클릭 데이터(key=sid)를 현재 가게 목록(items)과 묶어서 계산
function renderClickBreakdown(clicks) {
  const bySid = {};
  items.forEach(it => { bySid[it.sid] = it; });
  const byType = {}, byZone = {};
  clicks.forEach(c => {
    const it = bySid[c.key];
    if (!it) return;   // 관광정보(TourAPI) 카드 등 가게 목록에 없는 항목은 종류·구역 정보가 없어 제외
    const t = it.type || '기타', z = it.zone || '기타';
    byType[t] = (byType[t] || 0) + c.n;
    byZone[z] = (byZone[z] || 0) + c.n;
  });
  const renderRank = (obj) => {
    const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]);
    return rows.length
      ? rows.map(([k, n]) => '<li><span class="rname">' + esc(k) + '</span><span class="rval">' + n + '<span class="rsub">클릭</span></span></li>').join('')
      : '<li class="empty">데이터가 쌓이면 표시돼요.</li>';
  };
  $('#vClickByType').innerHTML = renderRank(byType);
  $('#vClickByZone').innerHTML = renderRank(byZone);
}

// ── 공유용 HTML 리포트 (자체완결 파일 다운로드 — 로그인 없이 남에게 공유) ──
function buildReportHTML(d) {
  const cmax = Math.max.apply(null, (d.recent || []).map(x => x.n).concat(1));
  const bars = (d.recent || []).map(x => {
    const md = String(x.day).slice(5).replace('-', '/'), h = Math.round(x.n / cmax * 90);
    return '<div class="cb"><span class="cv">' + x.n + '</span><span class="bar" style="height:' + h + 'px"></span><span class="cd">' + md + '</span></div>';
  }).join('');
  const rank = (arr, valFn) => (arr && arr.length)
    ? '<ol>' + arr.map(c => '<li><span class="n">' + esc(c.name || c.key) + '</span><span class="v">' + valFn(c) + '</span></li>').join('') + '</ol>'
    : '<p class="empty">데이터 없음</p>';
  const now = new Date(), stamp = _ymd(now) + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>맹그로브 고성 · 트립코스 리포트 ' + _ymd(now) + '</title><style>'
    + '*{margin:0;padding:0;box-sizing:border-box}body{font-family:Pretendard,-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",system-ui,sans-serif;background:#f6f5f2;color:#1f1e1d;line-height:1.5;padding:22px 16px 50px}'
    + '.w{max-width:520px;margin:0 auto}h1{font-size:19px;font-weight:800}.sub{font-size:12.5px;color:#76776c;margin:5px 0 18px}'
    + '.card{background:#fff;border:1px solid #ececea;border-radius:16px;padding:16px;margin-top:14px}.card h2{font-size:15px;font-weight:800;margin-bottom:4px}.card p{font-size:12px;color:#76776c;margin-bottom:6px}'
    + '.g{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0 2px}.s{background:#eafdf1;border-radius:12px;padding:13px 6px;text-align:center}.s.hl{background:#0a7a3c}.s.hl .n,.s.hl .l{color:#fff}.s .n{font-size:23px;font-weight:800;color:#0a7a3c;font-variant-numeric:tabular-nums}.s .l{font-size:11px;color:#76776c;margin-top:2px}'
    + '.chart{display:flex;align-items:flex-end;gap:5px;height:112px;margin-top:14px}.cb{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;justify-content:flex-end;height:100%}.cb .bar{width:100%;max-width:22px;background:#00b453;border-radius:4px 4px 0 0;min-height:2px}.cb .cv{font-size:9.5px;font-weight:700;font-variant-numeric:tabular-nums}.cb .cd{font-size:8.5px;color:#76776c}'
    + 'ol{list-style:none;counter-reset:r;margin-top:8px}ol li{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid #ececea;font-size:14px}ol li:first-child{border-top:0}ol li:before{counter-increment:r;content:counter(r);flex:0 0 auto;width:22px;height:22px;border-radius:50%;background:#edece9;color:#76776c;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center}ol li:first-child:before{background:#00b453;color:#fff}.n{flex:1;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.v{font-weight:700;color:#0a7a3c;font-variant-numeric:tabular-nums}.empty{color:#76776c;font-size:13px;padding:6px 0}'
    + 'footer{text-align:center;font-size:11px;color:#a0a099;margin-top:24px}</style></head><body><div class="w">'
    + '<h1>맹그로브 고성 · 트립코스 리포트</h1><div class="sub">' + stamp + ' 기준 · 손님 조회수/인기 가게 (어드민 제외)</div>'
    + '<div class="card"><h2>📊 조회수</h2><div class="g"><div class="s"><div class="n">' + d.today + '</div><div class="l">오늘</div></div><div class="s"><div class="n">' + d.week + '</div><div class="l">이번 주</div></div><div class="s"><div class="n">' + d.month + '</div><div class="l">이번 달</div></div><div class="s hl"><div class="n">' + d.total + '</div><div class="l">누적</div></div></div><div class="chart">' + bars + '</div></div>'
    + '<div class="card"><h2>🖱 클릭 많은 가게 Top 10</h2><p>네이버 지도 보기 클릭 순</p>' + rank(d.byClicks, c => c.n + ' 클릭') + '</div>'
    + '<div class="card"><h2>🎯 CTR 높은 가게 Top 10</h2><p>노출 대비 클릭 비율 순</p>' + rank(d.byCTR, c => Math.round(c.ctr * 100) + '% (클릭 ' + c.n + ' · 노출 ' + c.imp + ')') + '</div>'
    + buildRatingCardHTML(d.rating)
    + '<footer>맹그로브 고성 · 지금 갈만한 곳</footer></div></body></html>';
}
// 공유 리포트용 ⭐ 서비스 평가 카드 — 별점 데이터가 아직 없으면(대시보드 미로드) 카드 자체를 생략
function buildRatingCardHTML(rt) {
  if (!rt) return '';
  const avgTxt = rt.count ? Number(rt.avg).toFixed(1) + '점' : '데이터 없음';
  const dist = rt.dist || {};
  const bars = [5, 4, 3, 2, 1].map(s => '<div class="s"><div class="n">' + (dist[s] || 0) + '</div><div class="l">' + s + '★</div></div>').join('');
  return '<div class="card"><h2>⭐ 서비스 평가</h2><p>평균 ' + avgTxt + ' · 응답 ' + (rt.count || 0) + '건</p>'
    + '<div class="g" style="grid-template-columns:repeat(5,1fr)">' + bars + '</div></div>';
}
function downloadReport() {
  if (!_dash || _dash.byClicks === undefined) { toast('대시보드를 먼저 불러와주세요', true); return; }
  const html = buildReportHTML(_dash);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  a.download = '트립코스-리포트-' + _dash.todayStr + '.html';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  toast('공유용 HTML을 저장했어요');
}
const _shareBtn = $('#shareBtn');
if (_shareBtn) _shareBtn.addEventListener('click', downloadReport);

// ── 문구·디자인 ──────────────────────────────────────
// [key, 라벨, 입력형태, 기본값] — home.js COPY 기본값과 key·문구가 일치해야 함.
// 비워두면 저장 안 함 → 프론트가 기본값으로 표시(= "초기화"는 비우기).
const COPY_GROUPS = [
  ['상단 (히어로)', [
    ['hero.title', '제목', 'input', '지금 어디로 갈까요?'],
    ['hero.sub', '부제', 'input', '커뮤니티 매니저가 추천하는 가게들'],
  ]],
  ['홈 하단 · 해수욕장', [
    ['beachmini.title', '제목', 'input', '해수욕장'],
    ['beachmini.sub', '설명', 'input', '맹그로브에서 가까운 순서대로 추천해요.'],
  ]],
  ['홈 하단 · 즐길 곳', [
    ['attrmini.title', '제목', 'input', '즐길 곳'],
    ['attrmini.sub', '설명', 'input', '고성에서 즐길 거리와 볼 거리를 모아 소개해요.'],
  ]],
  ['추천 탭 이름', [
    ['seg.auto', '영업중 탭', 'input', '영업중'],
    ['seg.meal', '식사 탭', 'input', '든든한 한 끼'],
    ['seg.cafe', '카페 탭', 'input', '느낌 좋은 카페'],
    ['seg.bar', '술 탭', 'input', '술과 함께'],
  ]],
  ['추천 설명문 (탭별 안내)', [
    ['slotsub.auto', '영업중 설명', 'textarea', '메뉴에 상관없이 지금 영업 중인 가게를 추천해요.'],
    ['slotsub.meal', '식사 설명', 'textarea', '식사가 될 수 있을만한 가게들로 추천해요.'],
    ['slotsub.cafe', '카페 설명', 'textarea', '카페부터 베이커리, 젤라또까지 다양하게 추천해요.'],
    ['slotsub.bar', '술 설명', 'textarea', '노포부터 이자카야까지, 술 한 잔 하기 좋은 곳을 추천해요.'],
  ]],
  ['피드백 영역', [
    ['feedback.title', '제목', 'input', '다녀온 가게, 어떠셨어요?'],
    ['feedback.body', '설명 (줄바꿈 가능)', 'textarea', '소중한 의견을 모아 더욱 유용한 서비스로 만들게요.\n솔직하게 기재해주시면 큰 도움이 됩니다.'],
    ['feedback.btnFb', '피드백 버튼', 'input', '✍️ 추천받은 가게 피드백 남기기'],
    ['feedback.btnSuggest', '추천 버튼', 'input', '📌 리스트에 없었던 가게 추천하기'],
  ]],
  ['별점 영역', [
    ['rating.title', '제목', 'input', '이 추천 서비스는 어떠셨어요?'],
    ['rating.body', '안내', 'textarea', "원하는 별점을 누르고, 아래 '별점 추가하기' 버튼을 눌러주세요."],
    ['rating.placeholder', '입력칸 안내문', 'textarea', '어떤 부분이 도움이 되었는지 적어주세요. 혹은 필요한 정보가 있다면 기재해주셔도 좋습니다.'],
    ['rating.btn', '버튼', 'input', '별점 추가하기'],
    ['rating.done', '완료 문구', 'input', '🙌 감사합니다! 더 좋은 추천으로 보답할게요.'],
  ]],
  ['팝업 · 가게 피드백', [
    ['fb.title', '제목', 'input', '가게 피드백'],
    ['fb.desc', '설명', 'textarea', '좋았어요·아쉬웠어요·문 닫았더라고요 — 뭐든 좋아요. 남겨주신 의견은 커뮤니티 매니저에게 바로 전달됩니다. 30초면 충분해요!'],
    ['fb.place', '가게 이름칸 안내', 'input', '가게 이름 (기억나는 만큼만)'],
    ['fb.memo', '내용칸 안내', 'input', '예: 여기 진짜 좋았어요! / 웨이팅 1시간이었어요 / 문 닫았던데요'],
    ['fb.done', '완료 문구', 'input', '🙌 고맙습니다! 의견이 전달됐어요.'],
  ]],
  ['팝업 · 좋았던 곳 추천', [
    ['sg.title', '제목', 'input', '좋았던 곳 추천'],
    ['sg.desc', '설명', 'textarea', '추천 리스트에 없는데 좋았던 가게가 있나요? 알려주시면 커뮤니티 매니저가 다녀와 보고 리스트에 올릴게요.'],
    ['sg.place', '가게 이름칸 안내', 'input', '가게 이름 (필수)'],
    ['sg.memo', '내용칸 안내', 'input', '어떤 점이 좋았나요? 위치·메뉴 등 아는 만큼만 적어주세요 (선택)'],
    ['sg.name', '성함칸 안내', 'input', '성함 (선택)'],
    ['sg.done', '완료 문구', 'input', '고맙습니다! 다녀와 보고 리스트에 올려볼게요.'],
  ]],
];
let settingsLoaded = false;
// key → 기본 문구 (home.js COPY 기본값과 일치). 입력칸 채우기·저장 판단에 사용.
const COPY_DEF = {};
COPY_GROUPS.forEach(([, fields]) => fields.forEach(([key, , , def]) => { COPY_DEF[key] = def; }));

function renderCopyFields() {
  $('#copyFields').innerHTML = COPY_GROUPS.map(([group, fields]) => {
    const rows = fields.map(([key, label, type, def]) => {
      const ph = esc(def).replace(/\n/g, '&#10;');   // placeholder 안 줄바꿈 보존
      const el = type === 'textarea'
        ? `<textarea data-key="${key}" rows="2" placeholder="${ph}"></textarea>`
        : `<input type="text" data-key="${key}" placeholder="${ph}">`;
      return `<label>${esc(label)}</label>${el}`;
    }).join('');
    return `<div class="cg"><div class="cg-t">${esc(group)}</div>${rows}</div>`;
  }).join('');
}

async function loadSettings() {
  const s = await api('/admin/settings');
  const copy = (s && s.copy) || {};
  // 현재 문구를 칸에 채움: 저장된 편집분 있으면 그것, 없으면 기본 문구 → 그 위에서 바로 수정
  $$('#copyFields [data-key]').forEach(el => {
    const k = el.dataset.key;
    el.value = copy[k] != null ? copy[k] : (COPY_DEF[k] || '');
  });
  const theme = (s && s.theme) || {};
  const acc = /^#[0-9a-fA-F]{6}$/.test(theme.accent || '') ? theme.accent : '#00b453';
  $('#th_accent').value = acc;
  $('#th_accent_hex').textContent = acc;
  $('#th_scale').value = ['small', 'normal', 'large'].includes(theme.scale) ? theme.scale : 'normal';
  settingsLoaded = true;
}

async function saveSettings() {
  const copy = {};
  // 기본값과 다른 것만 저장 → 안 건드린 문구는 기본값 유지(추후 기본 문구 바뀌면 자동 반영)
  $$('#copyFields [data-key]').forEach(el => {
    const k = el.dataset.key;
    const v = el.value.trim();
    if (v && v !== (COPY_DEF[k] || '')) copy[k] = v.slice(0, 400);
  });
  const theme = { accent: $('#th_accent').value, scale: $('#th_scale').value };
  $('#copySaveBtn').disabled = true;
  try {
    await api('/admin/settings', { method: 'PUT', body: JSON.stringify({ copy, theme }) });
    showMsg('copyMsg', 'ok', '저장됐어요 — 메인 페이지에 바로 반영됩니다 (최대 15초).');
    toast('✓ 문구·디자인 저장됨');
  } catch (e) {
    showMsg('copyMsg', 'err', '저장 실패: ' + e.message);
  } finally {
    $('#copySaveBtn').disabled = false;
  }
}

renderCopyFields();
$('#th_accent').addEventListener('input', () => { $('#th_accent_hex').textContent = $('#th_accent').value; });
$('#th_accent_reset').addEventListener('click', () => { $('#th_accent').value = '#00b453'; $('#th_accent_hex').textContent = '#00b453'; });
$('#copySaveBtn').addEventListener('click', saveSettings);

// ── 새 가게 추가 ─────────────────────────────────────
function buildChips(sel, tags) {
  $(sel).innerHTML = tags.map(t => `<span class="chip" data-v="${esc(t)}">${esc(t)}</span>`).join('');
  $$(sel + ' .chip').forEach(c => c.addEventListener('click', () => c.classList.toggle('on')));
}
const chosen = sel => $$(sel + ' .chip.on').map(c => c.dataset.v);

// 사진 URL 미리보기
$('#f_thumb').addEventListener('input', () => {
  const v = $('#f_thumb').value.trim();
  const img = $('#thumbPrev');
  if (v && /^https:\/\//.test(v)) { img.src = v; img.style.display = 'block'; }
  else img.style.display = 'none';
});
$('#thumbPrev').addEventListener('error', () => { $('#thumbPrev').style.display = 'none'; });

$('#addBtn').addEventListener('click', async () => {
  const name = $('#f_name').value.trim();
  if (!name) { showMsg('addMsg', 'err', '이름은 필수예요.'); return; }
  if (items.some(i => i.name === name)) { showMsg('addMsg', 'err', '같은 이름의 가게가 이미 있어요.'); return; }
  const type = $('#f_type').value, zone = $('#f_zone').value;
  const place = {
    name, type, list: '수동', category: $('#f_cat').value.trim() || type,
    food: chosen('#f_food'), vibe: chosen('#f_vibe'),
    zone, dist_km: DIST_BY_ZONE[zone] || 10,
    address: $('#f_addr').value.trim(), lat: null, lng: null,
    sid: 'm' + Date.now(),
    thumb: $('#f_thumb').value.trim(), naver: $('#f_naver').value.trim(), guessed: false,
  };
  const note = $('#f_note').value.trim().slice(0, 300);
  const pick = $('#f_pick').checked;
  $('#addBtn').disabled = true;
  try {
    await api('/admin/manual', { method: 'PUT', body: JSON.stringify({ place }) });
    if (note || pick) {
      ov[place.sid] = { exclude: false, reserve: false, pick, takeout: false, notion: false, note };
      await api('/admin/override', { method: 'PUT', body: JSON.stringify({ sid: place.sid, name, exclude: false, reserve: false, pick, takeout: false, notion: false, note }) });
    }
    items.unshift({ sid: place.sid, name, type, cat: place.category, zone: zone.slice(0, 2), man: true });
    ['f_name', 'f_cat', 'f_addr', 'f_naver', 'f_thumb', 'f_note'].forEach(id => { $('#' + id).value = ''; });
    $('#f_pick').checked = false;
    $('#thumbPrev').style.display = 'none';
    $$('#f_food .chip, #f_vibe .chip').forEach(c => c.classList.remove('on'));
    showMsg('addMsg', 'ok', `"${name}" 추가 완료 — 사이트에 즉시 반영됐어요.`);
    toast('✓ 추가됨 — 사이트 즉시 반영');
    render();
  } catch (e) {
    showMsg('addMsg', 'err', '추가 실패: ' + e.message);
  } finally {
    $('#addBtn').disabled = false;
  }
});

// ── 시작 ────────────────────────────────────────────
async function enterApp() {
  $('#loginCard').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#logoutBtn').style.display = 'block';
  buildChips('#f_food', FOOD_TAGS);
  buildChips('#f_vibe', VIBE_TAGS);
  try {
    await loadAll();
  } catch (e) {
    if (token) toast('불러오기 실패: ' + e.message, true);
  }
}
if (token) enterApp();
