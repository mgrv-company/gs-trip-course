// 추천 가게 모음 — 워커 /public/picks(숨기지 않은 카드, 카드 날짜 최신순)를 받아
// 위에는 NEW(오늘 포함 최근 7일)를 옆으로 넘겨 보고, 아래는 '지난 추천'을 업종으로 골라 본다. (2026-10-07)
(function () {
  'use strict';
  const API = new URLSearchParams(location.search).get('worker') || 'https://gs-trip-admin.mangrove-goseong.workers.dev';
  const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LINK = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/></svg>';
  const ARROW_L = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square"><path d="M10 2 4 8l6 6"/></svg>';
  const ARROW_R = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square"><path d="m6 2 6 6-6 6"/></svg>';

  // 업종: 카드의 네이버 분류를 손님이 묻는 세 갈래로 묶는다. 카드가 없는 갈래는 안 보여준다.
  const BAR_RE = /BAR|바$|술집|펍|와인|맥주/i, CAFE_RE = /카페|디저트|베이커리|빵|커피|아이스크림|젤라또/;
  const CATS = [
    ['전체', () => true],
    ['카페', p => CAFE_RE.test(p.cat)],
    ['식당', p => !CAFE_RE.test(p.cat) && !BAR_RE.test(p.cat)],
    ['바', p => BAR_RE.test(p.cat)],
  ];

  const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const dayLabel = day => { const d = new Date(day + 'T00:00:00Z'); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${DAY_NAMES[d.getUTCDay()]})`; };
  const mapUrl = p => p.target || ('https://map.naver.com/p/search/' + encodeURIComponent(p.name));

  let PICKS = [];
  const card = (p, today) => `
    <button class="ph" type="button" data-i="${PICKS.indexOf(p)}" aria-label="${esc(p.name)} 카드 크게 보기"><img src="${esc(p.thumb)}" alt="" loading="lazy" decoding="async"></button>
    <div class="info">
      <div>
        <div class="nm">${esc(p.name)}</div>
        <div class="sub">${today ? '<span class="today">Today</span>' : ''}<span>${esc(p.cat ? p.cat + ' · ' : '')}${dayLabel(p.day)}</span></div>
      </div>
      <a class="map" href="${esc(mapUrl(p))}" target="_blank" rel="noopener" aria-label="${esc(p.name)} 네이버 지도">${LINK}</a>
    </div>`;

  function render() {
    const main = $('main');
    if (!PICKS.length) { main.innerHTML = '<p class="empty">아직 추천이 없어요</p>'; return; }
    const today = kstToday();
    const since = new Date(today + 'T00:00:00Z'); since.setUTCDate(since.getUTCDate() - 6);
    const sinceStr = since.toISOString().slice(0, 10);
    const recent = PICKS.filter(p => p.day >= sinceStr), archive = PICKS.filter(p => p.day < sinceStr);

    let h = '';
    if (recent.length) {
      h += `<div class="sec"><h2>NEW</h2><div class="ctl"><span class="pos" id="pos"></span><button class="chev" type="button" id="prev" aria-label="더 최근 카드">${ARROW_L}</button><button class="chev" type="button" id="next" aria-label="지난 카드">${ARROW_R}</button></div></div>
        <div class="track" id="track">${recent.map(p => `<div class="slide">${card(p, p.day === today)}</div>`).join('')}</div>`;
    }
    if (archive.length) {
      h += `<div class="sec"><h2>지난 추천</h2></div><div class="segs" id="segs" role="group" aria-label="업종 선택"></div><div class="grid" id="grid"></div>`;
    }
    main.innerHTML = h;

    if (archive.length) {
      const cats = CATS.filter(c => archive.some(c[1]));
      const segs = $('segs'), grid = $('grid');
      const show = name => {
        segs.querySelectorAll('.seg').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.c === name)));
        const f = cats.find(c => c[0] === name)[1];
        grid.innerHTML = archive.filter(f).sort((a, b) => a.day.localeCompare(b.day)).map(p => `<div class="tile">${card(p, false)}</div>`).join('');
      };
      segs.innerHTML = cats.map(c => `<button class="seg" type="button" data-c="${c[0]}" aria-pressed="false">${c[0]}</button>`).join('');
      segs.hidden = cats.length < 3;   // '전체' 말고 고를 게 하나뿐이면 선택 줄이 의미 없다
      segs.addEventListener('click', e => { const b = e.target.closest('.seg'); if (b) show(b.dataset.c); });
      show(cats[0][0]);
    }

    const track = $('track');
    if (track) {
      const pos = $('pos'), prev = $('prev'), next = $('next');
      const step = () => track.firstElementChild.getBoundingClientRect().width + parseFloat(getComputedStyle(track).gap);
      const perView = () => Math.max(1, Math.round(track.clientWidth / step()));
      const sync = () => {
        const i = Math.round(track.scrollLeft / step()), n = perView();
        pos.textContent = `${Math.min(i + 1, recent.length)} / ${recent.length}`;
        prev.disabled = i <= 0; next.disabled = i + n >= recent.length;
      };
      track.addEventListener('scroll', sync, { passive: true });
      prev.addEventListener('click', () => track.scrollBy({ left: -step() * perView(), behavior: 'smooth' }));
      next.addEventListener('click', () => track.scrollBy({ left: step() * perView(), behavior: 'smooth' }));
      sync();
    }
  }

  // 크게 보기: 전체 카드 그림. Esc 나 바탕을 누르면 닫히고 포커스는 누른 카드로 돌아간다
  const lb = $('lb'), lbImg = $('lbImg'), lbMap = $('lbMap'), lbClose = $('lbClose');
  let opener = null;
  const hide = () => { lb.hidden = true; lbImg.src = ''; if (opener) opener.focus(); };
  document.addEventListener('click', e => {
    const b = e.target.closest('button.ph');
    if (b) { const p = PICKS[+b.dataset.i]; opener = b; lbImg.src = p.card; lbImg.alt = p.name + ' 추천 카드'; lbMap.href = mapUrl(p); lb.hidden = false; lbClose.focus(); return; }
    if (e.target === lbClose || e.target === lb) hide();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !lb.hidden) hide(); });

  fetch(`${API}/public/picks`)
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(j => { PICKS = (j.picks || []).filter(p => p.day && p.thumb); render(); })
    .catch(e => { console.error('추천 가게 모음 불러오기 실패:', e); $('main').innerHTML = '<p class="empty">지금은 불러올 수 없어요. 잠시 뒤 다시 열어 주세요.</p>'; });
})();
