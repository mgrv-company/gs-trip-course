function debug(msg) { const el = document.getElementById('debugLine'); if (el) el.textContent = msg; if (msg) console.log('[지도 디버그]', msg); }
window.addEventListener('error', (e) => debug('스크립트 오류: ' + (e.error && e.error.message ? e.error.message : e.message)));

try {

if (typeof PLACES === 'undefined') { debug('places.js를 못 불러왔어요.'); throw new Error('no PLACES'); }

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function driveMin(d) { return Math.round(d / 50 * 60) + 3; }

// 이미지(정적 지도)의 실제 픽셀 크기 — assets/map/goseong-static-map.png 생성 시 확정된 값
const IMG_W = 688, IMG_H = 1551;
// 각 지점의 이미지 내 위치(%) — 지도 이미지 생성 스크립트가 계산한 값(위경도를 Web Mercator로 투영)
const MG_POS = { px: 67.28123436428139, py: 68.32128806911587 };

// places.js엔 지도용 %좌표가 없으므로, 정적 지도 생성 당시 계산한 값을 sid로 매핑해 붙임
const MAP_POS = {"13491638": {"px": 66.89750140394017, "py": 67.15663296346102}, "13491425": {"px": 69.59006718916876, "py": 71.03883178212224}, "13491937": {"px": 66.63078498181542, "py": 64.99629060541663}, "21656492": {"px": 70.91941570576172, "py": 72.88992599571003}, "13491134": {"px": 65.08975676510791, "py": 63.21853149890679}, "1056026653": {"px": 71.8677407621789, "py": 73.38973543959413}, "13444347": {"px": 62.70412654503359, "py": 61.98461654922882}, "13491824": {"px": 72.51971423847628, "py": 74.85081837900664}, "13491948": {"px": 74.91592844358509, "py": 76.54131256406855}, "13491251": {"px": 58.58272278414161, "py": 59.43031612843751}, "13491067": {"px": 58.79016889024238, "py": 57.89373525910586}, "13491061": {"px": 52.06629022450867, "py": 52.899242243131525}, "36072526": {"px": 51.20356843878652, "py": 51.70055669999593}, "13491890": {"px": 87.25262136518828, "py": 84.98414841828935}, "13491770": {"px": 50.91568404666048, "py": 47.727809872311674}, "11491735": {"px": 90.79190595080749, "py": 91.37330938213556}, "1505275206": {"px": 44.35361334368402, "py": 44.8728085625061}, "13491373": {"px": 93.10344827584339, "py": 93.12191526588587}, "11491707": {"px": 31.4125748783033, "py": 36.220790282954944}, "13491505": {"px": 27.99923971423923, "py": 31.20683560550834}, "36072141": {"px": 32.38100950625217, "py": 29.80919753385117}, "11491809": {"px": 21.090014303095852, "py": 22.274870404239834}, "13491028": {"px": 17.042698437242276, "py": 19.012653840620644}, "36072157": {"px": 16.99189530922899, "py": 18.127431532501532}, "13491292": {"px": 15.027507692343084, "py": 16.313663714778645}, "13491518": {"px": 13.283266963548579, "py": 14.80444458831397}, "13491513": {"px": 6.896551724122761, "py": 6.915129136167107}};
PLACES.forEach(p => { const m = MAP_POS[p.s]; if (m) { p._mapPx = m.px; p._mapPy = m.py; } });
const beaches = PLACES.filter(p => p.t === '해변' && !p.x && p._mapPx != null);
debug('진단: PLACES ' + PLACES.length + '개 · 해변 매칭 ' + beaches.length + '개 · 이미지 크기(고정값) ' + IMG_W + 'x' + IMG_H);

const wrapEl = document.getElementById('mapWrap');
const stage = document.getElementById('stage');
const pinsHost = document.getElementById('pinsHost');

function localXY(p) { return { x: p._mapPx / 100 * IMG_W, y: p._mapPy / 100 * IMG_H }; }
const MG_LOCAL = { x: MG_POS.px / 100 * IMG_W, y: MG_POS.py / 100 * IMG_H };

let scale = 1, tx = 0, ty = 0;
function applyTransform() { stage.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; }
function clampScale(s) { return Math.max(0.25, Math.min(3, s)); }

function fitAll() {
  const cw = wrapEl.clientWidth, ch = wrapEl.clientHeight;
  scale = clampScale(Math.min(cw / IMG_W, ch / IMG_H) * 0.94);
  tx = (cw - IMG_W * scale) / 2;
  ty = (ch - IMG_H * scale) / 2;
  applyTransform();
}
function centerOnMangrove() {
  const cw = wrapEl.clientWidth, ch = wrapEl.clientHeight;
  scale = clampScale(1.15);
  tx = cw / 2 - MG_LOCAL.x * scale;
  ty = ch / 2 - MG_LOCAL.y * scale;
  applyTransform();
}

function computeClusters() {
  const sorted = beaches.slice().sort((a, b) => (b.rv ? b.rv[1] : 0) - (a.rv ? a.rv[1] : 0));
  const THRESH = 30;
  const placed = [];
  for (const b of sorted) {
    const l = localXY(b);
    const sx = tx + l.x * scale, sy = ty + l.y * scale;
    let host = null;
    for (const p of placed) {
      const dx = sx - p._sx, dy = sy - p._sy;
      if (Math.sqrt(dx * dx + dy * dy) < THRESH) { host = p; break; }
    }
    if (host) host._members.push(b);
    else { b._sx = sx; b._sy = sy; b._members = [b]; placed.push(b); }
  }
  return placed;
}

let selected = null;
function renderPins() {
  const clusters = computeClusters();
  pinsHost.innerHTML = clusters.map(b => {
    const l = localXY(b);
    const n = b.rv ? b.rv[1] : 0;
    const size = Math.max(20, Math.min(34, 20 + Math.log10(n + 1) * 6)) / scale;
    const isSel = selected === b;
    const badge = b._members.length > 1 ? `<div class="badge">+${b._members.length - 1}</div>` : '';
    return `<div class="pin${isSel ? ' selected' : ''}" data-sid="${esc(b.s)}" style="left:${l.x}px;top:${l.y}px;transform:translate(-50%,-50%)">`
      + `<div class="core" style="width:${size}px;height:${size}px;font-size:${size * 0.5}px">🏖</div>${badge}</div>`;
  }).join('')
  + `<div class="mg-pin" style="left:${MG_LOCAL.x}px;top:${MG_LOCAL.y}px"></div>`;
  pinsHost.querySelectorAll('.pin').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const b = beaches.find(x => x.s === el.dataset.sid);
    if (b) selectBeach(b);
  }));
  debug('그려진 핀 ' + pinsHost.querySelectorAll('.pin').length + '개(클러스터 ' + clusters.length + ') · scale=' + scale.toFixed(2) + ' tx=' + Math.round(tx) + ' ty=' + Math.round(ty) + ' · 지도 실제크기=' + (mapImg.naturalWidth || '?') + 'x' + (mapImg.naturalHeight || '?'));
}

function beachCardHTML(b) {
  const rv = b.rv ? `<span class="rv">★ ${esc(b.rv[0])} (${esc(b.rv[1])})</span>` : `<span>리뷰 정보 없음</span>`;
  const img = b.img ? `<img class="ph" src="${esc(b.img)}" loading="lazy" alt="">` : `<div class="noph">🏖</div>`;
  return `${img}<div class="bd">
    <div class="nm">${esc(b.n)}</div>
    <div class="meta">${rv}<span class="drive">🚗 맹그로브에서 차로 ${driveMin(b.d)}분</span></div>
    <div class="links"><a href="${esc(b.u)}" target="_blank" rel="noopener">네이버 지도에서 보기 →</a></div>
  </div>`;
}
function findCluster(b) { return computeClusters().find(c => c._members.includes(b)) || { _members: [b] }; }

function selectBeach(b) {
  selected = b;
  renderPins();
  const panel = document.getElementById('infoPanel');
  const cluster = findCluster(b);
  let html = `<div class="beachcard">${beachCardHTML(b)}`;
  if (cluster._members.length > 1) {
    const others = cluster._members.filter(m => m !== b).sort((x, y) => (y.rv ? y.rv[1] : 0) - (x.rv ? x.rv[1] : 0));
    html += `<div class="bd nearby"><div class="lbl">📍 이 근처에 ${others.length}곳 더 있어요</div><div class="chips">`
      + others.map(o => `<span class="chip" data-sid="${esc(o.s)}">${esc(o.n)}${o.rv ? ' · ★' + esc(o.rv[0]) : ''}</span>`).join('')
      + `</div></div>`;
  }
  html += `</div>`;
  panel.innerHTML = html;
  panel.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
    const target = beaches.find(m => m.s === c.dataset.sid);
    if (target) selectBeach(target);
  }));
}

let dragging = false, dragStart = null, dragOrigin = null;
wrapEl.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.zoomctl') || e.target.closest('.resetbtn') || e.target.closest('.pin')) return;
  dragging = true; wrapEl.classList.add('dragging');
  dragStart = { x: e.clientX, y: e.clientY }; dragOrigin = { tx, ty };
  wrapEl.setPointerCapture(e.pointerId);
});
wrapEl.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  tx = dragOrigin.tx + (e.clientX - dragStart.x);
  ty = dragOrigin.ty + (e.clientY - dragStart.y);
  applyTransform();
});
function endDrag() { dragging = false; wrapEl.classList.remove('dragging'); }
wrapEl.addEventListener('pointerup', endDrag);
wrapEl.addEventListener('pointercancel', endDrag);

function zoomAt(clientX, clientY, factor) {
  const rect = wrapEl.getBoundingClientRect();
  const mx = clientX - rect.left, my = clientY - rect.top;
  const localX = (mx - tx) / scale, localY = (my - ty) / scale;
  scale = clampScale(scale * factor);
  tx = mx - localX * scale;
  ty = my - localY * scale;
  applyTransform();
  renderPins();
}
wrapEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.18 : 1 / 1.18);
}, { passive: false });
document.getElementById('zoomIn').addEventListener('click', () => {
  const r = wrapEl.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.35);
});
document.getElementById('zoomOut').addEventListener('click', () => {
  const r = wrapEl.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.35);
});
document.getElementById('resetBtn').addEventListener('click', () => { centerOnMangrove(); renderPins(); });

let pinchStartDist = null, pinchStartScale = 1;
wrapEl.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    pinchStartDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    pinchStartScale = scale; dragging = false;
  }
}, { passive: true });
wrapEl.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && pinchStartDist) {
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2, cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    const rect = wrapEl.getBoundingClientRect();
    const mx = cx - rect.left, my = cy - rect.top;
    const localX = (mx - tx) / scale, localY = (my - ty) / scale;
    scale = clampScale(pinchStartScale * (d / pinchStartDist));
    tx = mx - localX * scale; ty = my - localY * scale;
    applyTransform(); renderPins();
  }
}, { passive: true });

const mapImg = document.getElementById('mapImg');
function start() {
  centerOnMangrove();
  renderPins();
  const top = beaches.slice().sort((a, b) => (b.rv ? b.rv[1] : 0) - (a.rv ? a.rv[1] : 0))[0];
  if (top) selectBeach(top);
  else document.getElementById('infoPanel').innerHTML = '<div class="empty-hint">해변 데이터를 찾지 못했어요.</div>';
}
if (mapImg.complete) start();
else {
  mapImg.addEventListener('load', start);
  mapImg.addEventListener('error', () => debug('지도 이미지(assets/map/goseong-static-map.png)를 못 불러왔어요.'));
}

} catch (err) {
  debug('오류: ' + (err && err.message ? err.message : String(err)));
  console.error(err);
}
