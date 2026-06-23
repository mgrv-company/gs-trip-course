// 맹그로브 고성 — "지금 갈만한 곳" 홈
// 데이터: places.js (PLACES). 현재 시각 기준으로 지금 문 연·가까운·안 붐비는 곳을 추천.

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

function toMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }

// 지금 영업 중인가? true / false(휴무·영업외) / null(정보없음)
function openNow(p, now) {
  if (!p.h) return null;
  const day = DAY_NAMES[now.getDay()];
  if (!(day in p.h)) return null;
  const range = p.h[day];
  if (range === null) return false;
  const [s, e] = range.split('-');
  const t = now.getHours() * 60 + now.getMinutes();
  let start = toMin(s), end = toMin(e);
  if (end <= start) end += 1440;            // 새벽까지 영업 (예: 17:00~02:00)
  if (t >= start && t <= end - 20) return true;
  if (t + 1440 >= start && t + 1440 <= end - 20) return true; // 자정 넘긴 시간대 보정
  return false;
}

// 시간대 → 기본 추천 종류
function autoSlot(now) {
  const h = now.getHours();
  if (h >= 5 && h < 10) return 'cafe';      // 아침
  if (h >= 10 && h < 14) return 'meal';     // 점심
  if (h >= 14 && h < 17) return 'cafe';     // 오후 카페
  if (h >= 17 && h < 21) return 'meal';     // 저녁
  return 'bar';                              // 밤
}
const SLOT_LABEL = { meal: '🍚 지금은 밥때', cafe: '☕ 카페 타임', bar: '🍻 한잔하기 좋은 시간' };
const TYPE_OF = { meal: '식사', cafe: '카페', bar: '술집' };

function zoneRank(z) { return z === '도보' ? 3 : z === '고성' ? 1.5 : 0; }

// 추천 점수: 가까움 + 평점 + CA강추 - 지금 붐빔
function scoreNow(p, now) {
  let s = Math.random() * 1.2;
  s += zoneRank(p.z);
  if (p.ca) s += 3;
  if (p.rv) { const [r, c] = p.rv; s += Math.max(-1, Math.min(1.6, (r - 4.2) * 2)); s += Math.min(1.4, Math.log10(c + 1) * 0.55); }
  const peak = (now.getHours() >= 12 && now.getHours() < 13) || (now.getHours() >= 18 && now.getHours() < 20);
  if (peak && p.w === 2) s -= 1.3;
  if (p.w === 0) s += 0.4;
  return s;
}

function moveText(p) {
  if (p.d <= 1.2) return '도보 ' + Math.max(3, Math.round(p.d * 15)) + '분';
  return '차 ' + (Math.round(p.d / 50 * 60) + 3) + '분';
}
function hoursNowText(p) {
  if (!p.h) return '영업시간 미상 · 방문 전 확인';
  const day = DAY_NAMES[new Date().getDay()];
  const range = p.h[day];
  if (range === null || range === undefined) return '오늘 휴무 ⚠️';
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
function renderNow() {
  const now = new Date();
  const slot = curSlot === 'auto' ? autoSlot(now) : curSlot;
  const type = TYPE_OF[slot];
  let pool = PLACES.filter(p => p.t === type && !p.to);   // 포장·배달 제외
  // 지금 영업중(또는 정보없음) 우선, 휴무·영업외 제외
  pool = pool.filter(p => openNow(p, now) !== false);
  const ranked = pool.map(p => ({ p, s: scoreNow(p, now) + (openNow(p, now) === true ? 1.5 : 0) }))
    .sort((a, b) => b.s - a.s).slice(0, 8).map(x => x.p);

  $('#slotLabel').textContent = curSlot === 'auto' ? SLOT_LABEL[slot] : ({ meal: '🍚 밥집', cafe: '☕ 카페', bar: '🍻 술집' })[slot];
  $('#nowList').innerHTML = ranked.length
    ? ranked.map(cardHTML).join('')
    : '<p class="empty">지금 시간엔 마땅한 곳이 없어요. 다른 종류를 눌러보세요.</p>';
}

// 컨텍스트 바 (현재 시각/요일)
function renderContext() {
  const now = new Date();
  const day = DAY_NAMES[now.getDay()];
  const hh = String(now.getHours()).padStart(2, '0'), mm = String(now.getMinutes()).padStart(2, '0');
  $('#ctxTime').textContent = `${day}요일 ${hh}:${mm} 기준`;
}

// 탭
$$('.seg').forEach(b => b.addEventListener('click', () => {
  $$('.seg').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  curSlot = b.dataset.slot;
  renderNow();
}));

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
function closeSection() { $('#section').classList.remove('show'); }
$$('.navbtn').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.sec === 'course') { location.href = 'course.html'; return; }
  openSection(b.dataset.sec);
}));
$('#secClose').addEventListener('click', closeSection);

// 시작
renderContext();
renderNow();
// 1분마다 컨텍스트/추천 갱신 (시간대 넘어가면 자동 전환)
setInterval(() => { renderContext(); if (curSlot === 'auto') renderNow(); }, 60000);
