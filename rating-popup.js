// 별점 평가 팝업 — 페이지에 일정 시간(1분) 머무르면 자동으로 노출 (홈+코스 페이지 공용)
// home.js의 인라인 #rateCard와 완전히 동일한 디자인(클래스: feedback/fbbtn/stars/star/done-line/fberr,
// index.html:136-145)을 그대로 재사용하고 어두운 배경(overlay)만 새로 씌운다. 각 페이지가 이미 자체
// top-level const를 쓰고 있어(예: course.html의 ADMIN_API) IIFE로 스코프를 격리해 전역 이름 충돌을 막는다.
(function () {
  const ADMIN_API = 'https://gs-trip-admin.mangrove-goseong.workers.dev';
  const FEEDBACK_ENDPOINT = ADMIN_API + '/feedback';
  const FB_TOKEN = 'gst-2026a';
  const DELAY_MS = 60000;
  const STORAGE_KEY = 'gsRatingPopupDone';

  const safeGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const safeSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

  if (safeGet('gstAdminSession')) return;   // 어드민 본인 방문은 제외
  if (safeGet(STORAGE_KEY)) return;         // 이미 평가했거나 닫은 적 있으면 다시 안 뜸

  function localAt() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function build() {
    const style = document.createElement('style');
    // 아래 카드 스타일 값(.feedback/.fbbtn/.stars/.star/.done-line/.fberr, textarea)은
    // index.html의 기존 #rateCard 디자인(index.html:136-145, 144)과 완전히 동일하게 맞춘 것.
    // 새로 생긴 건 어두운 배경(#rpOverlay)과 닫기 버튼(.rp-close)뿐 — 팝업이라 꼭 필요한 최소 추가.
    style.textContent = `
      #rpOverlay { position: fixed; inset: 0; background: rgba(0,0,0,.42); z-index: 9999; display: flex; align-items: center; justify-content: center; padding: 20px; font-family: 'Pretendard Variable', Pretendard, 'Apple SD Gothic Neo', -apple-system, BlinkMacSystemFont, sans-serif; }
      #rpOverlay .feedback { position: relative; width: 100%; max-width: 380px; margin: 0; background: #fff; border: 1px solid #e9e7e2; border-radius: 16px; padding: 17px 16px; text-align: center; }
      #rpOverlay .feedback p { font-size: 12.5px; color: #50514a; line-height: 1.7; margin-bottom: 13px; }
      #rpOverlay .rp-close { position: absolute; top: 8px; right: 8px; border: 0; background: none; font-size: 16px; color: #b3b2ab; cursor: pointer; line-height: 1; padding: 6px; }
      #rpOverlay .stars { display: flex; gap: 1px; justify-content: center; }
      #rpOverlay .star { font-size: 27px; line-height: 1; background: none; border: 0; cursor: pointer; padding: 4px 2px; filter: grayscale(1); opacity: .45; transition: filter .12s, opacity .12s, transform .12s; }
      #rpOverlay .star.on { filter: none; opacity: 1; }
      #rpOverlay .star:active { transform: scale(1.15); }
      #rpOverlay #rpForm textarea { width: 100%; border: 1.5px solid #e9e7e2; border-radius: 10px; padding: 11px 12px; font-size: 14px; font-family: inherit; margin: 11px 0 10px; min-height: 60px; resize: vertical; color: #1f1e1d; }
      #rpOverlay .fbbtn { width: 100%; background: #1f1e1d; color: #fff; border: 0; border-radius: 12px; padding: 13px; font-size: 14px; font-weight: 700; cursor: pointer; }
      #rpOverlay .fbbtn:disabled { opacity: .5; cursor: default; }
      #rpOverlay .fberr { display: none; font-size: 12.5px; font-weight: 600; color: #b03a3a; background: #fbeaea; border-radius: 9px; padding: 8px 11px; margin-bottom: 9px; line-height: 1.5; text-align: left; }
      #rpOverlay .fberr.show { display: block; }
      #rpOverlay .done-line { font-size: 14px; font-weight: 700; color: #0a7a3c; padding: 6px 0 2px; }
    `;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.id = 'rpOverlay';
    overlay.innerHTML = `
      <div class="feedback">
        <button class="rp-close" id="rpClose" aria-label="닫기">✕</button>
        <p><b>이 추천 서비스는 어떠셨어요?</b><br>원하는 별점을 누르고, 아래 '별점 추가하기' 버튼을 눌러주세요.</p>
        <div class="stars" id="rpStars">
          ${[1, 2, 3, 4, 5].map(v => `<button class="star" data-v="${v}" aria-label="${v}점">⭐</button>`).join('')}
        </div>
        <div id="rpForm" style="display:none">
          <textarea id="rpMemo" maxlength="300" placeholder="어떤 부분이 도움이 되었는지 적어주세요. 혹은 필요한 정보가 있다면 적어주셔도 좋아요."></textarea>
          <div class="fberr" id="rpErr" role="alert"></div>
          <button class="fbbtn" id="rpSend">별점 추가하기</button>
        </div>
        <div class="done-line" id="rpDone" style="display:none">🙌 감사합니다! 더 좋은 추천으로 보답할게요.</div>
      </div>
    `;
    document.body.appendChild(overlay);

    let score = 0;
    const close = markDone => { if (markDone) safeSet(STORAGE_KEY, '1'); overlay.remove(); style.remove(); };

    overlay.addEventListener('click', e => { if (e.target === overlay) close(true); });
    overlay.querySelector('#rpClose').addEventListener('click', () => close(true));

    overlay.querySelector('#rpStars').addEventListener('click', e => {
      const b = e.target.closest('.star');
      if (!b) return;
      score = Number(b.dataset.v);
      overlay.querySelectorAll('.star').forEach(s => s.classList.toggle('on', Number(s.dataset.v) <= score));
      overlay.querySelector('#rpForm').style.display = '';
    });

    overlay.querySelector('#rpSend').addEventListener('click', async () => {
      if (!score) return;
      const btn = overlay.querySelector('#rpSend');
      btn.disabled = true;
      try {
        const memo = overlay.querySelector('#rpMemo').value.trim().slice(0, 300);
        const payload = { kind: 'rating', score, memo, at: localAt(), t: FB_TOKEN };
        const r = await fetch(FEEDBACK_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
        if (!r.ok) throw new Error('전송 실패 ' + r.status);
        overlay.querySelector('#rpStars').style.display = 'none';
        overlay.querySelector('#rpForm').style.display = 'none';
        overlay.querySelector('#rpDone').style.display = '';
        safeSet(STORAGE_KEY, '1');
        setTimeout(() => close(false), 1800);
      } catch (e) {
        const err = overlay.querySelector('#rpErr');
        if (err) { err.textContent = '전송에 실패했어요. 잠시 후 다시 시도해주세요.'; err.classList.add('show'); }
        btn.disabled = false;
      }
    });
  }

  setTimeout(build, DELAY_MS);
})();
