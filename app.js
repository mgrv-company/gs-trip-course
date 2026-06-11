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
const answers = { days: null, car: null, purpose: null, style: null, taste: [] };

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
  return s;
}

function pick(pool, ans, dayZone, used, usedCat) {
  const ranked = pool
    .filter(p => !used.has(p.n))
    .map(p => ({ p, s: score(p, ans, dayZone) - (usedCat.has(p.c) ? 2 : 0) }))
    .sort((a, b) => b.s - a.s);
  if (!ranked.length) return null;
  const top = ranked.slice(0, 3); // 상위 3곳 중 랜덤 → 다양성
  const chosen = top[Math.floor(Math.random() * top.length)].p;
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

    slots.push({ time: isFirst ? '점심' : '점심', pick: pick(meals, ans, zone, used, usedCat), pool: 'meals', zone });

    // 오후: 카페 (+관광 목적이면 구경거리 하나 더)
    if (ans.purpose === 'tour' || ans.purpose === 'rest') {
      const l = pickLandmark(ans, zone, used);
      if (l) slots.push({ time: '오후', fixed: l, land: true });
    }
    slots.push({ time: '카페', pick: pick(cafes, ans, zone, used, usedCat), pool: 'cafes', zone });

    // 저녁: 마지막 날(체크아웃)은 당일치기 아니면 생략
    if (!isLast || days === 1) {
      slots.push({ time: '저녁', pick: pick(meals, ans, zone, used, usedCat), pool: 'meals', zone });
      const bar = pick(bars, ans, zone, used, usedCat);
      if (bar) slots.push({ time: '밤 🍻', pick: bar, pool: 'bars', zone, optional: true });
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
      <div class="nm">${p.n}</div>
      <div class="ct">${p.c} · ${p.a.replace('강원특별자치도 ', '').replace('강원 ', '')}</div>
      <div class="mv">${moveText(p, answers.car)}${slot.optional ? ' · 선택 코스' : ''}</div>
      <div class="links">
        <a href="${p.u}" target="_blank"><span>네이버지도 ↗</span></a>
        <span class="reroll" data-pool="${slot.pool}" data-zone="${slot.zone}">다른 곳 ↻</span>
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
      const card = btn.closest('.card');
      const cur = $('.nm', card).textContent;
      const alt = pick(pool, answers, zone, usedGlobal, new Set());
      if (!alt) { btn.textContent = '대안 없음'; return; }
      usedGlobal.delete(cur);
      $('.nm', card).textContent = alt.n;
      $('.ct', card).textContent = alt.c + ' · ' + alt.a.replace('강원특별자치도 ', '').replace('강원 ', '');
      $('.mv', card).textContent = moveText(alt, answers.car);
      $('a', card).href = alt.u;
      const ph = $('.ph', card);
      if (ph) { if (alt.img) ph.src = alt.img; else ph.remove(); }
    });
  });
}

let lastCourse = null;
function regenerate() {
  lastCourse = buildCourse(answers);
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
