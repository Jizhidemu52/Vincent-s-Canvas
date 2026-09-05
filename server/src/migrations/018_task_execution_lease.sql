ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS tasks_processing_lease_idx
    ON tasks(lease_expires_at)
    WHERE status = 'processing';
