ALTER TABLE assets ADD COLUMN thumbnail_256_key text, ADD COLUMN thumbnail_1024_key text;
CREATE INDEX IF NOT EXISTS assets_cursor_idx ON assets(created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS assets_owner_cursor_idx ON assets(owner_user_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS assets_department_cursor_idx ON assets(department_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS assets_project_cursor_idx ON assets(project_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
