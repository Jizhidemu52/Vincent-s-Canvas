CREATE FUNCTION notify_canvas_task_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND
       (CASE WHEN OLD.status IN ('waiting','processing') THEN 'active' ELSE OLD.status END,
        OLD.started_at IS NOT NULL, OLD.result_urls, OLD.failure_reason,
        OLD.upstream_task_id, OLD.upstream_submission_started_at)
       IS NOT DISTINCT FROM
       (CASE WHEN NEW.status IN ('waiting','processing') THEN 'active' ELSE NEW.status END,
        NEW.started_at IS NOT NULL, NEW.result_urls, NEW.failure_reason,
        NEW.upstream_task_id, NEW.upstream_submission_started_at) THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'DELETE' THEN
        PERFORM pg_notify('canvas_task_changes', json_build_object('id', OLD.id, 'userId', OLD.user_id)::text);
    ELSE
        PERFORM pg_notify('canvas_task_changes', json_build_object('id', NEW.id, 'userId', NEW.user_id)::text);
    END IF;
    RETURN NULL;
END;
$$;

-- PostgreSQL delivers NOTIFY only after commit. Lease/slot heartbeats do not
-- invoke this trigger, and updates that assign the same values stay silent.
-- Queue claim/defer cycles are both "active": notify the first preparation and
-- real submission, not every scheduling tick while waiting for a model slot.
CREATE TRIGGER canvas_task_changes
AFTER INSERT OR DELETE OR UPDATE OF status, started_at, result_urls, failure_reason, upstream_task_id, upstream_submission_started_at
ON tasks FOR EACH ROW EXECUTE FUNCTION notify_canvas_task_change();
