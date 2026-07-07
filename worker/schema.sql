-- gs-trip-course 어드민 백엔드 D1 스키마
-- 적용: npx wrangler d1 execute gs_trip --remote --file=worker/schema.sql

-- 가게별 편집(제외/예약/강추/포장/노션/메모) — 키는 sid (이름 아님: 상호 바뀌어도 안 끊김)
CREATE TABLE IF NOT EXISTS overrides (
  sid        TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',      -- 표시·대조용 (매칭 키 아님)
  exclude    INTEGER NOT NULL DEFAULT 0,
  reserve    INTEGER NOT NULL DEFAULT 0,
  pick       INTEGER NOT NULL DEFAULT 0,
  takeout    INTEGER NOT NULL DEFAULT 0,
  notion     INTEGER NOT NULL DEFAULT 0,
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
