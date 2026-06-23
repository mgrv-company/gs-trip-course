// 맹그로브 고성 — "지금 갈만한 곳" 홈
// 현재 시각 기준, 지금 문 연 곳 중에서 옵션(식성/분위기)에 맞춰 딱 3곳을 가중 추첨으로 추천.

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
const LIMIT = 3;                 // 추천 개수
const FOOD = ['해산물', '고기', '한식', '면', '분식', '일식', '양식', '아시안'];
const VIBE = ['감성', '로컬·노포'];
const FEEDBACK_ENDPOINT = '';   // 피드백 수신 Apps Script /exec URL — 배포 후 채우면 슬랙으로 전송됨

function toMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }

function openNow(p, now) {
  if (!p.h) return null;
  const day = DAY_NAMES[now.getDay()];
  if (!(day in p.h)) return null;
  const range = p.h[day];
  if (range === null) return false;
  const [s, e] = range.split('-');
  const t = now.getHours() * 60 + now.getMinutes();
  let start = toMin(s), end = toMin(e);
  if (end <= start) end += 1440;
  if (t >= start && t <= end - 20) return true;
  if (t + 1440 >= start && t + 1440 <= end - 20) return true;
  return false;
}

function autoSlot(now) {
  const h = now.getHours();
  if (h >= 5 && h < 10) return 'cafe';
  if (h >= 10 && h < 14) return 'meal';
  if (h >= 14 && h < 17) return 'cafe';
  if (h >= 17 && h < 21) return 'meal';
  return 'bar';
}
const SLOT_LABEL = { meal: '🍚 지금은 밥때', cafe: '☕ 카페 타임', bar: '🍻 한잔하기 좋은 시간' };
const TYPE_OF = { meal: '식사', cafe: '카페', bar: '술집' };

function zoneRank(z) { return z === '도보' ? 3 : z === '고성' ? 1.5 : 0; }
function scoreNow(p, now) {
  let s = Math.random() * 2.5;        // 변동 폭 키움 (매번 다르게)
  s += zoneRank(p.z) * 0.7;           // 거리 가중은 약하게 (고정 방지)
  if (p.ca) s += 2.5;
  if (p.rv) { const [r, c] = p.rv; s += Math.max(-1, Math.min(1.4, (r - 4.2) * 2)); s += Math.min(1.2, Math.log10(c + 1) * 0.5); }
  const peak = (now.getHours() >= 12 && now.getHours() < 13) || (now.getHours() >= 18 && now.getHours() < 20);
  if (peak && p.w === 2) s -= 1.3;
  if (p.w === 0) s += 0.3;
  return s;
}

// 상위 후보 풀에서 가중 추첨으로 n개 (순위 높을수록 잘 뽑힘) — 매번 다른 조합
function weightedSample(items, n) {
  const pool = items.slice(), out = [];
  while (out.length < n && pool.length) {
    const weights = pool.map((_, i) => pool.length - i);
    let roll = Math.random() * weights.reduce((a, b) => a + b, 0), idx = 0;
    for (; idx < pool.length; idx++) { roll -= weights[idx]; if (roll <= 0) break; }
    out.push(pool[idx]); pool.splice(idx, 1);
  }
  return out;
}

function moveText(p) {
  const walk = Math.max(3, Math.round(p.d * 15));        // 도보 ≈ 4km/h
  if (p.d <= 1.2) return '🚶 ' + walk + '분';
  const car = Math.round(p.d / 50 * 60) + 3;
  if (walk <= 30) return '🚗 ' + car + '분 · 🚶 ' + walk + '분';   // 도보 30분 이내면 도보도 표기
  return '🚗 ' + car + '분';
}
function hoursNowText(p) {
  if (!p.h) return '영업시간 미상 · 방문 전 확인';
  const range = p.h[DAY_NAMES[new Date().getDay()]];
  if (range === null) return '오늘 휴무 ⚠️';
  if (range === undefined) return '오늘 영업시간 미정 · 방문 전 확인';
  return '오늘 ' + range.replace('-', '~');
}
function waitText(p) {
  if (p.w === 2) return `⏳ 웨이팅 잦음 — 평일·오픈직후 추천${p.lu ? ' · 📲 네이버 줄서기' : ''}`;
  if (p.w === 1) return '⏳ 식사시간엔 대기 있을 수 있어요';
  if (p.w === 0) return '🚶 보통 바로 입장';
  return '';
}

function cardHTML(p) {
  const badges = [];
  if (p.ca) badges.push('<span class="b ca">💚 강추</span>');
  if (p.r) badges.push('<span class="b rsv">☎ 예약</span>');
  const open = openNow(p, new Date());
  if (open === true) badges.push('<span class="b open">● 영업중</span>');
  else if (open === null) badges.push('<span class="b chk">확인필요</span>');
  const lines = [];
  if (p.m && p.m.length) lines.push('🍽 ' + p.m.join(' · '));
  lines.push('🕐 ' + hoursNowText(p));
  if (waitText(p)) lines.push(waitText(p));
  const memo = p.note || p.mr;
  if (memo) lines.push('💬 ' + memo);
  const rv = p.rv ? `<span class="rv">⭐ ${p.rv[0]} (${p.rv[1]})</span>` : '';
  return `<div class="card${p.img ? ' pic' : ''}">
    ${p.img ? `<img class="ph" src="${p.img}" loading="lazy" alt="">` : ''}
    <div class="nm">${p.n} ${badges.join(' ')}</div>
    <div class="ct">${p.c} · ${moveText(p)} ${rv}</div>
    <div class="info">${lines.join('<br>')}</div>
    <div class="links">${p.u ? `<a href="${p.u}" target="_blank" rel="noopener">네이버지도 ↗</a>` : ''}${p.bk ? ` <a href="${p.bk}" target="_blank" rel="noopener">📅 예약</a>` : ''}</div>
  </div>`;
}

let curSlot = 'auto';
let curFilter = null;   // 선택된 옵션 태그 (식성/분위기), null=전체
let recent = [];        // 최근 보여준 가게 이름 — 중복 방지(돌아가며 노출)

function activeSlot() { return curSlot === 'auto' ? autoSlot(new Date()) : curSlot; }
function filtersFor(slot) { return slot === 'meal' ? FOOD : VIBE; }

function renderChips() {
  const slot = activeSlot();
  const tags = filtersFor(slot);
  const chips = ['<span class="chip' + (curFilter === null ? ' on' : '') + '" data-tag="">전체</span>']
    .concat(tags.map(t => `<span class="chip${curFilter === t ? ' on' : ''}" data-tag="${t}">${t}</span>`));
  $('#optChips').innerHTML = chips.join('');
}

function renderNow() {
  const now = new Date();
  const slot = activeSlot();
  const type = TYPE_OF[slot];
  let pool = PLACES.filter(p => p.t === type && !p.to && openNow(p, now) !== false);
  if (curFilter) {
    pool = pool.filter(p => slot === 'meal' ? (p.f || []).includes(curFilter) : (p.v || []).includes(curFilter));
  }
  const ranked = pool
    .map(p => ({ p, s: scoreNow(p, now) + (openNow(p, now) === true ? 1.2 : 0) }))
    .sort((a, b) => b.s - a.s).map(x => x.p);
  // 풀 전체를 한 바퀴 다 돌 때까지 중복 0 — 다 돌면 초기화하고 새 순환
  let fresh = ranked.filter(p => !recent.includes(p.n));
  if (fresh.length < LIMIT) { recent = []; fresh = ranked; }
  const topPool = fresh.slice(0, Math.min(fresh.length, Math.max(LIMIT + 5, 12)));
  const picks = weightedSample(topPool, LIMIT)
    .sort((a, b) => (openNow(b, now) === true ? 1 : 0) - (openNow(a, now) === true ? 1 : 0));
  recent = recent.concat(picks.map(p => p.n));   // 누적: 한 바퀴 다 돌 때까지 계속 제외

  $('#slotLabel').textContent = curSlot === 'auto' ? SLOT_LABEL[slot] : ({ meal: '🍚 든든한 한 끼', cafe: '☕ 카페&디저트', bar: '🍻 술과 함께' })[slot];
  $('#slotSub').textContent = curFilter ? `'${curFilter}' 중에서 골라봤어요` : '지금 문 연 곳 중에서 골라봤어요';
  $('#nowList').innerHTML = picks.length
    ? picks.map(cardHTML).join('')
    : `<p class="empty">지금 시간엔 '${curFilter || type}' 추천이 없어요. 옵션이나 종류를 바꿔보세요.</p>`;
}

function renderContext() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0'), mm = String(now.getMinutes()).padStart(2, '0');
  $('#ctxTime').textContent = `${DAY_NAMES[now.getDay()]}요일 ${hh}:${mm} 기준`;
}

// 탭
$$('.seg').forEach(b => b.addEventListener('click', () => {
  $$('.seg').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  curSlot = b.dataset.slot;
  curFilter = null;          // 탭 바꾸면 옵션 초기화
  recent = [];               // 순환도 새로 시작
  renderChips();
  renderNow();
}));

// 옵션 칩 (위임)
$('#optChips').addEventListener('click', e => {
  const c = e.target.closest('.chip');
  if (!c) return;
  curFilter = c.dataset.tag || null;
  recent = [];
  renderChips();
  renderNow();
});

// 다른 곳 보기 (재추첨)
$('#shuffleBtn').addEventListener('click', renderNow);

// 피드백 — 페이지 안에서 메모 작성 → 백그라운드 전송(이동 없음)
function openFb() {
  $('#fbForm').style.display = '';
  $('#fbDone').style.display = 'none';
  $('#fbPlace').value = ''; $('#fbMemo').value = '';
  $('#fbModal').classList.add('show');
}
function closeFb() { $('#fbModal').classList.remove('show'); }
const fbBtn = $('#fbBtn');
if (fbBtn) fbBtn.addEventListener('click', openFb);
const fbCancel = $('#fbCancel');
if (fbCancel) fbCancel.addEventListener('click', closeFb);
const fbModal = $('#fbModal');
if (fbModal) fbModal.addEventListener('click', e => { if (e.target.id === 'fbModal') closeFb(); });
const fbSend = $('#fbSend');
if (fbSend) fbSend.addEventListener('click', async () => {
  const memo = $('#fbMemo').value.trim();
  if (!memo) { alert('내용을 입력해주세요.'); return; }
  const payload = { place: $('#fbPlace').value.trim(), memo, at: new Date().toISOString().slice(0, 16).replace('T', ' ') };
  fbSend.disabled = true;
  try {
    if (FEEDBACK_ENDPOINT) {
      // Apps Script는 text/plain + no-cors로 보내야 프리플라이트 없이 통과
      await fetch(FEEDBACK_ENDPOINT, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
    } else {
      console.log('피드백(전송처 미설정):', payload);
    }
    $('#fbDone').textContent = FEEDBACK_ENDPOINT ? '🙌 고맙습니다! 의견이 전달됐어요.' : '🙌 고맙습니다! 의견 수집을 곧 열게요.';
    $('#fbForm').style.display = 'none';
    $('#fbDone').style.display = '';
    setTimeout(closeFb, 1600);
  } catch (e) {
    alert('전송에 실패했어요. 잠시 후 다시 시도해주세요.');
  } finally {
    fbSend.disabled = false;
  }
});

// ── 섹션 오버레이 ──────────────────────────────────
function openSection(key) {
  const titleMap = { takeout: '🍱 포장·배달 (객실에서)', activity: '🏄 액티비티', beach: '🏖 해수욕장', festival: '🎉 고성 축제' };
  $('#secTitle').textContent = titleMap[key] || '';
  let html = '';
  if (key === 'takeout') {
    const list = PLACES.filter(p => p.to);
    html = list.length ? list.map(cardHTML).join('') : '<p class="empty">등록된 포장·배달 가게가 없어요.</p>';
  } else {
    html = '<p class="empty">🔧 준비 중이에요. 곧 채워집니다.</p>';
  }
  $('#secBody').innerHTML = html;
  $('#section').classList.add('show');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
$$('.navbtn').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.sec === 'course') { location.href = 'course.html'; return; }
  openSection(b.dataset.sec);
}));
$('#secClose').addEventListener('click', () => $('#section').classList.remove('show'));

// 시작
renderContext();
renderChips();
renderNow();
setInterval(() => { renderContext(); if (curSlot === 'auto') { renderChips(); renderNow(); } }, 60000);
