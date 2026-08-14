-- D1 schema for the hosted trainer. Copied verbatim from BACKEND-PLAN.md §3,
-- the authoritative source, with IF NOT EXISTS added so re-running this file
-- (e.g. against a fresh `wrangler d1 execute`) is always safe. Do not let this
-- drift from the plan; if the plan changes, change both.

-- Who is allowed to use the app. Imported per semester from the registry.
CREATE TABLE IF NOT EXISTS roster (
  student_id   TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,        -- lowercased at import time
  full_name    TEXT NOT NULL,
  cohort       TEXT,                        -- e.g. '2026-2027-S1'
  lms_user_id  TEXT,                        -- null until Canvas; see §9
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

-- One live login code per address. Rows are short-lived.
CREATE TABLE IF NOT EXISTS login_codes (
  email        TEXT PRIMARY KEY,
  code_hash    TEXT NOT NULL,               -- SHA-256 of the 6 digits
  expires_at   INTEGER NOT NULL,            -- unix seconds
  attempts     INTEGER NOT NULL DEFAULT 0,
  requested_at INTEGER NOT NULL
);

-- Rate limiting for /api/auth/request, keyed by email and by IP.
CREATE TABLE IF NOT EXISTS request_log (
  key          TEXT NOT NULL,               -- 'email:…' or 'ip:…'
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);

-- One row per completed interview.
CREATE TABLE IF NOT EXISTS submissions (
  id              TEXT PRIMARY KEY,         -- uuid
  student_id      TEXT NOT NULL REFERENCES roster(student_id),
  persona_id      TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER NOT NULL,
  duration_ms     INTEGER NOT NULL,
  overall_score   REAL,                     -- null when nothing was assessable
  scores_json     TEXT NOT NULL,
  feedback_json   TEXT NOT NULL,
  metrics_json    TEXT NOT NULL,
  transcript_json TEXT NOT NULL,
  emailed_at      INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(student_id, created_at);

-- Per-student daily cap on realtime sessions. Protects the university key.
CREATE TABLE IF NOT EXISTS session_grants (
  student_id TEXT NOT NULL,
  day        TEXT NOT NULL,                 -- 'YYYY-MM-DD'
  count      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (student_id, day)
);

-- Everything the instructor can change without a deploy. See §7.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT                           -- instructor email from Access
);

-- Personas, editable from the dashboard. Seeded from src/personas.ts.
CREATE TABLE IF NOT EXISTS personas (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  title              TEXT NOT NULL,
  research_topic     TEXT NOT NULL,
  short_bio          TEXT NOT NULL,         -- must stay spoiler-free
  voice_name         TEXT NOT NULL,
  system_instruction TEXT NOT NULL,
  hidden_core        TEXT,
  active             INTEGER NOT NULL DEFAULT 1,
  updated_at         INTEGER NOT NULL,
  updated_by         TEXT
);

-- Every save of a persona, never deleted. See §7 on why this is not optional.
CREATE TABLE IF NOT EXISTS persona_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id  TEXT NOT NULL,
  snapshot    TEXT NOT NULL,                -- full JSON of the row as saved
  saved_at    INTEGER NOT NULL,
  saved_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_persona_versions ON persona_versions(persona_id, saved_at);
