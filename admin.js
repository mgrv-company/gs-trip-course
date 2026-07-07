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
let items = [];        // 통합 목록 [{sid, name, type, cat, zone, man, ghost}]
let ov = {};           // sid → {exclude,reserve,pick,takeout,notion,note}
let curFilter = 'all';
let openNote = null;   // 메모 편집창 열린 sid

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
  ov = {};
  for (const r of data.overrides) {
    ov[r.sid] = { exclude: !!r.exclude, reserve: !!r.reserve, pick: !!r.pick,
                  takeout: !!r.takeout, notion: !!r.notion, note: r.note || '', name: r.name };
  }
  const seen = new Set();
  items = [];
  // 1) 직접추가 (맨 위 — 눈에 잘 띄게)
  for (const m of data.manual) {
    items.push({ sid: String(m.sid), name: m.name, type: m.type || '', cat: m.category || m.type || '', zone: (m.zone || '').slice(0, 2), man: true });
    seen.add(String(m.sid));
  }
  // 2) 스냅샷 전체 가게
  for (const p of (typeof PLACES !== 'undefined' ? PLACES : [])) {
    if (!p.s || seen.has(p.s)) continue;
    items.push({ sid: p.s, name: p.n, type: p.t, cat: p.c || '', zone: p.z || '', man: p.s.charAt(0) === 'm' });
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
  ['all', '전체'], ['pick', '💚 강추'], ['reserve', '☎ 예약'], ['takeout', '🍱 포장'],
  ['exclude', '✕ 제외'], ['note', '📝 메모'], ['man', '➕ 직접추가'],
];
function renderFilterChips() {
  $('#filterChips').innerHTML = FILTERS.map(([k, l]) =>
    `<span class="chip${curFilter === k ? ' on' : ''}" data-f="${k}">${l}</span>`).join('');
}
function matches(it) {
  const o = ov[it.sid] || {};
  const q = ($('#search').value || '').trim().toLowerCase();
  if (q && !((it.name || '').toLowerCase().includes(q) || (it.cat || '').toLowerCase().includes(q))) return false;
  if (curFilter === 'all') return true;
  if (curFilter === 'man') return it.man;
  if (curFilter === 'note') return !!o.note;
  return !!o[curFilter];
}
function itemHTML(it) {
  const o = ov[it.sid] || {};
  const pills = [];
  if (it.man) pills.push('<span class="pill man">직접추가</span>');
  if (o.notion) pills.push('<span class="pill nt">노션코스</span>');
  const sub = [it.type, it.cat !== it.type ? it.cat : '', it.zone, it.ghost ? '(현재 사이트에서 제외됨)' : '']
    .filter(Boolean).join(' · ');
  const noteOpen = openNote === it.sid;
  return `<div class="listitem${o.exclude ? ' excluded' : ''}" data-sid="${esc(it.sid)}">
    <div class="nm">${esc(it.name)}${pills.join('')}</div>
    <div class="ct">${esc(sub)}</div>
    ${o.note && !noteOpen ? `<div class="notepreview">📝 ${esc(o.note)}</div>` : ''}
    <div class="togs">
      <span class="tog${o.pick ? ' on-pick' : ''}" data-act="pick">💚 강추</span>
      <span class="tog${o.reserve ? ' on-rsv' : ''}" data-act="reserve">☎ 예약필수</span>
      <span class="tog${o.takeout ? ' on-to' : ''}" data-act="takeout">🍱 포장·배달</span>
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
  const shown = items.filter(matches);
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

// ── 편집 저장 (누르는 순간 반영) ─────────────────────
function rowPayload(sid) {
  const it = items.find(i => i.sid === sid);
  const o = ov[sid] || {};
  return { sid, name: (it && it.name) || o.name || '',
           exclude: !!o.exclude, reserve: !!o.reserve, pick: !!o.pick,
           takeout: !!o.takeout, notion: !!o.notion, note: o.note || '' };
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
  $('#tabAdd').classList.toggle('hidden', t.dataset.tab !== 'add');
}));

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
