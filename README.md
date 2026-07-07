# 맹그로브 고성 · 로컬 트립 코스

투숙객이 QR코드로 접속하는 **"지금 갈만한 곳"** 모바일 웹. 현재 시각 기준으로
문 연 곳 중에서 CA가 다녀본 속초·고성 가게를 추천한다.

- 사이트: https://mgrv-company.github.io/gs-trip-course/ (GitHub Pages, 서버 없는 정적 페이지)
- 어드민: `/admin.html` — 비밀번호 로그인, 편집(강추·제외·예약·메모·직접추가)은 **저장 즉시 사이트 반영**
- 백엔드: Cloudflare Worker + D1 (`worker/`, goseong@ 계정) — 어드민 편집 저장소 + 피드백(→슬랙) 수신
- 기준점: 맹그로브 고성 (강원 고성군 토성면 교암길 20)

## 구조

| 파일 | 역할 |
|---|---|
| `index.html` + `home.js` | 홈 "지금 갈만한 곳" (스냅샷 + 백엔드 편집 오버레이) |
| `places.js` | 장소 데이터 스냅샷 (자동 생성 — 직접 수정 금지) |
| `tour.js` | 관광공사 TourAPI 데이터 (액티비티·해수욕장, 자동 생성) |
| `course*.html` | 추천 코스 3종 (주간 스냅샷 기준) |
| `admin.html` + `admin.js` | 가게 관리 어드민 |
| `worker/` | Cloudflare 백엔드 (배포법은 `worker/README.md`) |
| `data/` | 수집 스크립트 + 산출물 (일부만 커밋) |

## 데이터 흐름

1. **주간 갱신** (월 08:20, 로컬 PC 스케줄러): 네이버 저장 리스트 재수집 → 신규/폐업 반영 →
   영업시간·평점·메뉴·리뷰·사진 수집 → D1 편집 동기화 → `places.js` 빌드 → 커밋·푸시 → 슬랙 알림
2. **매일 스냅샷** (07:00 KST, GitHub Actions): D1 편집만 받아 `places.js` 재빌드 (PC 불필요)
3. **어드민 편집**: D1에 즉시 저장 → 투숙객 페이지가 열릴 때 스냅샷 위에 얹음 (즉시 반영)
4. **피드백**: 사이트 폼 → Worker `/feedback` (토큰·횟수 검증) → 슬랙 #gs-routine

## 갱신·운영

- 수동 갱신: `python data/refresh_all.py` (전체 재수집은 `--full`, 가게당 4초 간격 필수)
- 어드민에서 "사이트 스냅샷 재빌드" 버튼으로 Actions 수동 트리거 가능 (GH_TOKEN 필요)
- 진행 문서: `_private/작업지시서-어드민고도화.md` (비공개)

## 테스트

```
node test/admin_check.js         # 어드민 (모의 백엔드)
node test/live_overlay_check.js  # 홈 오버레이·폴백
```
(사전에 `python -m http.server 8000` 실행, Playwright는 wings-phone-fix 재사용)
