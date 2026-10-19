ALTER TABLE tasks
    ADD COLUMN available_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN execution_token uuid,
    ADD COLUMN model_slot_token uuid,
    ADD COLUMN model_slot_expires_at timestamptz,
    ADD COLUMN poll_deadline_at timestamptz;
CREATE INDEX tasks_waiting_available_idx ON tasks(available_at, queued_at, id) WHERE status='waiting';
CREATE INDEX tasks_model_slot_idx ON tasks(model_config_id, model_slot_expires_at) WHERE model_slot_token IS NOT NULL;
CREATE INDEX tasks_poll_available_idx ON tasks(available_at, id) WHERE status='processing' AND execution_token IS NULL AND upstream_task_id IS NOT NULL;
