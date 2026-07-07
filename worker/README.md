# gs-trip-admin — 어드민 백엔드 (Cloudflare Worker + D1)

트립코스 어드민 편집(제외·예약·강추·포장·메모·직접추가)과 피드백 수신을 담당하는
작은 서버. Cloudflare 계정 **goseong@mgrv.company** (공용 업무 계정) 소유.

| 파일 | 역할 |
|---|---|
| `src/index.js` | 서버 본체 (로그인·편집 API·공개 읽기·피드백→슬랙) |
| `schema.sql` | DB 테이블 정의 |
| `migrate.js` | 기존 overrides/manual_places JSON → DB 1회 이전 (seed.sql 생성) |
| `wrangler.jsonc` | 배포 설정 |
| `.dev.vars` | **로컬 시험용** 가짜 비밀값 (gitignore — 실배포와 무관) |

## 최초 배포 순서 (1회)

```bash
cd worker
npx wrangler login                       # 브라우저 열림 → goseong@ 계정으로 허용
npx wrangler d1 create gs_trip           # 출력된 database_id 를 wrangler.jsonc 에 붙여넣기
npx wrangler d1 execute gs_trip --remote --file=schema.sql
node migrate.js                          # (프로젝트 루트에서: node worker/migrate.js)
npx wrangler d1 execute gs_trip --remote --file=seed.sql
npx wrangler secret put ADMIN_PASSWORD   # 어드민 비밀번호 — 사용자가 직접 입력
npx wrangler secret put SLACK_WEBHOOK    # #gs-routine 웹훅 주소
npx wrangler deploy                      # 배포 → https://gs-trip-admin.<계정>.workers.dev
```

## 코드 수정 후 재배포

```bash
cd worker && npx wrangler deploy
```

## 로컬 시험 (Cloudflare 계정 불필요)

```bash
cd worker
npx wrangler d1 execute gs_trip --local --file=schema.sql
npx wrangler dev --port 8787 --local     # .dev.vars 의 시험용 비밀값 사용
```

## API 요약

| 주소 | 인증 | 설명 |
|---|---|---|
| `GET /public/data` | 없음 | 투숙객 페이지용 편집 데이터 (sid 키, 캐시 없음 = 즉시 반영) |
| `GET /public/export` | 없음 | 주간 빌드용 — 기존 overrides.json/manual_places.json 형식 |
| `POST /feedback` | FB_TOKEN | 피드백 → 슬랙 (10분 15건 제한, 구 Apps Script 대체) |
| `POST /login` | 비밀번호 | 세션 토큰 발급 (60일 유지, 10분 10회 시도 제한) |
| `POST /logout` | Bearer | 세션 종료 |
| `GET /admin/data` | Bearer | 편집 데이터 원본 전체 |
| `PUT /admin/override` | Bearer | 가게 편집 저장 (전부 비우면 삭제) |
| `PUT /admin/manual` / `DELETE /admin/manual?sid=` | Bearer | 직접추가 저장/삭제 |

## 장애 시

- Worker가 죽어도 투숙객 사이트는 `places.js` 스냅샷(주간 빌드분)으로 정상 표시됨.
- 오류 로그 확인: `cd worker && npx wrangler tail`
