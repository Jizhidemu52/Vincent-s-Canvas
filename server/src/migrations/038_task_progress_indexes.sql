-- Bounded progress reads must not sort/scan the settled task archive every poll.
CREATE INDEX tasks_model_active_progress_idx ON tasks(model_config_id, id)
    WHERE status IN ('waiting', 'processing', 'paused');
CREATE INDEX tasks_model_duration_sample_idx ON tasks(model_config_id, operation_type, completed_at DESC, id DESC)
    WHERE status='success' AND attempts=1;
