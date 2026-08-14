# daily-card

"오늘의 고성 추천" 카드 이미지 렌더러. `data/daily_pick.py`가 매일 호출한다.

## 최초 1회 설정

```
cd automation/daily-card
npm install
```
(Chromium 브라우저가 이 컴퓨터에 이미 있어야 함 — 없으면 `npx playwright install chromium`)

## 단독 실행

```
node render.mjs <data.json> <output.png>
```

`data.json` 형태는 `template.html`의 `renderCard()` 주석 참고 (name/category/zone/move/hours/isOpen/rating/menu/blurb/img/date).

## 디자인 미리보기

`template.html`을 브라우저로 직접 열면 샘플 데이터로 카드가 바로 보인다(디자인 수정할 때 편함).
render.mjs로 자동 렌더할 때는 이 샘플 자동렌더가 `window.__NO_AUTO__`로 막힌다.

## 톤

이 카드는 `../../design/tokens.css`(2026-08-14 work-stay 실측 디자인시스템)를 그대로 따른다.
index.html(앱)의 부드러운 유틸리티 톤과 달리, 공유용 완성 이미지라 각진 언어를 더 그대로 가져왔다.
