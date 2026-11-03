-- 016_tasks_two_way.sql - read changes back from Google Tasks.
ALTER TABLE task_links ADD COLUMN completed_in_google_at timestamptz;   -- ticked off in Google, next action not set yet
ALTER TABLE calendar_connections ADD COLUMN tasks_pulled_at timestamptz;
