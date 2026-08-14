-- Initial settings row values. INSERT OR IGNORE so re-running this after the
-- instructor has edited a value from the dashboard never clobbers the edit.
-- Deliberately does NOT seed openai_api_key or instructor_recipients: both
-- "none, must be set" per BACKEND-PLAN.md §3, and the key must never sit in a
-- file that could be committed.

INSERT OR IGNORE INTO settings (key, value, updated_at, updated_by) VALUES
  ('interview_limit_minutes', '12', strftime('%s','now'), 'seed'),
  ('interview_warn_minutes', '10', strftime('%s','now'), 'seed'),
  ('sessions_per_day', '5', strftime('%s','now'), 'seed'),
  ('interview_model', 'gpt-realtime-2.1-mini', strftime('%s','now'), 'seed'),
  ('scoring_model', 'gpt-5.6-terra', strftime('%s','now'), 'seed'),
  ('instructor_recipients', '', strftime('%s','now'), 'seed');
