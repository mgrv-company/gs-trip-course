// 맹그로브 고성 로컬 트립 코스 생성기
// 데이터: places.js (네이버 저장 리스트 → 속초·고성 한정 181곳)

// 구경거리(공개 명소) — 식사 외 슬롯용 고정 데이터
const LANDMARKS = [
  { n: '교암 해변 산책', z: '도보', mv: '맹그로브에서 도보 1분', u: 'https://map.naver.com/p/search/교암해변', tags: ['rest','tour','work','mood','local'] },
  { n: '천학정 일출 절벽', z: '도보', mv: '도보 10분 · 일출 명소', u: 'https://map.naver.com/p/search/천학정', tags: ['rest','tour','mood'] },
  { n: '아야진 해변', z: '고성', mv: '차 5분 · 한적한 바다', u: 'https://map.naver.com/p/search/아야진해변', tags: ['rest','tour','mood'] },
  { n: '청간정 & 청간해변', z: '고성', mv: '차 7분 · 관동팔경', u: 'https://map.naver.com/p/search/청간정', tags: ['tour','local'] },
  { n: '송지호 & 왕곡한옥마을', z: '고성', mv: '차 15분 · 호수와 한옥', u: 'https://map.naver.com/p/search/왕곡마을', tags: ['tour','local','rest'] },
  { n: '영랑호 둘레길', z: '속초', mv: '차 20분 · 호수 산책', u: 'https://map.naver.com/p/search/영랑호', tags: ['rest','tour','work'] },
  { n: '속초관광수산시장', z: '속초', mv: '차 25분 · 닭강정 골목', u: 'https://map.naver.com/p/search/속초관광수산시장', tags: ['tour','food','local'] },
  { n: '아바이마을 & 갯배', z: '속초', mv: '차 25분 · 갯배 체험', u: 'https://map.naver.com/p/search/아바이마을', tags: ['tour','local'] },
  { n: '외옹치 바다향기로', z: '속초', mv: '차 30분 · 해안 데크길', u: 'https://map.naver.com/p/search/바다향기로', tags: ['rest','tour','mood'] },
  { n: '설악산 케이블카', z: '속초', mv: '차 30분 · 권금성 전망', u: 'https://map.naver.com/p/search/설악산케이블카', tags: ['tour'] },
];

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

// ── 설문 상태 ──────────────────────────────────────
const answers = { checkin: null, days: null, car: null, purpose: null, style: null, taste: [] };

// 입실일: 기본값 오늘
const dateInput = document.getElementById('checkinDate');
(() => {
  const t = new Date();
  dateInput.value = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  answers.checkin = dateInput.value;
})();
dateInput.addEventListener('change', () => { answers.checkin = dateInput.value; });

// ── 영업시간 ──────────────────────────────────────
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

function weekdayOf(dayIdx) { // DAY n의 요일 이름
  const d = new Date(answers.checkin + 'T00:00:00');
  d.setDate(d.getDate() + dayIdx);
  return DAY_NAMES[d.getDay()];
}

function toMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// 영업시간 정보가 없을 때: 카테고리상 저녁 장사 가게는 낮 슬롯에 안 넣음
const EVENING_ONLY = /포장마차|BAR|이자카야|요리주점|맥주|호프|술집|와인|펍|야식/i;

// slotTime("12:00")에 영업 중인가? true/false/null(정보 없음)
function isOpenAt(p, dayIdx, slotTime) {
  if (!p.h) {
    if (EVENING_ONLY.test(p.c) && toMin(slotTime) < 17 * 60) return false;
    return null;
  }
  const day = weekdayOf(dayIdx);
  if (!(day in p.h)) return null;
  const range = p.h[day];
  if (range === null) return false; // 정기휴무
  const [s, e] = range.split('-');
  const t = toMin(slotTime);
  let start = toMin(s), end = toMin(e);
  if (end <= start) end += 24 * 60; // 새벽까지 영업 (예: 17:00-02:00)
  // 마감 30분 전까지는 입장 가능으로 간주
  return t >= start && t <= end - 30;
}

function noteText(p) {
  const t = p.note || p.mr; // 수동 메모 우선, 없으면 네이버 한줄소개
  return t ? `💬 ${t}` : '';
}

// 웨이팅·방문 팁 (리뷰 데이터 기반 자동 생성)
function waitText(p) {
  if (p.w === 2) return `⏳ 웨이팅 잦은 집 — 평일이나 오픈 직후 추천${p.lu ? ' · 📲 네이버 줄서기 가능' : ''}`;
  if (p.w === 1) return '⏳ 주말 식사시간엔 대기 있을 수 있어요';
  if (p.w === 0) return '🚶 보통 워크인으로 갈 수 있어요';
  return '';
}

// 카드 정보 블록 (메뉴 + 영업시간 + 팁 + 메모) — 최초 렌더와 다시 뽑기에서 공용
function infoHTML(p, dayIdx) {
  const lines = [];
  if (p.m && p.m.length) lines.push(`🍽 ${p.m.join(' · ')}`);
  lines.push('🕐 ' + hoursText(p, dayIdx));
  if (waitText(p)) lines.push(waitText(p));
  if (noteText(p)) lines.push(noteText(p));
  return lines.join('<br>');
}

function hoursText(p, dayIdx) {
  if (!p.h) return '영업시간 정보 없음 · 방문 전 확인';
  const day = weekdayOf(dayIdx);
  const range = p.h[day];
  const closedDays = Object.keys(p.h).filter(d => p.h[d] === null);
  const closedTxt = closedDays.length ? ` · ${closedDays.join(',')} 휴무` : '';
  if (!(day in p.h)) return '영업시간 확인 필요' + closedTxt;
  if (range === null) return `${day}요일 휴무 ⚠️`;
  return `${day} ${range.replace('-', '~')}${closedTxt}`;
}

$$('.step').forEach(step => {
  const key = step.dataset.key;
  const multi = !!step.dataset.multi;
  $$('.opt', step).forEach(opt => {
    opt.addEventListener('click', () => {
      if (multi) {
        // "다 잘 먹어요"는 다른 선택과 배타
        if (opt.dataset.v === 'all') {
          $$('.opt', step).forEach(o => o.classList.remove('on'));
          opt.classList.add('on');
        } else {
          $('[data-v="all"]', step).classList.remove('on');
          opt.classList.toggle('on');
        }
        answers.taste = $$('.opt.on', step).map(o => o.dataset.v);
      } else {
        $$('.opt', step).forEach(o => o.classList.remove('on'));
        opt.classList.add('on');
        answers[key] = opt.dataset.v;
      }
      $('#goBtn').disabled = !(answers.days && answers.car && answers.purpose && answers.style && answers.taste.length);
    });
  });
});

// ── 코스 생성 ──────────────────────────────────────
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function moveText(p, car) {
  if (p.d <= 1.2) return '도보 ' + Math.max(3, Math.round(p.d * 15)) + '분';
  const min = Math.round(p.d / 50 * 60) + 3;
  return (car === 'no' ? '택시 약 ' : '차 ') + min + '분';
}

// 장소 점수: 식성·분위기·거리(이동수단)·목적 가중치
function score(p, ans, dayZone) {
  let s = Math.random() * 2; // 같은 조건에서도 코스가 조금씩 달라지게
  if (ans.taste[0] !== 'all' && p.t === '식사') {
    const hit = p.f.some(f => ans.taste.includes(f));
    s += hit ? 6 : -8;
  }
  if (ans.style === 'mood' && p.v.includes('감성')) s += 3;
  if (ans.style === 'local' && p.v.includes('로컬·노포')) s += 3;
  if (p.z === dayZone) s += 4;
  if (ans.car === 'no') {
    if (p.z === '도보') s += 5;
    else if (p.z === '고성') s += 1;
    else s -= 3; // 속초는 택시비 부담
  }
  if (ans.purpose === 'rest' && p.z !== '속초') s += 2;
  if (ans.purpose === 'food') s += p.v.includes('로컬·노포') ? 1 : 0;
  if (p.ca) s += 2.5; // CA 강력 추천은 어떤 조건에서든 우선
  // 방문자 리뷰 기반 가산: 평점(4점대 후반 우대) + 리뷰 수(검증된 곳 우대)
  if (p.rv) {
    const [rating, count] = p.rv;
    s += Math.max(-1, Math.min(1.6, (rating - 4.2) * 2));
    s += Math.min(1.5, Math.log10(count + 1) * 0.6);
  }
  return s;
}

function pick(pool, ans, dayZone, used, usedCat, dayIdx, slotTime) {
  let candidates = pool.filter(p => !used.has(p.n));
  if (slotTime !== undefined) {
    // 휴무·영업시간 밖 가게 제외 (정보 없는 곳은 통과시키되 카드에 확인 문구)
    candidates = candidates.filter(p => isOpenAt(p, dayIdx, slotTime) !== false);
    // 예약제 가게는 도착 당일 낮(체크인 전)에는 제안하지 않음 — 저녁부터는 ☎ 배지와 함께 허용
    if (dayIdx === 0 && toMin(slotTime) < 15 * 60) candidates = candidates.filter(p => !p.r);
  }
  // 피크타임(점심·저녁 식사시간)엔 웨이팅 잦은 집을 약하게 감점
  const peak = slotTime === '12:00' || slotTime === '18:30';
  const ranked = candidates
    .map(p => ({ p, s: score(p, ans, dayZone) - (usedCat.has(p.c) ? 2 : 0) + (slotTime !== undefined && isOpenAt(p, dayIdx, slotTime) === true ? 2 : 0) - (peak && p.w === 2 ? 1.2 : 0) - (recentPicks.has(p.n) ? 3 : 0) }))
    .sort((a, b) => b.s - a.s);
  if (!ranked.length) return null;
  // 상위 7곳 가중치 추첨: 점수 높을수록 잘 뽑히되, 다시 뽑을 때마다 변화가 생기게
  const top = ranked.slice(0, 7);
  const weights = top.map((_, i) => top.length - i);
  let roll = Math.random() * weights.reduce((a, b) => a + b, 0);
  let chosen = top[0].p;
  for (let i = 0; i < top.length; i++) {
    roll -= weights[i];
    if (roll <= 0) { chosen = top[i].p; break; }
  }
  used.add(chosen.n);
  usedCat.add(chosen.c);
  return chosen;
}

function pickLandmark(ans, dayZone, used) {
  const pool = LANDMARKS.filter(l =>
    !used.has(l.n) &&
    (l.tags.includes(ans.purpose) || l.tags.includes(ans.style)) &&
    (ans.car === 'no' ? l.z !== '속초' : true)
  );
  const sorted = pool.sort((a, b) => (b.z === dayZone ? 1 : 0) - (a.z === dayZone ? 1 : 0));
  const chosen = sorted[0] || LANDMARKS.find(l => !used.has(l.n));
  if (chosen) used.add(chosen.n);
  return chosen;
}

function buildCourse(ans) {
  const days = Math.min(parseInt(ans.days), 4);
  const meals = PLACES.filter(p => p.t === '식사');
  const cafes = PLACES.filter(p => p.t === '카페');
  const bars = PLACES.filter(p => p.t === '술집');
  const used = new Set();
  const course = [];

  // 일자별 동선: 뚜벅이는 근거리 위주, 자차는 고성→속초 번갈아
  const zonePlan = [];
  for (let i = 0; i < days; i++) {
    if (ans.car === 'no') zonePlan.push(i === 0 ? '고성' : (ans.purpose === 'tour' ? '속초' : '고성'));
    else zonePlan.push(i % 2 === 0 ? '고성' : '속초');
  }
  if (ans.purpose === 'tour' && ans.car === 'yes') zonePlan[0] = '속초';

  for (let d = 0; d < days; d++) {
    const usedCat = new Set();
    const zone = zonePlan[d];
    const slots = [];
    const isLast = d === days - 1;
    const isFirst = d === 0;

    // 오전: 첫날은 체크인 전후라 생략, 워케이션은 업무 시간
    if (!isFirst) {
      if (ans.purpose === 'work') {
        slots.push({ time: '오전', fixed: { n: '워크라운지에서 오전 업무', mv: '맹그로브 고성 1층', u: null }, land: true });
      } else {
        const l = pickLandmark(ans, zone, used);
        if (l) slots.push({ time: '오전', fixed: l, land: true });
      }
    }

    slots.push({ time: '점심', pick: pick(meals, ans, zone, used, usedCat, d, '12:00'), pool: 'meals', zone, dayIdx: d, st: '12:00' });

    // 오후: 카페 (+관광 목적이면 구경거리 하나 더)
    if (ans.purpose === 'tour' || ans.purpose === 'rest') {
      const l = pickLandmark(ans, zone, used);
      if (l) slots.push({ time: '오후', fixed: l, land: true });
    }
    slots.push({ time: '카페', pick: pick(cafes, ans, zone, used, usedCat, d, '15:00'), pool: 'cafes', zone, dayIdx: d, st: '15:00' });

    // 저녁: 마지막 날(체크아웃)은 당일치기 아니면 생략
    if (!isLast || days === 1) {
      slots.push({ time: '저녁', pick: pick(meals, ans, zone, used, usedCat, d, '18:30'), pool: 'meals', zone, dayIdx: d, st: '18:30' });
      const bar = pick(bars, ans, zone, used, usedCat, d, '21:00');
      if (bar) slots.push({ time: '밤 🍻', pick: bar, pool: 'bars', zone, optional: true, dayIdx: d, st: '21:00' });
    }
    course.push({ day: d + 1, zone, slots });
  }
  return course;
}

// ── 렌더링 ──────────────────────────────────────
const POOLS = { meals: () => PLACES.filter(p => p.t === '식사'), cafes: () => PLACES.filter(p => p.t === '카페'), bars: () => PLACES.filter(p => p.t === '술집') };
let usedGlobal = new Set();

function cardHTML(slot, idx) {
  if (slot.fixed) {
    const link = slot.fixed.u ? `<div class="links"><a href="${slot.fixed.u}" target="_blank"><span>네이버지도</span></a></div>` : '';
    const mv = (slot.fixed.mv || '').replace(/^차 /, answers.car === 'no' ? '택시 ' : '차 ');
    return `<div class="slot land"><div class="time">${slot.time}</div>
      <div class="card"><div class="nm">${slot.fixed.n}</div><div class="mv">${mv}</div>${link}</div></div>`;
  }
  const p = slot.pick;
  if (!p) return '';
  const img = p.img ? `<img class="ph" src="${p.img}" alt="" loading="lazy" onerror="this.remove()">` : '';
  return `<div class="slot"><div class="time">${slot.time}</div>
    <div class="card ${p.img ? 'pic' : ''}" data-idx="${idx}">
      <div class="nm">${p.n}${p.ca ? ' <span class="capick">💚 CA 강추</span>' : ''}${p.r ? ' <span class="rsv">☎ 예약 필수</span>' : ''}</div>
      <div class="ct">${p.c} · ${p.a.replace('강원특별자치도 ', '').replace('강원 ', '')}${p.rv ? ` · ⭐${p.rv[0]} (${p.rv[1]})` : ''}</div>
      <div class="hr">${infoHTML(p, slot.dayIdx)}</div>
      <div class="mv">${moveText(p, answers.car)}${slot.optional ? ' · 선택 코스' : ''}</div>
      <div class="links">
        <a href="${p.u}" target="_blank"><span>네이버지도 ↗</span></a>
        <span class="reroll" data-pool="${slot.pool}" data-zone="${slot.zone}" data-day="${slot.dayIdx}" data-st="${slot.st}">다른 곳 ↻</span>
        <span class="flagbtn" title="피드백">🚩</span>
      </div>${img}
    </div></div>`;
}

function render(course) {
  usedGlobal = new Set();
  course.forEach(day => day.slots.forEach(s => { if (s.pick) usedGlobal.add(s.pick.n); }));
  const zoneName = { '고성': '고성 토성면 일대', '속초': '속초 시내', '도보': '숙소 근처' };
  let html = '';
  course.forEach(day => {
    html += `<div class="day"><h3>DAY ${day.day} <span class="tag">${zoneName[day.zone] || day.zone}</span></h3>`;
    day.slots.forEach(slot => { html += cardHTML(slot); });
    html += `</div>`;
  });
  html += `<div class="note">마음에 안 드는 곳은 <b>다른 곳 ↻</b>을 눌러 바꿔보세요</div>`;
  html += `<button class="again" onclick="regenerate()">🔄 코스 전체 다시 뽑기</button>`;
  html += `<button class="again" style="margin-top:10px" onclick="backToQuiz()">← 조건 다시 고르기</button>`;
  $('#result').innerHTML = html;
  $('#result').style.display = 'block';

  // 슬롯별 다시 뽑기
  $$('.reroll').forEach(btn => {
    btn.addEventListener('click', () => {
      const pool = POOLS[btn.dataset.pool]();
      const zone = btn.dataset.zone;
      const dayIdx = parseInt(btn.dataset.day);
      const st = btn.dataset.st;
      const card = btn.closest('.card');
      const cur = $('.nm', card).textContent;
      const alt = pick(pool, answers, zone, usedGlobal, new Set(), dayIdx, st);
      if (!alt) { btn.textContent = '대안 없음'; return; }
      usedGlobal.delete(cur);
      $('.nm', card).innerHTML = alt.n + (alt.ca ? ' <span class="capick">💚 CA 강추</span>' : '') + (alt.r ? ' <span class="rsv">☎ 예약 필수</span>' : '');
      $('.ct', card).textContent = alt.c + ' · ' + alt.a.replace('강원특별자치도 ', '').replace('강원 ', '') + (alt.rv ? ` · ⭐${alt.rv[0]} (${alt.rv[1]})` : '');
      $('.hr', card).innerHTML = infoHTML(alt, dayIdx);
      $('.mv', card).textContent = moveText(alt, answers.car);
      $('a', card).href = alt.u;
      const ph = $('.ph', card);
      if (ph) { if (alt.img) ph.src = alt.img; else ph.remove(); }
    });
  });
}

// 직전 코스에 나왔던 가게들 — 다시 뽑기에서 감점해서 새 가게가 나오게
let recentPicks = new Set();

let lastCourse = null;
function regenerate() {
  lastCourse = buildCourse(answers);
  window.lastCourse = lastCourse; // 테스트 검증용
  recentPicks = new Set();
  lastCourse.forEach(day => day.slots.forEach(s => { if (s.pick) recentPicks.add(s.pick.n); }));
  render(lastCourse);
  window.scrollTo({ top: $('#result').offsetTop - 20, behavior: 'smooth' });
}
function backToQuiz() {
  $('#result').style.display = 'none';
  $('#quiz').style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$('#goBtn').addEventListener('click', () => {
  $('#quiz').style.display = 'none';
  regenerate();
});

// ── 현장 피드백 (CA용 🚩) ──────────────────────────
// 카드에서 🚩 → 유형 선택 → 폰에 쌓임 → "보내기"로 GitHub에 일괄 등록
const FB_KEY = 'gsTripFeedback';
const FB_REPO = 'https://github.com/mgrv-company/gs-trip-course/issues/new';
let fbPlace = null;

function fbList() {
  try { return JSON.parse(localStorage.getItem(FB_KEY)) || []; } catch (e) { return []; }
}
function fbSave(list) {
  localStorage.setItem(FB_KEY, JSON.stringify(list));
  updateFbSend();
}
function updateFbSend() {
  const n = fbList().length;
  const btn = $('#fbSend');
  btn.style.display = n ? 'block' : 'none';
  btn.textContent = `🚩 피드백 ${n}건 보내기`;
}

document.addEventListener('click', e => {
  const flag = e.target.closest('.flagbtn');
  if (!flag) return;
  const card = flag.closest('.card');
  fbPlace = $('.nm', card).childNodes[0].textContent.trim();
  $('#fbTitle').textContent = `🚩 ${fbPlace}`;
  $$('#fbSheet .fbopt').forEach(o => o.classList.remove('on'));
  $('#fbMemo').value = '';
  $('#fbDim').style.display = 'block';
  $('#fbSheet').style.display = 'block';
});

$$('#fbSheet .fbopt').forEach(o => o.addEventListener('click', () => {
  $$('#fbSheet .fbopt').forEach(x => x.classList.remove('on'));
  o.classList.add('on');
}));

function closeFbSheet() {
  $('#fbDim').style.display = 'none';
  $('#fbSheet').style.display = 'none';
}
$('#fbDim').addEventListener('click', closeFbSheet);
$('#fbSheet .fbclose').addEventListener('click', closeFbSheet);

$('#fbSheet .fbsave').addEventListener('click', () => {
  const sel = $('#fbSheet .fbopt.on');
  if (!sel) { alert('유형을 골라주세요'); return; }
  const list = fbList();
  list.push({ place: fbPlace, type: sel.dataset.t, memo: $('#fbMemo').value.trim(), at: new Date().toISOString().slice(0, 10) });
  fbSave(list);
  closeFbSheet();
});

$('#fbSend').addEventListener('click', () => {
  const list = fbList();
  if (!list.length) return;
  const title = `현장 피드백 ${list.length}건 (${list[0].at})`;
  const body = list.map(f => `- [${f.type}] ${f.place}${f.memo ? ' — ' + f.memo : ''}`).join('\n');
  window.open(`${FB_REPO}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`, '_blank');
  if (confirm('GitHub 등록 화면을 열었어요.\n등록을 마쳤으면 [확인]을 눌러 보낸 목록을 비워주세요.')) {
    fbSave([]);
  }
});

updateFbSend();
