// 맹그로브 고성 — "지금 갈만한 곳" 홈
// 현재 시각 기준, 지금 문 연 곳 중에서 옵션(식성/분위기)에 맞춰 딱 3곳을 가중 추첨으로 추천.

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
const LIMIT = 3;                 // 추천 개수
// 든든한 한 끼 옵션 — 통합 카테고리 (라벨 → 포함 식성 태그)
const FOOD_GROUPS = [
  { label: '한식', tags: ['한식', '면', '분식'] },
  { label: '아시안', tags: ['아시안', '일식'] },
  { label: '양식', tags: ['양식'] },
  { label: '해산물', tags: ['해산물'] },
  { label: '고기', tags: ['고기'] },
];
// 술과 함께 옵션 — 종류별 (라벨 → 카테고리 포함어)
const BAR_GROUPS = [
  { label: '이자카야', cats: ['이자카야'] },
  { label: '바·맥주', cats: ['BAR', '바(BAR)', '맥주', '호프'] },
  { label: '요리주점·안주', cats: ['요리주점', '퓨전', '육류', '고기', '해물', '생선', '술집'] },
];
const FEEDBACK_ENDPOINT = 'https://script.google.com/macros/s/AKfycbyWVX0t2ciXvhz0l6eesmMYTxpgsfHlWotcmzxH5t8JhAEizxfnBEWDPrUFgr5ImXXj/exec';   // Apps Script → 슬랙 #gs-routine (브라우저 no-cors POST)

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

function cardHTML(p, idx) {
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
  const rv = p.rv ? `<span class="rv">★ ${p.rv[0]} (${p.rv[1]})</span>` : '';
  const num = idx ? `<span class="num">${idx}</span>` : '';
  return `<div class="card">
    ${p.img ? `<img class="ph" src="${p.img}" loading="lazy" alt="">` : ''}
    <div class="body">
      <div class="rk">${num}<span class="nm">${p.n}</span> ${badges.join(' ')}</div>
      <div class="ct">${p.c} · ${moveText(p)} ${rv}</div>
      <div class="info">${lines.join('<br>')}</div>
      <div class="links">${p.u ? `<a href="${p.u}" target="_blank" rel="noopener">네이버 지도에서 보기 →</a>` : ''}</div>
    </div>
  </div>`;
}

// 관광정보(TourAPI) 카드 — 영업시간/메뉴 없이 이름·거리·주소·전화·지도
function tourCardHTML(p) {
  const lines = [];
  if (p.addr) lines.push('📍 ' + p.addr);
  if (p.tel) lines.push('☎ ' + p.tel);
  return `<div class="card">
    ${p.img ? `<img class="ph" src="${p.img}" loading="lazy" alt="">` : ''}
    <div class="body">
      <div class="rk"><span class="nm">${p.n}</span></div>
      <div class="ct">${p.d != null ? moveText({ d: p.d }) : ''}</div>
      <div class="info">${lines.join('<br>')}</div>
      <div class="links"><a href="${p.u}" target="_blank" rel="noopener">네이버 지도에서 보기 →</a></div>
    </div>
  </div>`;
}

let curSlot = 'auto';
let curFilter = null;   // 선택된 옵션 태그 (식성/분위기), null=전체
let recent = [];        // 최근 보여준 가게 이름 — 중복 방지(돌아가며 노출)

function activeSlot() { return curSlot === 'auto' ? autoSlot(new Date()) : curSlot; }
function filtersFor(slot) {
  if (slot === 'meal') return FOOD_GROUPS.map(g => g.label);
  if (slot === 'bar') return BAR_GROUPS.map(g => g.label);
  return [];   // 카페: 옵션 없음
}

function renderChips() {
  const slot = activeSlot();
  const tags = curSlot === 'auto' ? [] : filtersFor(slot);
  if (!tags.length) { $('#optChips').innerHTML = ''; return; }   // 영업중·카페: 옵션 칩 없음
  const chips = ['<span class="chip' + (curFilter === null ? ' on' : '') + '" data-tag="">전체</span>']
    .concat(tags.map(t => `<span class="chip${curFilter === t ? ' on' : ''}" data-tag="${t}">${t}</span>`));
  $('#optChips').innerHTML = chips.join('');
}

function renderNow() {
  const now = new Date();
  const isAuto = curSlot === 'auto';
  const slot = activeSlot();
  const TYPES = ['식사', '카페', '술집'];
  let pool;
  if (isAuto) {
    // '영업중': 한 끼·카페·술 섞어서 (포장·배달 제외, 지금 문 연 곳)
    pool = PLACES.filter(p => TYPES.includes(p.t) && !p.to && openNow(p, now) !== false);
  } else {
    const type = TYPE_OF[slot];
    pool = PLACES.filter(p => p.t === type && !p.to && openNow(p, now) !== false);
    if (curFilter) {
      if (slot === 'meal') {
        const grp = FOOD_GROUPS.find(g => g.label === curFilter);
        const tags = grp ? grp.tags : [curFilter];
        pool = pool.filter(p => (p.f || []).some(f => tags.includes(f)));
      } else if (slot === 'bar') {
        const grp = BAR_GROUPS.find(g => g.label === curFilter);
        const cats = grp ? grp.cats : [curFilter];
        pool = pool.filter(p => cats.some(c => (p.c || '').includes(c)));
      }
    }
  }
  const biasType = TYPE_OF[autoSlot(now)];   // 섞되 시간대 적합 종류는 살짝 우대
  const ranked = pool
    .map(p => ({ p, s: scoreNow(p, now) + (openNow(p, now) === true ? 1.2 : 0) + (isAuto && p.t === biasType ? 1 : 0) }))
    .sort((a, b) => b.s - a.s).map(x => x.p);
  // 풀 전체를 한 바퀴 다 돌 때까지 중복 0 — 다 돌면 초기화하고 새 순환
  let fresh = ranked.filter(p => !recent.includes(p.n));
  if (fresh.length < LIMIT) { recent = []; fresh = ranked; }
  const topPool = fresh.slice(0, Math.min(fresh.length, Math.max(LIMIT + 5, 12)));
  const picks = weightedSample(topPool, LIMIT)
    .sort((a, b) => (openNow(b, now) === true ? 1 : 0) - (openNow(a, now) === true ? 1 : 0));
  recent = recent.concat(picks.map(p => p.n));   // 누적: 한 바퀴 다 돌 때까지 계속 제외

  $('#slotLabel').textContent = isAuto ? '영업중' : ({ meal: '든든한 한 끼', cafe: '카페', bar: '술과 함께' })[slot];
  $('#slotSub').textContent = isAuto ? '한 끼·카페·술 섞어서 골라봤어요' : (curFilter ? `'${curFilter}' 중에서 골라봤어요` : '지금 문 연 곳 중에서 골라봤어요');
  $('#nowList').innerHTML = picks.length
    ? picks.map((p, i) => cardHTML(p, i + 1)).join('')
    : `<p class="empty">지금 문 연 곳을 찾지 못했어요. 종류 탭이나 옵션을 바꿔보세요.</p>`;
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

// ── 기준별 모음 (거리 / CA강추 / 시간대) ──────────────
function opensEarly(p) {
  if (!p.h) return false;
  return Object.values(p.h).some(r => r && toMin(r.split('-')[0]) <= toMin('09:00'));
}
function opensLate(p) {
  if (!p.h) return false;
  return Object.values(p.h).some(r => {
    if (!r) return false;
    const [s, e] = r.split('-'); let st = toMin(s), en = toMin(e); if (en <= st) en += 1440;
    return en >= toMin('22:00');
  });
}
const REAL = ['식사', '카페', '술집'];
const COLL = {
  walk: {
    title: '🚶 걸어서 갈 곳', note: '맹그로브 고성 기준 거리예요.',
    subs: [['도보', '도보권'], ['고성', '차로 금방(고성)'], ['속초', '멀어도 OK(속초)']],
    list: sub => PLACES.filter(p => !p.to && REAL.includes(p.t) && p.z === sub),
  },
  capick: {
    title: '💚 CA 강추', note: 'CA가 직접 가본 찐 추천만 모았어요.', subs: null,
    list: () => PLACES.filter(p => p.ca && !p.to),
  },
  time: {
    title: '🎯 아침·심야', note: '',
    subs: [['early', '🌅 아침 되는 곳'], ['late', '🌙 심야 영업']],
    list: sub => PLACES.filter(p => !p.to && REAL.includes(p.t) && (sub === 'late' ? opensLate(p) : opensEarly(p))),
  },
  makguksu: {
    title: '🍜 고성 막국수 모음', note: '고성·속초의 막국수집을 모았어요. (거리순)', subs: null,
    list: () => PLACES.filter(p => !p.to && ((p.n || '').includes('막국수') || (p.m || []).some(m => m.includes('막국수')))),
  },
};
function renderCollection(key, sub) {
  const c = COLL[key];
  if (c.subs && !sub) sub = c.subs[0][0];
  const list = c.list(sub).slice().sort((a, b) => (a.d == null ? 9e9 : a.d) - (b.d == null ? 9e9 : b.d));
  const chips = c.subs ? '<div class="chips" style="margin:0 0 8px">' +
    c.subs.map(([v, l]) => `<span class="chip${v === sub ? ' on' : ''}" data-coll="${key}" data-sub="${v}">${l}</span>`).join('') + '</div>' : '';
  const noteHtml = c.note ? `<div class="notice" style="margin:0 0 6px">${c.note}</div>` : '';
  $('#secBody').innerHTML = chips + noteHtml + (list.length ? list.map(p => cardHTML(p)).join('') : '<p class="empty">해당하는 곳이 없어요.</p>');
}

// ── 고성·속초 대표 축제 (큐레이션, 매년 시기 약간 변동 → 검색 링크로) ──
const FESTIVALS = [
  { n: '화진포 해맞이축제', when: '1월 1일', m: [1], where: '화진포해변', region: '고성' },
  { n: '저도 대문어축제', when: '6월', m: [6], where: '대진항', region: '고성' },
  { n: '속초 칠링비치 페스티벌', when: '8월', m: [8], where: '속초해변', region: '속초' },
  { n: '고성 수성문화제', when: '9월', m: [9], where: '간성 고성종합운동장', region: '고성' },
  { n: '고성명태축제', when: '10월', m: [10], where: '거진 해변', region: '고성' },
  { n: '설악문화제', when: '10월', m: [10], where: '속초 일원', region: '속초' },
  { n: '속초 양미리·도루묵 축제', when: '11월', m: [11], where: '속초항', region: '속초' },
];
function renderFestivalsHTML() {
  const mo = new Date().getMonth() + 1;
  const sorted = FESTIVALS.slice().sort((a, b) => (b.m.includes(mo) ? 1 : 0) - (a.m.includes(mo) ? 1 : 0));
  const note = '<div class="notice" style="margin:0 0 8px">🎉 고성·속초 대표 축제예요. 매년 시기가 조금씩 달라지니 정확한 일정은 링크에서 확인하세요.</div>';
  return note + sorted.map(f => {
    const now = f.m.includes(mo);
    const url = 'https://search.naver.com/search.naver?query=' + encodeURIComponent(f.n + ' 일정');
    return `<div class="card"><div class="body">
      <div class="rk"><span class="nm">${f.n}</span> <span class="b ${now ? 'open' : 'chk'}">${now ? '🔴 이번 달' : f.when}</span></div>
      <div class="ct">${f.region} · ${f.where}${now ? ' · ' + f.when : ''}</div>
      <div class="links"><a href="${url}" target="_blank" rel="noopener">일정·정보 검색 →</a></div>
    </div></div>`;
  }).join('');
}

// ── 섹션 오버레이 ──────────────────────────────────
function openSection(key) {
  const titleMap = { takeout: '🍱 포장·배달 (객실에서)', activity: '🏄 액티비티', beach: '🏖 해수욕장', festival: '🎉 고성·속초 축제', walk: '🚶 걸어서 갈 곳', capick: '💚 CA 강추', time: '🎯 아침·심야' };
  $('#secTitle').textContent = (COLL[key] && COLL[key].title) || titleMap[key] || '';
  if (COLL[key]) { renderCollection(key); $('#section').classList.add('show'); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  let html = '';
  const tourNote = '<div class="notice" style="margin-top:0;margin-bottom:6px">📍 한국관광공사 정보 기반이에요. 방문 전 운영 여부를 확인해보세요.</div>';
  if (key === 'takeout') {
    const list = PLACES.filter(p => p.to);
    html = list.length ? list.map(p => cardHTML(p)).join('') : '<p class="empty">등록된 포장·배달 가게가 없어요.</p>';
  } else if (key === 'activity' && typeof TOUR !== 'undefined') {
    html = tourNote + TOUR.activities.map(tourCardHTML).join('');
  } else if (key === 'beach' && typeof TOUR !== 'undefined') {
    html = tourNote + TOUR.beaches.map(tourCardHTML).join('');
  } else if (key === 'festival') {
    html = renderFestivalsHTML();
  } else {
    html = '<p class="empty">🔧 준비 중이에요. 곧 채워집니다.</p>';
  }
  $('#secBody').innerHTML = html;
  $('#section').classList.add('show');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
$$('.navbtn').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.sec === 'course') { location.href = 'course.html'; return; }
  if (b.dataset.sec === 'course3') { location.href = 'course3.html'; return; }
  openSection(b.dataset.sec);
}));
$('#secClose').addEventListener('click', () => $('#section').classList.remove('show'));
// 모음 하위 옵션(거리/시간대) 토글
$('#secBody').addEventListener('click', e => {
  const c = e.target.closest('[data-coll]');
  if (c) renderCollection(c.dataset.coll, c.dataset.sub);
});

// 시작
renderContext();
renderChips();
renderNow();
setInterval(() => { renderContext(); if (curSlot === 'auto') { renderChips(); renderNow(); } }, 60000);
