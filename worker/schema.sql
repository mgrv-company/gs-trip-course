-- gs-trip-course 어드민 백엔드 D1 스키마
-- 적용: npx wrangler d1 execute gs_trip --remote --file=worker/schema.sql

-- 가게별 편집(제외/예약/강추/포장/노션/메모) — 키는 sid (이름 아님: 상호 바뀌어도 안 끊김)
-- ⚠️ natural 컬럼은 2026-07-16 ALTER TABLE로 기존 배포 DB에 추가함(CREATE TABLE IF NOT EXISTS는
--    이미 있는 테이블엔 컬럼을 못 더해서, 신규 설치 대비용으로만 여기 반영). natural: NULL=자동분류
--    따름, 0/1=명소 자연명소 여부 수동 지정(어드민 토글이 최우선)
CREATE TABLE IF NOT EXISTS overrides (
  sid        TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',      -- 표시·대조용 (매칭 키 아님)
  exclude    INTEGER NOT NULL DEFAULT 0,
  reserve    INTEGER NOT NULL DEFAULT 0,
  pick       INTEGER NOT NULL DEFAULT 0,
  takeout    INTEGER NOT NULL DEFAULT 0,
  notion     INTEGER NOT NULL DEFAULT 0,
  natural    INTEGER,
  note       TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);

-- 어드민에서 직접 추가한 가게 — 원본 객체를 JSON 그대로 보관 (주간 갱신에도 안 지워짐)
CREATE TABLE IF NOT EXISTS manual_places (
  sid        TEXT PRIMARY KEY,              -- 'm' + timestamp (기존 방식 유지)
  json       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ''
);

-- 서비스 별점 평가 (투숙객이 "이 추천 어때요?"에 남긴 것 — 집계용 보관 + 슬랙 알림)
CREATE TABLE IF NOT EXISTS ratings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  score      INTEGER NOT NULL,               -- 1~5
  memo       TEXT NOT NULL DEFAULT '',
  at         TEXT NOT NULL DEFAULT ''
);

-- 사이트 문구·테마 (어드민 "문구·디자인" 탭 편집분) — key='site' 한 행에 JSON 통째로 보관.
-- 값이 없거나 죽어도 프론트는 index.html/home.js 기본 문구로 정상 동작.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);

-- 디자인 코멘트 (어드민이 메인 페이지에서 요소를 클릭해 남긴 메모) — 나중에 일괄 반영용.
-- target: 문구 key(data-copy) 또는 위치 설명 / label: 클릭 당시 요소 텍스트 / note: 사용자 메모
CREATE TABLE IF NOT EXISTS annotations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target      TEXT NOT NULL DEFAULT '',
  label       TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  page        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',   -- open | done
  created_at  TEXT NOT NULL DEFAULT '',
  resolved_at TEXT NOT NULL DEFAULT ''
);

-- 손님 페이지 조회수 (KST 날짜별 집계 — 브라우저당 하루 1회, 어드민 본인 제외)
CREATE TABLE IF NOT EXISTS pageviews (
  day TEXT PRIMARY KEY,
  n   INTEGER NOT NULL DEFAULT 0
);

-- 가게별 클릭수 (손님이 카드의 '네이버 지도에서 보기'를 누른 횟수 — 어드민 본인 제외)
CREATE TABLE IF NOT EXISTS place_clicks (
  key  TEXT PRIMARY KEY,               -- sid (없으면 가게 이름)
  name TEXT NOT NULL DEFAULT '',
  n    INTEGER NOT NULL DEFAULT 0
);

-- 가게별 노출수 (추천 리스트에 실제로 보여진 횟수 — 어드민 제외). 클릭수÷노출수 = CTR(진짜 관심도)
CREATE TABLE IF NOT EXISTS place_impressions (
  key  TEXT PRIMARY KEY,               -- sid (없으면 가게 이름), place_clicks 와 동일 키
  name TEXT NOT NULL DEFAULT '',
  n    INTEGER NOT NULL DEFAULT 0
);

-- 시간대별(0~23시, KST) 클릭 분포 — 언제 손님이 많이 클릭하는지 (요일 구분 없이 시각만)
CREATE TABLE IF NOT EXISTS click_hours (
  hour INTEGER PRIMARY KEY,
  n    INTEGER NOT NULL DEFAULT 0
);

-- 코스 생성기(course.html) 조회수 — 홈(pageviews)과 분리 집계, 날짜별
CREATE TABLE IF NOT EXISTS course_views (
  day TEXT PRIMARY KEY,
  n   INTEGER NOT NULL DEFAULT 0
);

-- 화면 UI 이벤트(탭 전환·하단 모음 열람) 누적 카운트 — key 예: 'tab:meal', 'coll:capick'
CREATE TABLE IF NOT EXISTS ui_events (
  key TEXT PRIMARY KEY,
  n   INTEGER NOT NULL DEFAULT 0
);

-- 가게별 클릭수를 날짜별로도 저장 — place_clicks(누적 총합)만으로는 "이번 주 뜨는 가게"를 알 수 없어서 추가
CREATE TABLE IF NOT EXISTS place_clicks_daily (
  day  TEXT NOT NULL,
  key  TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  n    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key)
);

-- 가게 피드백 텍스트 보관(그동안 슬랙으로만 가고 DB엔 안 남았음) — 나중에 검색·집계용
CREATE TABLE IF NOT EXISTS feedback (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  place TEXT NOT NULL DEFAULT '',
  memo  TEXT NOT NULL DEFAULT '',
  at    TEXT NOT NULL DEFAULT ''
);

-- 어드민 로그인 세션 (비밀번호 확인 후 발급되는 임시 열쇠)
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- 횟수 제한 카운터 (피드백 스팸·로그인 무차별 시도 방지)
CREATE TABLE IF NOT EXISTS rate_counters (
  bucket     TEXT PRIMARY KEY,              -- 예: '2026-07-06T09:0|fb' (10분 단위 창, 날짜가 맨 앞)
  n          INTEGER NOT NULL DEFAULT 0
);
