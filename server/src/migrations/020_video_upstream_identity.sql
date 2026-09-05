ALTER TABLE tasks ADD COLUMN upstream_task_id text;
ALTER TABLE tasks ADD COLUMN upstream_submission_started_at timestamptz;
