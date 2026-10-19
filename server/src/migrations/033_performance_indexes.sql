CREATE INDEX IF NOT EXISTS assets_task_idx ON assets(task_id) WHERE task_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS credit_reservations_user_status_idx ON credit_reservations(user_id, status);
CREATE INDEX IF NOT EXISTS batch_tasks_user_time_idx ON batch_tasks(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS assets_company_time_idx ON assets(created_at DESC, id DESC) WHERE visibility_scope='company' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS tasks_user_cursor_idx ON tasks(user_id, queued_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS tasks_cursor_idx ON tasks(queued_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS history_user_cursor_idx ON generation_history(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS history_cursor_idx ON generation_history(created_at DESC, id DESC);
