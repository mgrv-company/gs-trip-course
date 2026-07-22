// 맹그로브 고성 — "지금 갈만한 곳" 홈
// 현재 시각 기준, 지금 문 연 곳 중에서 옵션(식성/분위기)에 맞춰 딱 3곳을 가중 추첨으로 추천.

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
// HTML 이스케이프 — 데이터(가게명·메모 등)를 화면에 꽂기 전 특수문자 무력화 (저장형 XSS 방지)
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 이미지 URL http→https 승격 (CSP img-src가 http 차단 → 사진 누락 방지)
const httpsUp = u => String(u == null ? '' : u).replace(/^http:\/\//i, 'https://');
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
// 어드민 백엔드 — 편집 오버레이 + 피드백 수신(→슬랙 #gs-routine). 장애 시엔 스냅샷만으로 정상 동작.
// (2026-07-07 피드백을 Apps Script → Worker로 전환. 토큰검증·입력검증·횟수제한은 Worker가 담당)
const ADMIN_API = 'https://gs-trip-admin.mangrove-goseong.workers.dev';
const FEEDBACK_ENDPOINT = ADMIN_API + '/feedback';
// 공개 사이트라 이 값도 공개됨 — '완전 차단'이 아니라 장난성 방지용 speed-bump.
const FB_TOKEN = 'gst-2026a';
const SETTINGS_API = ADMIN_API + '/public/settings';

// 어드민 "문구·디자인" 탭에서 편집 가능한 메인 문구 — 기본값.
// /public/settings 응답이 오면 같은 key 를 덮어씀. 응답이 없거나 비면 이 기본값 그대로.
const COPY = {
  'hero.title': '지금 어디로 갈까요?',
  'hero.sub': '커뮤니티 매니저가 추천하는 가게들',
  'beachmini.title': '해수욕장',
  'beachmini.sub': '맹그로브에서 가까운 순서대로 추천해요.',
  'attrmini.title': '즐길 곳',
  'attrmini.sub': '고성에서 즐길 거리와 볼 거리를 모아 소개해요.',
  'seg.auto': '영업중',
  'seg.meal': '든든한 한 끼',
  'seg.cafe': '느낌 좋은 카페',
  'seg.bar': '술과 함께',
  'slotsub.auto': '메뉴에 상관없이 지금 영업 중인 가게를 추천해요.',
  'slotsub.meal': '식사가 될 수 있을만한 가게들로 추천해요.',
  'slotsub.cafe': '카페부터 베이커리, 젤라또까지 다양하게 추천해요.',
  'slotsub.bar': '노포부터 이자카야까지, 술 한 잔 하기 좋은 곳을 추천해요.',
  'feedback.title': '다녀온 가게, 어떠셨어요?',
  'feedback.body': '소중한 의견을 모아 더욱 유용한 서비스로 만들게요.\n솔직하게 적어주시면 큰 도움이 돼요.',
  'feedback.btnFb': '✍️ 추천받은 가게 피드백 남기기',
  'feedback.btnSuggest': '📌 리스트에 없었던 가게 추천하기',
  'rating.title': '이 추천 서비스는 어떠셨어요?',
  'rating.body': "원하는 별점을 누르고, 아래 '별점 추가하기' 버튼을 눌러주세요.",
  'rating.placeholder': '어떤 부분이 도움이 되었는지 적어주세요. 혹은 필요한 정보가 있다면 적어주셔도 좋아요.',
  'rating.btn': '별점 추가하기',
  'rating.done': '🙌 감사합니다! 더 좋은 추천으로 보답할게요.',
  'fb.title': '가게 피드백',
  'fb.desc': '좋았어요·아쉬웠어요·문 닫았더라고요 — 뭐든 좋아요. 남겨주신 의견은 커뮤니티 매니저에게 바로 전달돼요. 30초면 충분해요!',
  'fb.place': '가게 이름 (기억나는 만큼만)',
  'fb.memo': '예: 여기 진짜 좋았어요! / 웨이팅 1시간이었어요 / 문 닫았던데요',
  'fb.done': '🙌 고맙습니다! 의견이 전달됐어요.',
  'sg.title': '좋았던 곳 추천',
  'sg.desc': '추천 리스트에 없는데 좋았던 가게가 있나요? 알려주시면 커뮤니티 매니저가 다녀와 보고 리스트에 올릴게요.',
  'sg.place': '가게 이름 (필수)',
  'sg.memo': '어떤 점이 좋았나요? 위치·메뉴 등 아는 만큼만 적어주세요 (선택)',
  'sg.name': '이름 (선택)',
  'sg.done': '고맙습니다! 다녀와 보고 리스트에 올려볼게요.',
};

function toMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
// 전송 시각 — 손님 기기의 현지 시각(KST) 기준. toISOString()은 UTC라 9시간 어긋나서 쓰면 안 됨
function localAt() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

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
  if (p.ca) badges.push('<span class="b ca">📌 강추</span>');
  if (p.r) badges.push('<span class="b rsv">☎ 예약</span>');
  const open = openNow(p, new Date());
  if (open === true) badges.push('<span class="b open">● 영업중</span>');
  else if (open === null) badges.push('<span class="b chk">시간 미상</span>');
  // 메뉴: 조용한 한 줄
  const menu = (p.m && p.m.length) ? `<div class="info">🍽 ${p.m.map(esc).join(' · ')}</div>` : '';
  // 영업시간·대기: 조용한 chip (영업시간 숫자는 tabular mono)
  const chips = [`<span class="mchip num-mono">🕐 ${esc(hoursNowText(p))}</span>`];
  const wt = waitText(p);
  if (wt) chips.push(`<span class="mchip${p.w === 2 ? ' warn' : ''}">${esc(wt)}</span>`);
  const chipRow = `<div class="metachips">${chips.join('')}</div>`;
  // CA·큐레이터 한 줄 코멘트: 차별점이라 승격 (있을 때만)
  const memo = p.note || p.mr;
  const cacmt = memo ? `<div class="cacmt">💬 ${esc(memo)}</div>` : '';
  const rv = p.rv ? `<span class="rv num-mono">★ ${esc(p.rv[0])} (${esc(p.rv[1])})</span>` : '';
  const num = idx ? `<span class="num">${idx}</span>` : '';
  return `<div class="card">
    ${p.img ? `<img class="ph" src="${esc(p.img)}" loading="lazy" alt="" referrerpolicy="no-referrer">` : ''}
    <div class="body">
      <div class="rk">${num}<span class="nm">${esc(p.n)}</span>${badges.length ? ` <span class="badges">${badges.join('')}</span>` : ''}</div>
      <div class="ct">${esc(p.c)} · <span class="num-mono">${moveText(p)}</span> ${rv}</div>
      ${menu}
      ${chipRow}
      ${cacmt}
      <div class="links">${p.u ? `<a href="${esc(p.u)}" target="_blank" rel="noopener" data-clk="1" data-sid="${esc(p.s || '')}" data-name="${esc(p.n || '')}">네이버 지도에서 보기 →</a>` : ''}</div>
    </div>
  </div>`;
}

// 해수욕장 전용 카드 — 입장료·영업시간·웨이팅은 의미 없어서 빼고, 평점·맹그로브 기준 차량 이동시간만 표시
function beachCardHTML(p) {
  const rv = p.rv ? `<span class="rv num-mono">★ ${esc(p.rv[0])} (${esc(p.rv[1])})</span>` : '';
  const driveMin = Math.round((p.d || 0) / 50 * 60) + 3;
  const memo = p.note || p.mr;
  const cacmt = memo ? `<div class="cacmt">💬 ${esc(memo)}</div>` : '';
  // 구역(z)은 거리 버킷이라 실제 행정구역과 다를 수 있어(멀면 다 '속초'로 뭉뚱그려짐) 주소 문자열로 판단
  const region = (p.a || '').includes('속초시') ? '속초' : '고성';
  const hot = p.rv && p.rv[1] >= 100 ? '<span class="b hot">🔥 HOT</span>' : '';
  return `<div class="card">
    ${p.img ? `<img class="ph" src="${esc(p.img)}" loading="lazy" alt="" referrerpolicy="no-referrer">` : ''}
    <div class="body">
      <div class="rk"><span class="nm">${esc(p.n)}</span>${hot ? ` <span class="badges">${hot}</span>` : ''}</div>
      <div class="ct">${esc(region)} · <span class="num-mono">🚗 맹그로브에서 차로 ${driveMin}분</span>${rv}</div>
      ${cacmt}
      <div class="links">${p.u ? `<a href="${esc(p.u)}" target="_blank" rel="noopener" data-clk="1" data-sid="${esc(p.s || '')}" data-name="${esc(p.n || '')}">네이버 지도에서 보기 →</a>` : ''}</div>
    </div>
  </div>`;
}

// 즐길 곳(명소) 전용 — 영업시간·별점 없이 맹그로브 기준 도보/차량 이동시간만
function moveTextSimple(p) {
  if (p.d <= 1.2) return '🚶 ' + Math.max(3, Math.round(p.d * 15)) + '분';
  return '🚗 ' + (Math.round(p.d / 50 * 60) + 3) + '분';
}
function attractionCardHTML(p) {
  return `<div class="card">
    ${p.img ? `<img class="ph" src="${esc(p.img)}" loading="lazy" alt="" referrerpolicy="no-referrer">` : ''}
    <div class="body">
      <div class="rk"><span class="nm">${esc(p.n)}</span></div>
      <div class="ct"><span class="num-mono">${moveTextSimple(p)}</span></div>
      <div class="links">${p.u ? `<a href="${esc(p.u)}" target="_blank" rel="noopener" data-clk="1" data-sid="${esc(p.s || '')}" data-name="${esc(p.n || '')}">네이버 지도에서 보기 →</a>` : ''}</div>
    </div>
  </div>`;
}
// 즐길 곳 전체보기 — 자연명소/그 외 탭 (nat: 1=자연명소, 0/미기재=그 외)
function renderAttractionSection(sub) {
  const byDist = arr => arr.slice().sort((a, b) => (a.d == null ? 9e9 : a.d) - (b.d == null ? 9e9 : b.d));
  const list = byDist(PLACES.filter(p => p.t === '명소' && !p.x && (sub === 'natural' ? p.nat === 1 : p.nat !== 1)));
  const tabs = `<div class="chips" style="margin:0 0 10px">
    <span class="chip${sub === 'natural' ? ' on' : ''}" data-attrsub="natural">자연명소</span>
    <span class="chip${sub === 'nonnatural' ? ' on' : ''}" data-attrsub="nonnatural">그 외 볼거리</span>
  </div>`;
  $('#secBody').innerHTML = tabs + (list.length ? list.map(p => attractionCardHTML(p)).join('') : '<p class="empty">해당하는 곳이 없어요. 다른 탭을 눌러보세요.</p>');
}

// 관광정보(TourAPI) 카드 — 영업시간/메뉴 없이 이름·거리·주소·전화·지도
function tourCardHTML(p) {
  const lines = [];
  if (p.addr) lines.push('📍 ' + esc(p.addr));
  if (p.tel) lines.push('☎ ' + esc(p.tel));
  return `<div class="card">
    ${p.img ? `<img class="ph" src="${esc(p.img)}" loading="lazy" alt="" referrerpolicy="no-referrer">` : ''}
    <div class="body">
      <div class="rk"><span class="nm">${esc(p.n)}</span></div>
      <div class="ct">${p.d != null ? moveText({ d: p.d }) : ''}</div>
      <div class="info">${lines.join('<br>')}</div>
      <div class="links"><a href="${esc(p.u)}" target="_blank" rel="noopener" data-clk="1" data-name="${esc(p.n || '')}">네이버 지도에서 보기 →</a></div>
    </div>
  </div>`;
}

// 가게 카드(큰 사진 + 정보 2줄 그룹 + CA + 지도). isPick=true 면 'PICK' 배지.
// 추천 1위와 '이어서 추천' 펼침 카드가 동일한 렌더를 공유한다.
function placeCardHTML(p, isPick) {
  const open = openNow(p, new Date());
  const rec = p.ca ? '<span class="rec-tag">추천</span>' : '';
  const openTxt = open === true ? '<span class="op">● 영업중</span> · ' : (open === null ? '<span class="op chk">시간 미상</span> · ' : '');
  const wait = p.w === 2 ? ' · <span class="wt">웨이팅 잦음</span>' : '';
  // 1줄: 영업상태 + 거리 + 영업시간 (지금·어디로 가는지)
  const line1 = `<div class="hmeta">${openTxt}<span class="num-mono">${moveText(p)}</span> · <span class="num-mono">${esc(hoursNowText(p))}</span>${wait}</div>`;
  // 2줄: 별점 + 메뉴 (무엇을 얼마에)
  const rv = p.rv ? `<span class="num-mono">★ ${esc(p.rv[0])}</span> <span class="dimc">(${esc(p.rv[1])})</span>` : '';
  const menu = (p.m && p.m.length) ? `${p.rv ? ' · ' : ''}🍽 ${p.m.slice(0, 2).map(esc).join(' · ')}` : '';
  const line2 = (rv || menu) ? `<div class="hmeta2">${rv}${menu}</div>` : '';
  const memo = p.note || p.mr;
  const cmt = memo ? `<p class="hcmt">${esc(memo)}</p>` : '';
  const link = p.u ? `<a class="hlink" href="${esc(p.u)}" target="_blank" rel="noopener" data-clk="1" data-sid="${esc(p.s || '')}" data-name="${esc(p.n || '')}">네이버 지도에서 보기 →</a>` : '';
  const tag = isPick ? '<span class="htag">PICK</span>' : '';
  return `<article class="hcard">
    ${p.img ? `<div class="hpic"><img class="card-img" src="${esc(httpsUp(p.img))}" loading="lazy" alt="">${tag}</div>` : ''}
    <div class="hbd">
      <div class="hnm">${esc(p.n)}${rec}</div>
      ${line1}${line2}${cmt}${link}
    </div>
  </article>`;
}
function heroCardHTML(p) { return placeCardHTML(p, true); }

// 미니 행 — 추천 2위 이하. 접혀 있다가 클릭하면 1위와 '동일한 카드'로 펼쳐짐.
function miniRowHTML(p) {
  const open = openNow(p, new Date());
  const openBadge = open === true ? '<span class="op sm">영업중</span>' : (open === null ? '<span class="op sm chk">시간 미상</span>' : '');
  const rec = p.ca ? '<span class="rec-tag sm">추천</span>' : '';
  const rv = p.rv ? `<span class="num-mono">★ ${esc(p.rv[0])}</span> · ` : '';
  const wait = p.w === 2 ? ' · <span class="wt">웨이팅</span>' : '';
  return `<div class="mitem">
    <div class="mrow" role="button" tabindex="0" aria-expanded="false">
      <div class="mbd">
        <div class="mtop"><span class="mnm">${esc(p.n)}${rec}</span></div>
        <div class="mmeta">${rv}<span class="num-mono">${moveText(p)}</span> · <span class="num-mono">${esc(hoursNowText(p))}</span>${wait}</div>
      </div>
      ${openBadge}
      <span class="mchev" aria-hidden="true">▾</span>
    </div>
    <div class="mdetail">${placeCardHTML(p, false)}<button class="mcollapse" type="button">접기 ▲</button></div>
  </div>`;
}

// 노출 집계 — 추천 리스트에 보여진 가게들을 렌더마다 1회(디바운스) 비콘. 손님만(어드민 제외).
// 클릭÷노출 = CTR(어드민 '인기 가게'에서 확인). 로드 시 여러 번 렌더돼도 디바운스로 1회만 전송.
let _impTimer = null, _impItems = [];
function queueImpressions(picks) {
  try { if (localStorage.getItem('gstAdminSession')) return; } catch (e) { return; }   // 어드민 방문은 노출 집계 제외
  _impItems = picks.map(p => ({ sid: String(p.s || ''), name: String(p.n || '') })).filter(x => x.sid || x.name);
  if (_impTimer) clearTimeout(_impTimer);
  _impTimer = setTimeout(function () {
    if (!_impItems.length) return;
    // text/plain 기본 → 프리플라이트 없는 단순요청. keepalive 로 탭 이동에도 전송 보장.
    fetch(ADMIN_API + '/impression', { method: 'POST', keepalive: true, body: JSON.stringify({ items: _impItems.slice(0, 10) }) })
      .catch(function (e) { console.debug('impression beacon 실패(무시 가능):', e && e.message); });
  }, 1200);
}

// 화면 UI 이벤트(탭 전환·하단 모음 열람) 집계 — 손님만(어드민 제외), 어떤 진입점이 실제로 쓰이는지 확인용
function sendEvent(key) {
  try { if (localStorage.getItem('gstAdminSession')) return; } catch (e) { return; }
  fetch(ADMIN_API + '/event', { method: 'POST', keepalive: true, body: JSON.stringify({ key: key }) })
    .catch(function (e) { console.debug('event beacon 실패(무시 가능):', e && e.message); });
}

// 사진 로드 실패 시 대체 이미지 — 네이버 사진이 깨지면 차라리 다른 이미지. (CSP상 인라인 onerror 불가 → 위임 캡처)
document.addEventListener('error', function (e) {
  const t = e.target;
  if (t && t.tagName === 'IMG' && t.classList && t.classList.contains('card-img') && t.dataset.fb !== '1') {
    t.dataset.fb = '1';
    t.style.display = 'none';
    const pic = t.closest('.hpic');
    if (pic) pic.classList.add('noimg');   // 가짜 가게사진 오해 방지 → 중립 플레이스홀더
  }
}, true);

let curSlot = 'auto';
let curFilter = null;   // 선택된 옵션 태그 (식성/분위기), null=전체
let recent = [];        // 최근 보여준 가게 이름 — 중복 방지(돌아가며 노출)

function activeSlot() { return curSlot === 'auto' ? autoSlot(new Date()) : curSlot; }
function filtersFor(slot) {
  if (slot === 'meal') return FOOD_GROUPS.map(g => g.label);
  return [];   // 카페·술: 옵션 없음
}

function renderChips() {
  const slot = activeSlot();
  const tags = curSlot === 'auto' ? [] : filtersFor(slot);
  if (!tags.length) { $('#optChips').innerHTML = ''; return; }   // 영업중·카페: 옵션 칩 없음
  const chips = ['<span class="chip' + (curFilter === null ? ' on' : '') + '" role="button" tabindex="0" data-tag="">전체</span>']
    .concat(tags.map(t => `<span class="chip${curFilter === t ? ' on' : ''}" role="button" tabindex="0" data-tag="${t}">${t}</span>`));
  $('#optChips').innerHTML = chips.join('');
}

function renderNow() {
  const now = new Date();
  const isAuto = curSlot === 'auto';
  const slot = activeSlot();
  const TYPES = ['식사', '카페', '술집'];
  let pool;
  if (isAuto) {
    // '영업중': 한 끼·카페·술 섞어서 (제외·포장·배달 빼고, 지금 문 연 곳)
    pool = PLACES.filter(p => TYPES.includes(p.t) && !p.x && !p.to && openNow(p, now) !== false);
  } else {
    const type = TYPE_OF[slot];
    pool = PLACES.filter(p => p.t === type && !p.x && !p.to && openNow(p, now) !== false);
    if (curFilter && slot === 'meal') {
      const grp = FOOD_GROUPS.find(g => g.label === curFilter);
      const tags = grp ? grp.tags : [curFilter];
      pool = pool.filter(p => (p.f || []).some(f => tags.includes(f)));
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

  $('#slotLabel').textContent = isAuto ? COPY['seg.auto'] : COPY['seg.' + slot];
  $('#slotSub').textContent = isAuto ? COPY['slotsub.auto'] : COPY['slotsub.' + slot];
  $('#nowList').innerHTML = picks.length
    ? heroCardHTML(picks[0]) + (picks.length > 1 ? '<div class="subrec">이어서 추천</div>' + picks.slice(1).map(miniRowHTML).join('') : '')
    : `<p class="empty">지금 문 연 곳을 찾지 못했어요. 종류 탭이나 옵션을 바꿔보세요.</p>`;
  if (picks.length) queueImpressions(picks);   // 보여준 가게 노출 집계(CTR용)
}

function renderContext() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0'), mm = String(now.getMinutes()).padStart(2, '0');
  $('#ctxTime').textContent = `${now.getMonth() + 1}월 ${now.getDate()}일 (${DAY_NAMES[now.getDay()]}) ${hh}:${mm} 기준`;
}

// 탭
$$('.seg').forEach(b => b.addEventListener('click', () => {
  $$('.seg').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  curSlot = b.dataset.slot;
  curFilter = null;          // 탭 바꾸면 옵션 초기화
  recent = [];               // 순환도 새로 시작
  sendEvent('tab:' + curSlot);
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

// 이어서 추천: 미니 행 클릭 → 접힘/펼침 (지도 링크 클릭은 이동 그대로). #nowList는 유지되므로 위임 1회.
$('#nowList').addEventListener('click', function (e) {
  if (e.target.closest('a')) return;                      // 지도 링크는 이동
  const trigger = e.target.closest('.mrow, .mcollapse');  // 행=펼침 / 접기버튼=닫기
  if (!trigger) return;
  const item = trigger.closest('.mitem');
  if (!item) return;
  const opened = item.classList.toggle('open');
  const row = item.querySelector('.mrow');
  if (row) row.setAttribute('aria-expanded', opened ? 'true' : 'false');
  if (!opened) row && row.focus();                        // 접으면 행으로 포커스 복귀
});
$('#nowList').addEventListener('keydown', function (e) {
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  const row = e.target.closest('.mrow');
  if (!row) return;
  e.preventDefault();
  row.click();
});

// 피드백/추천 — 같은 팝업을 모드에 따라 문구만 바꿔 사용 (페이지 안에서 전송, 이동 없음)
let fbMode = 'fb';   // 'fb' 가게 피드백 / 'suggest' 좋았던 곳 추천
// COPY(어드민 편집 반영)에서 현재 문구를 뽑아 씀 — 클릭 시점 값이라 편집이 바로 반영됨
function fbTexts(mode) {
  const pre = mode === 'suggest' ? 'sg' : 'fb';
  return {
    title: COPY[pre + '.title'], desc: COPY[pre + '.desc'],
    place: COPY[pre + '.place'], memo: COPY[pre + '.memo'], done: COPY[pre + '.done'],
  };
}
// 인라인 오류 메시지 (브라우저 alert 대체) — 팝업 대신 폼 안에 부드럽게 표시
function showFbErr(msg) { const e = $('#fbErr'); if (e) { e.textContent = msg; e.classList.add('show'); } }
function hideFbErr() { const e = $('#fbErr'); if (e) { e.textContent = ''; e.classList.remove('show'); } }

function openFb(mode) {
  fbMode = mode === 'suggest' ? 'suggest' : 'fb';
  const t = fbTexts(fbMode);
  hideFbErr();
  $('#fbTitle').textContent = t.title;
  $('#fbDesc').textContent = t.desc;
  $('#fbPlace').placeholder = t.place;
  $('#fbMemo').placeholder = t.memo;
  // 성함칸은 '좋았던 곳 추천'에서만 노출 (일반 피드백엔 없음)
  $('#fbName').placeholder = COPY['sg.name'];
  $('#fbName').style.display = fbMode === 'suggest' ? '' : 'none';
  $('#fbForm').style.display = '';
  $('#fbDone').style.display = 'none';
  $('#fbPlace').value = ''; $('#fbMemo').value = ''; $('#fbName').value = '';
  $('#fbModal').classList.add('show');
}
function closeFb() { $('#fbModal').classList.remove('show'); }
const fbBtn = $('#fbBtn');
if (fbBtn) fbBtn.addEventListener('click', () => openFb('fb'));
const sgBtn = $('#sgBtn');
if (sgBtn) sgBtn.addEventListener('click', () => openFb('suggest'));
const fbCancel = $('#fbCancel');
if (fbCancel) fbCancel.addEventListener('click', closeFb);
const fbModal = $('#fbModal');
if (fbModal) fbModal.addEventListener('click', e => { if (e.target.id === 'fbModal') closeFb(); });
const fbSend = $('#fbSend');
if (fbSend) fbSend.addEventListener('click', async () => {
  const memo = $('#fbMemo').value.trim().slice(0, 500);
  const place = $('#fbPlace').value.trim().slice(0, 100);
  hideFbErr();
  if (fbMode === 'suggest') {
    if (!place) { showFbErr('가게 이름을 입력해주세요.'); return; }
  } else if (!memo) { showFbErr('내용을 입력해주세요.'); return; }
  const payload = { place, memo, at: localAt(), t: FB_TOKEN };
  if (fbMode === 'suggest') { payload.kind = 'suggest'; payload.name = $('#fbName').value.trim().slice(0, 40); }
  fbSend.disabled = true;
  try {
    // Worker는 CORS를 제대로 지원 → 응답 확인까지 가능 (옛 Apps Script no-cors 꼼수 불필요)
    const r = await fetch(FEEDBACK_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
    if (!r.ok) throw new Error('전송 실패 ' + r.status);
    $('#fbDone').textContent = fbTexts(fbMode).done;
    $('#fbForm').style.display = 'none';
    $('#fbDone').style.display = '';
    setTimeout(closeFb, 1600);
  } catch (e) {
    showFbErr('전송에 실패했어요. 잠시 후 다시 시도해주세요.');
  } finally {
    fbSend.disabled = false;
  }
});

// ── 서비스 별점 평가 (별 클릭 → 선택 한줄 → 전송) ─────
let rateScore = 0;
const starsEl = $('#stars');
if (starsEl) {
  starsEl.addEventListener('click', e => {
    const b = e.target.closest('.star');
    if (!b) return;
    rateScore = Number(b.dataset.v);
    $$('.star').forEach(s => s.classList.toggle('on', Number(s.dataset.v) <= rateScore));
    $('#rateForm').style.display = '';
  });
  $('#rateSend').addEventListener('click', async () => {
    if (!rateScore) return;
    const btn = $('#rateSend');
    btn.disabled = true;
    try {
      const payload = { kind: 'rating', score: rateScore, memo: $('#rateMemo').value.trim().slice(0, 300),
                        at: localAt(), t: FB_TOKEN };
      const r = await fetch(FEEDBACK_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
      if (!r.ok) throw new Error('전송 실패 ' + r.status);
      $('#stars').style.display = 'none';
      $('#rateForm').style.display = 'none';
      $('#rateDone').style.display = '';
      try { localStorage.setItem('gsRatingPopupDone', '1'); } catch (e) {}   // 하단 카드로 이미 평가함 → 별점 팝업 재노출 방지
    } catch (e) {
      const re = $('#rateErr');
      if (re) { re.textContent = '전송에 실패했어요. 잠시 후 다시 시도해주세요.'; re.classList.add('show'); }
      btn.disabled = false;
    }
  });
}

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
    list: sub => PLACES.filter(p => !p.x && !p.to && REAL.includes(p.t) && p.z === sub),
  },
  capick: {
    title: '📌 CA 강추', note: 'CA가 직접 가본 찐 추천만 모았어요.', subs: null,
    list: () => PLACES.filter(p => p.ca && !p.x && !p.to),
  },
  time: {
    title: '🎯 아침·심야', note: '',
    subs: [['early', '🌅 아침 되는 곳'], ['late', '🌙 심야 영업']],
    list: sub => PLACES.filter(p => !p.x && !p.to && REAL.includes(p.t) && (sub === 'late' ? opensLate(p) : opensEarly(p))),
  },
  makguksu: {
    title: '🍜 고성 막국수 모음', note: '고성·속초의 막국수집을 모았어요. (거리순)', subs: null,
    list: () => PLACES.filter(p => !p.x && !p.to && ((p.n || '').includes('막국수') || (p.m || []).some(m => m.includes('막국수')))),
  },
};
function renderCollection(key, sub) {
  const c = COLL[key];
  if (c.subs && !sub) sub = c.subs[0][0];
  const list = c.list(sub).slice().sort((a, b) => (a.d == null ? 9e9 : a.d) - (b.d == null ? 9e9 : b.d));
  const chips = c.subs ? '<div class="chips" style="margin:0 0 8px">' +
    c.subs.map(([v, l]) => `<span class="chip${v === sub ? ' on' : ''}" role="button" tabindex="0" data-coll="${key}" data-sub="${v}">${l}</span>`).join('') + '</div>' : '';
  const noteHtml = c.note ? `<div class="notice" style="margin:0 0 6px">${c.note}</div>` : '';
  $('#secBody').innerHTML = chips + noteHtml + (list.length ? list.map(p => cardHTML(p)).join('') : '<p class="empty">해당하는 곳이 없어요. 다른 탭이나 조건을 바꿔보세요.</p>');
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
  const note = '<div class="notice" style="margin:0 0 8px">🎉 고성·속초 대표 축제예요. 매년 시기가 조금씩 달라지니 정확한 일정은 링크에서 확인해보시길 추천해요.</div>';
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
  sendEvent('coll:' + key);
  const titleMap = { takeout: '🍱 포장·배달 (객실에서)', activity: '🏄 액티비티', beach: '🏖 해수욕장', attraction: '🗺 즐길 곳', festival: '🎉 고성·속초 축제', walk: '🚶 걸어서 갈 곳', capick: '📌 CA 강추', time: '🎯 아침·심야' };
  $('#secTitle').textContent = (COLL[key] && COLL[key].title) || titleMap[key] || '';
  if (COLL[key]) { renderCollection(key); $('#section').classList.add('show'); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  let html = '';
  const tourNote = '<div class="notice" style="margin-top:0;margin-bottom:6px">📍 한국관광공사 정보 기반이에요. 방문 전 운영 여부를 확인해보시길 추천해요.</div>';
  const byDist = arr => arr.slice().sort((a, b) => (a.d == null ? 9e9 : a.d) - (b.d == null ? 9e9 : b.d));
  if (key === 'takeout') {
    const list = PLACES.filter(p => p.to && !p.x);
    html = list.length ? list.map(p => cardHTML(p)).join('') : '<p class="empty">등록된 포장·배달 가게가 없어요. 곧 추가할게요.</p>';
  } else if (key === 'activity' && typeof TOUR !== 'undefined') {
    html = tourNote + TOUR.activities.map(tourCardHTML).join('');
  } else if (key === 'beach') {
    const list = byDist(PLACES.filter(p => p.t === '해변' && !p.x));
    html = list.length ? list.map(p => beachCardHTML(p)).join('') : '<p class="empty">해변 정보를 찾지 못했어요. 잠시 후 다시 확인해주세요.</p>';
  } else if (key === 'attraction') {
    renderAttractionSection('natural');
    $('#section').classList.add('show');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
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
  if (b.dataset.sec === 'pick') { location.href = 'course-pick.html'; return; }
  openSection(b.dataset.sec);
}));
$('#secClose').addEventListener('click', () => $('#section').classList.remove('show'));
// 모음 하위 옵션(거리/시간대) 토글
$('#secBody').addEventListener('click', e => {
  const c = e.target.closest('[data-coll]');
  if (c) renderCollection(c.dataset.coll, c.dataset.sub);
  const a = e.target.closest('[data-attrsub]');
  if (a) renderAttractionSection(a.dataset.attrsub);
});

// ── 백엔드 편집 오버레이 ─────────────────────────────
// places.js(주간 스냅샷)로 먼저 그린 뒤, 어드민 최신 편집(제외·강추·예약·메모·직접추가)을 얹는다.
// 백엔드 응답이 없으면 조용히 스냅샷 그대로 → 사이트는 항상 뜬다.
const ZONE_DIST = { '도보권': 0.8, '고성권(차 10~15분)': 10, '속초권(차 20~35분)': 25 };
function manualToCard(m) {
  return { n: m.name, t: m.type, c: m.category || m.type, f: m.food || [], v: m.vibe || [],
           z: (m.zone || '').slice(0, 2), d: m.dist_km != null ? m.dist_km : (ZONE_DIST[m.zone] || 10),
           a: m.address || '', u: m.naver || '', img: m.thumb || '', s: String(m.sid) };
}
function applyOverrideTo(pl, o) {
  pl.x = o.x ? 1 : 0;
  pl.ca = o.p ? 1 : 0;
  pl.nt = o.nt ? 1 : 0;
  pl.to = o.to ? 1 : 0;
  pl.r = (o.r || pl.ra) ? 1 : 0;   // 자동감지(ra) 예약은 유지, 수동 예약만 편집을 따름
  if (o.nat != null) pl.nat = o.nat ? 1 : 0;   // 자연명소 수동 지정(어드민) — 없으면 주간 빌드 기본값 유지
  pl.note = o.note || '';
}
async function applyLiveEdits() {
  try {
    const r = await fetch(ADMIN_API + '/public/data');
    if (!r.ok) return false;
    const live = await r.json();
    const bySid = {};
    PLACES.forEach(pl => { if (pl.s) bySid[pl.s] = pl; });
    // 1) 기존 가게: sid로 편집 반영
    PLACES.forEach(pl => { if (pl.s) applyOverrideTo(pl, live.ov[pl.s] || {}); });
    // 2) 직접추가: 스냅샷에 아직 없는 가게는 카드로 변환해 추가
    const liveManSids = new Set(live.manual.map(m => String(m.sid)));
    live.manual.forEach(m => {
      const sid = String(m.sid);
      if (bySid[sid]) return;
      const card = manualToCard(m);
      applyOverrideTo(card, live.ov[sid] || {});
      PLACES.push(card); bySid[sid] = card;
    });
    // 3) 어드민에서 삭제된 직접추가 가게는 숨김 (직접추가 sid는 'm'으로 시작)
    PLACES.forEach(pl => { if (pl.s && pl.s.charAt(0) === 'm' && !liveManSids.has(pl.s)) pl.x = 1; });
    return true;
  } catch (e) {
    return false;   // 오프라인/장애 — 스냅샷 그대로
  }
}

// ── 사이트 문구·테마 오버레이 (어드민 "문구·디자인" 탭 편집분) ──
// data-copy 요소는 textContent 로만 주입(저장형 XSS 차단). 응답 없으면 기본 문구 그대로.
function applyCopyToDom() {
  $$('[data-copy]').forEach(el => { const k = el.dataset.copy; if (COPY[k] != null) el.textContent = COPY[k]; });
  $$('[data-copy-ph]').forEach(el => { const k = el.dataset.copyPh; if (COPY[k] != null) el.placeholder = COPY[k]; });
}
function applyTheme(theme) {
  if (!theme || typeof theme !== 'object') return;
  const root = document.documentElement;
  if (/^#[0-9a-fA-F]{6}$/.test(theme.accent || '')) root.style.setProperty('--green', theme.accent);
  const zoom = { small: 0.92, normal: 1, large: 1.1 }[theme.scale];
  const w = $('.wrap');
  if (zoom && w) w.style.zoom = zoom;
}
async function applySettings() {
  try {
    const r = await fetch(SETTINGS_API);
    if (!r.ok) return false;
    const s = await r.json();
    if (s && s.copy) {
      for (const [k, v] of Object.entries(s.copy)) {
        if (typeof v === 'string' && v.trim() && k in COPY) COPY[k] = v;
      }
    }
    applyCopyToDom();
    applyTheme(s && s.theme);
    return true;
  } catch (e) {
    return false;   // 오프라인/장애 — 기본 문구 그대로
  }
}

// ── 접근성: div 기반 버튼(세그·칩·내비)을 키보드로 조작 가능하게 ──
$$('.navbtn').forEach(function (el) { el.setAttribute('role', 'button'); if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0'); });
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  const t = e.target.closest && e.target.closest('.seg, .chip, .navbtn');
  if (!t) return;
  e.preventDefault();
  t.click();
});

// ── 도입 화면 (세션당 1회 · 시간대 인사 · 탭 또는 2.2초 후 메인으로) ──
(function () {
  const intro = document.getElementById('intro');
  if (!intro) return;
  // 이번 세션에 이미 봤으면 즉시 제거 (재방문 시 바로 메인)
  let seen = false;
  try { seen = sessionStorage.getItem('gsIntroSeen') === '1'; } catch (e) {}
  if (seen) { intro.remove(); return; }
  try { sessionStorage.setItem('gsIntroSeen', '1'); } catch (e) {}

  // 인사문구 제거 — 중앙에 로고 + 날씨만
  const sEl = document.getElementById('introSub');
  if (sEl) sEl.textContent = '고성 날씨 불러오는 중…';

  // 지금 고성 날씨 — Open-Meteo(무료·API키 없음·CORS 허용). CSP connect-src에 api.open-meteo.com 허용.
  function wmo(code) {
    if (code === 0) return ['맑음', '☀️'];
    if (code === 1) return ['대체로 맑음', '🌤'];
    if (code === 2) return ['구름 조금', '⛅'];
    if (code === 3) return ['흐림', '☁️'];
    if (code === 45 || code === 48) return ['안개', '🌫'];
    if (code >= 51 && code <= 57) return ['이슬비', '🌦'];
    if (code >= 61 && code <= 67) return ['비', '🌧'];
    if (code >= 71 && code <= 77) return ['눈', '🌨'];
    if (code >= 80 && code <= 82) return ['소나기', '🌦'];
    if (code === 85 || code === 86) return ['소낙눈', '🌨'];
    if (code >= 95) return ['천둥번개', '⛈'];
    return ['', '🌡'];
  }
  fetch('https://api.open-meteo.com/v1/forecast?latitude=38.28&longitude=128.52&current=temperature_2m,weather_code,wind_speed_10m&wind_speed_unit=ms&timezone=Asia%2FSeoul')
    .then(function (r) { if (!r.ok) throw 0; return r.json(); })
    .then(function (j) {
      const c = j.current, t = Math.round(c.temperature_2m), w = wmo(c.weather_code);
      const wind = c.wind_speed_10m >= 9 ? ' · 바람 많이 불어요 💨' : '';
      if (sEl) sEl.textContent = '현재 ' + t + '° · ' + w[0] + ' ' + w[1] + wind;
    })
    .catch(function () { if (sEl) sEl.textContent = '오늘도 즐거운 고성 여행 되세요'; });

  document.body.classList.add('intro-lock');
  let done = false;
  function dismiss() {
    if (done) return; done = true;
    intro.classList.add('hide');
    document.body.classList.remove('intro-lock');
    setTimeout(function () { intro.remove(); }, 600);   // 페이드(0.55s) 후 DOM에서 제거
  }
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const timer = setTimeout(dismiss, reduce ? 2600 : 4200);   // 좀 더 여유있게(날씨 볼 시간)
  intro.addEventListener('click', function () { clearTimeout(timer); dismiss(); });   // 탭하면 즉시 스킵
})();

// ── 홈 하단 미니섹션 (해수욕장 · 즐길 곳) — 나비게이션 버튼 없이 바로 몇 개 노출 ──
function beachMiniHTML(p) {
  const region = (p.a || '').includes('속초시') ? '속초' : '고성';
  const hot = p.rv && p.rv[1] >= 100 ? ' <span class="hot">🔥 HOT</span>' : '';
  const rv = p.rv ? `<span class="rv">★${esc(p.rv[0])}</span>` : '';
  const driveMin = Math.round((p.d || 0) / 50 * 60) + 3;
  const img = p.img ? `<img class="ph" src="${esc(p.img)}" loading="lazy" alt="" referrerpolicy="no-referrer">` : '<div class="noph">🏖</div>';
  return `<div class="minicard" data-sid="${esc(p.s || '')}">
    <div class="minicard-imgwrap">${img}</div>
    <div class="minicard-body"><div class="nm">${esc(p.n)}${hot}</div>
    <div class="meta"><span class="region">${esc(region)}</span>${rv}<span>🚗${driveMin}분</span></div></div>
  </div>`;
}
function attrMiniHTML(p) {
  const img = p.img ? `<img class="ph" src="${esc(p.img)}" loading="lazy" alt="" referrerpolicy="no-referrer">` : '<div class="noph">🗺</div>';
  return `<div class="minicard" data-sid="${esc(p.s || '')}">
    <div class="minicard-imgwrap">${img}</div>
    <div class="minicard-body"><div class="nm">${esc(p.n)}</div>
    <div class="meta"><span>${moveTextSimple(p)}</span></div></div>
  </div>`;
}
let miniAttrSub = 'natural';
function renderBottomSections() {
  const byDist = arr => arr.slice().sort((a, b) => (a.d == null ? 9e9 : a.d) - (b.d == null ? 9e9 : b.d));
  const beach = byDist(PLACES.filter(p => p.t === '해변' && !p.x));
  const beachScroll = $('#beachMiniScroll');
  if (beachScroll) {
    beachScroll.innerHTML = beach.map(beachMiniHTML).join('') || '<p class="empty">해변 정보를 찾지 못했어요. 잠시 후 다시 확인해주세요.</p>';
    const moreBtn = $('#beachMiniMore');
    if (moreBtn) moreBtn.textContent = `전체 ${beach.length}곳 보기 →`;
  }
  renderAttrMini(miniAttrSub);
}
function renderAttrMini(sub) {
  miniAttrSub = sub;
  const byDist = arr => arr.slice().sort((a, b) => (a.d == null ? 9e9 : a.d) - (b.d == null ? 9e9 : b.d));
  const list = byDist(PLACES.filter(p => p.t === '명소' && !p.x && (sub === 'natural' ? p.nat === 1 : p.nat !== 1)));
  const attrScroll = $('#attrMiniScroll');
  if (attrScroll) attrScroll.innerHTML = list.map(attrMiniHTML).join('') || '<p class="empty">해당하는 곳이 없어요. 다른 탭을 눌러보세요.</p>';
  const moreBtn = $('#attrMiniMore');
  if (moreBtn) moreBtn.textContent = `전체 ${list.length}곳 보기 →`;
  $$('.attrminitab').forEach(t => t.classList.toggle('on', t.dataset.attrsub === sub));
}
const beachMore = $('#beachMiniMore');
if (beachMore) beachMore.addEventListener('click', () => openSection('beach'));
const attrMore = $('#attrMiniMore');
if (attrMore) attrMore.addEventListener('click', () => openSection('attraction'));
$$('.attrminitab').forEach(t => t.addEventListener('click', () => renderAttrMini(t.dataset.attrsub)));
// 좌우 화살표 — PC(마우스) 사용자용, 카드 폭만큼씩 부드럽게 스크롤
$$('.miniarrow').forEach(btn => btn.addEventListener('click', () => {
  const track = document.getElementById(btn.dataset.target);
  if (!track) return;
  const dir = btn.classList.contains('left') ? -1 : 1;
  track.scrollBy({ left: dir * Math.round(track.clientWidth * 0.8), behavior: 'smooth' });
}));

// 시작: 스냅샷으로 즉시 그리고, 최신 편집이 도착하면 한 번 갱신
renderContext();
renderChips();
renderNow();
renderBottomSections();
applySettings().then(ok => { if (ok) renderNow(); });   // 문구 반영 후 슬롯 라벨·설명 갱신
applyLiveEdits().then(ok => { if (ok) { recent = []; renderChips(); renderNow(); renderBottomSections(); } });
// (2026-06-30) 60초 주기 갱신은 제거(보는 중에 추천이 저절로 바뀌어 거슬림).
// 대신 탭/앱으로 '다시 돌아왔을 때'에만 최신화 → 보고 있는 동안엔 안 바뀌고, 닫힌 가게가 영업중으로 남는 문제는 해결.
// (원래 60초 로직과 동일: context는 항상, auto 슬롯일 때만 chips·now 재계산 + 편집 최신화)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  renderContext();
  applyLiveEdits().finally(() => {
    if (curSlot === 'auto') { renderChips(); renderNow(); }
    renderBottomSections();
  });
});

// PC 배경 사진 순환 (index.html 인라인에서 이동 — CSP 강화를 위해 외부 파일로)
(function () {
  var slides = document.querySelectorAll('.bg-slide');
  if (!slides.length) return;
  var n = slides.length;
  var prev = parseInt(localStorage.getItem('gsBgIndex'), 10);
  var i = isNaN(prev) ? 0 : (prev + 1) % n;
  slides[i].classList.add('is-active');
  try { localStorage.setItem('gsBgIndex', String(i)); } catch (e) {}
})();

// ── 조회수 집계 (손님만, 브라우저당 하루 1회) ─────────
(function () {
  try {
    if (localStorage.getItem('gstAdminSession')) return;   // 어드민 본인 방문은 카운트 안 함
    const d = new Date();
    const key = 'gsHit:' + d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    if (localStorage.getItem(key)) return;                 // 오늘 이미 셌으면 skip(새로고침 부풀리기 방지)
    localStorage.setItem(key, '1');
    fetch(ADMIN_API + '/view', { method: 'POST', keepalive: true }).catch(function (e) { console.debug('view beacon 실패(무시 가능):', e && e.message); });
  } catch (e) { console.debug('view beacon skip:', e && e.message); }   // localStorage 접근 불가(사생활모드 등)면 조용히 넘어가되 로그는 남김
})();

// ── 가게 클릭 집계 (카드의 '네이버 지도에서 보기' 클릭, 손님만) ──
document.addEventListener('click', function (e) {
  const a = e.target.closest('a[data-clk]');
  if (!a) return;
  try { if (localStorage.getItem('gstAdminSession')) return; } catch (e2) {}   // 어드민 본인 클릭은 제외
  const sid = a.getAttribute('data-sid') || '';
  const name = a.getAttribute('data-name') || '';
  if (!sid && !name) return;
  // text/plain 기본 → 프리플라이트 없는 단순요청. keepalive 로 새 탭 열려도 전송 보장.
  fetch(ADMIN_API + '/click', { method: 'POST', keepalive: true, body: JSON.stringify({ sid: sid, name: name }) })
    .catch(function (err) { console.debug('click beacon 실패(무시 가능):', err && err.message); });
}, true);

// ── 디자인 코멘트 모드 (어드민 전용) ─────────────────
// 어드민 로그인(같은 도메인이라 토큰 공유) 상태면, 메인 페이지에서 요소를 클릭해 메모를 남길 수 있음.
// 남긴 코멘트는 백엔드에 쌓였다가 나중에 일괄 반영. 손님(비로그인)에겐 UI 자체가 안 생김.
(function () {
  const TOKEN = (function () { try { return localStorage.getItem('gstAdminSession'); } catch (e) { return null; } })();
  if (!TOKEN) return;

  let mode = false;
  let list = [];

  async function apiA(path, opts) {
    const r = await fetch(ADMIN_API + path, Object.assign({}, opts, {
      headers: Object.assign({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN }, (opts && opts.headers) || {}),
    }));
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).error) || ('오류 ' + r.status));
    return r.json().catch(() => ({}));
  }

  // 클릭한 요소 설명: 문구는 data-copy key로 정확히, 그 외는 태그+텍스트로
  function describe(el) {
    const c = el.closest('[data-copy]') || el.closest('[data-copy-ph]');
    if (c) return { target: 'copy:' + (c.dataset.copy || c.dataset.copyPh), label: (c.textContent || '').trim().slice(0, 120) };
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const cls = (typeof el.className === 'string' && el.className.trim()) ? '.' + el.className.trim().split(/\s+/).join('.') : '';
    return { target: el.tagName.toLowerCase() + cls, label: txt };
  }

  // 어드민으로 돌아가기 (어드민에게만 보임, 좌하단)
  const adminBtn = document.createElement('a');
  adminBtn.id = 'cmAdmin';
  adminBtn.href = 'admin.html';
  adminBtn.textContent = '⚙️ 어드민';
  document.body.appendChild(adminBtn);

  const dock = document.createElement('button');
  dock.id = 'cmDock';
  dock.type = 'button';
  document.body.appendChild(dock);

  const panel = document.createElement('div');
  panel.id = 'cmPanel';
  panel.style.display = 'none';
  document.body.appendChild(panel);

  function renderDock() { dock.textContent = mode ? '✏️ 코멘트 켜짐' : '✏️ 코멘트'; dock.classList.toggle('on', mode); }

  let loadErr = '';
  function renderPanel() {
    // 전송(반영 요청) 대상은 '작성(open)'만. 'ready'는 반영 대기, 'review'는 자동반영이 코드변경으로 분류한 것.
    const openN = list.filter(a => a.status === 'open').length;
    const STLABEL = { ready: '<span class="cmSt ready">반영 대기</span>', review: '<span class="cmSt review">검토 필요</span>' };
    const items = list.length ? list.map(a =>
      '<div class="cmItem"><div class="cmNote">' + esc(a.note) + '</div>' +
      '<div class="cmMeta">📍 ' + esc(a.label || a.target) + '</div>' +
      '<div class="cmRow">' + (STLABEL[a.status] || '<span class="cmSt">작성</span>') +
      '<button class="cmDel" type="button" data-id="' + a.id + '">삭제</button></div></div>'
    ).join('') : (loadErr
      ? '<div class="cmEmpty">' + esc(loadErr) + '</div>'
      : '<div class="cmEmpty">코멘트가 없어요. 아래 "요소 클릭 모드"를 켜고 화면을 눌러보세요.</div>');
    panel.innerHTML =
      '<div class="cmHead"><b>디자인 코멘트 ' + list.length + '</b>' +
      '<button id="cmMode" type="button">' + (mode ? '요소 클릭 모드 · 켜짐' : '요소 클릭 모드 켜기') + '</button>' +
      '<button id="cmClose" type="button">✕</button></div>' +
      '<div class="cmList">' + items + '</div>' +
      '<div class="cmFoot"><button id="cmSend" type="button"' + (openN ? '' : ' disabled') + '>📮 반영 요청 (' + openN + '건)</button>' +
      '<span class="cmHint">누르면 다음 자동 반영(하루 1회) 때 처리돼요</span></div>';
  }

  // 실패해도 기존 목록을 지우지 않고 사유를 표시 (빈 목록=코멘트 없음 으로 오해 방지)
  async function load() {
    try { list = (await apiA('/admin/annotations')).annotations || []; loadErr = ''; }
    catch (e) { loadErr = '코멘트 불러오기 실패: ' + e.message + ' — 저장된 코멘트가 사라진 게 아니라 조회만 실패했어요.'; }
    renderPanel(); renderDock();
  }

  function ask(el) {
    const d = describe(el);
    const note = window.prompt('이 부분에 남길 메모:\n[ ' + (d.label || d.target) + ' ]', '');
    if (note == null) return;
    const n = note.trim();
    if (!n) return;
    apiA('/admin/annotations', { method: 'POST', body: JSON.stringify(Object.assign(d, { note: n, page: 'index' })) })
      .then(load).catch(e => alert('저장 실패: ' + e.message));
  }

  // 코멘트 모드일 때: 어떤 클릭이든 가로채서(내비게이션 방지) 메모 입력
  document.addEventListener('click', function (e) {
    if (!mode) return;
    if (e.target.closest('#cmPanel') || e.target.closest('#cmDock') || e.target.closest('#cmAdmin')) return;
    e.preventDefault(); e.stopPropagation();
    ask(e.target);
  }, true);

  dock.addEventListener('click', function () {
    const open = panel.style.display === 'none';
    panel.style.display = open ? '' : 'none';
    if (open) load();
  });

  panel.addEventListener('click', function (e) {
    if (e.target.id === 'cmMode') { mode = !mode; document.body.classList.toggle('cm-on', mode); renderPanel(); renderDock(); return; }
    if (e.target.id === 'cmClose') { panel.style.display = 'none'; return; }
    if (e.target.id === 'cmSend') {
      e.target.disabled = true;
      apiA('/admin/annotations/send', { method: 'POST' })
        .then(r => { alert((r.count || 0) + '건 반영 요청됨.\n다음 자동 반영(하루 1회) 때 처리돼요.'); return load(); })
        .catch(err => { alert('전송 실패: ' + err.message); renderPanel(); });
      return;
    }
    const del = e.target.closest('.cmDel');
    if (del) { apiA('/admin/annotations?id=' + del.dataset.id, { method: 'DELETE' }).then(load).catch(function (e) { alert('삭제 실패: ' + e.message); }); }
  });

  load();   // 시작 시 개수 파악(백그라운드)
})();
