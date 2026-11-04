-- Rebuildable, private analytics projections. No business rows or balances are changed.
CREATE TABLE usage_rollup_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  processing_enabled boolean NOT NULL DEFAULT false,
  history_from date NOT NULL,
  initialized_at timestamptz NOT NULL DEFAULT now(),
  last_scheduled_day date
);
INSERT INTO usage_rollup_state(singleton,history_from)
SELECT true, LEAST(COALESCE(min(day),(now() AT TIME ZONE 'Asia/Shanghai')::date),(now() AT TIME ZONE 'Asia/Shanghai')::date)
FROM (
  SELECT (min(queued_at) AT TIME ZONE 'Asia/Shanghai')::date AS day FROM tasks
  UNION ALL SELECT (min(occurred_at) AT TIME ZONE 'Asia/Shanghai')::date FROM usage_events
  UNION ALL SELECT (min(created_at) AT TIME ZONE 'Asia/Shanghai')::date FROM usage_chat_requests
) dates;

CREATE TABLE usage_dirty_days (
  day date PRIMARY KEY,
  dirty_at timestamptz NOT NULL DEFAULT now(),
  ready_after timestamptz NOT NULL DEFAULT now(),
  failure_code text,
  failed_at timestamptz
);
INSERT INTO usage_dirty_days(day)
SELECT day::date FROM usage_rollup_state,
  LATERAL generate_series(history_from::timestamp,(now() AT TIME ZONE 'Asia/Shanghai')::date::timestamp,interval '1 day') day;

-- Business transactions only append their own key. Repeated marks in the same
-- transaction/day coalesce without taking a row lock shared by other writers.
-- Analytics workers atomically drain bounded batches into usage_dirty_days.
CREATE TABLE usage_source_invalidations (
  day date NOT NULL,
  source_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  PRIMARY KEY(day,source_xid)
);

CREATE TABLE usage_daily_snapshots (
  day date PRIMARY KEY,
  metric_version text NOT NULL,
  computed_at timestamptz NOT NULL,
  fact_count integer NOT NULL CHECK(fact_count>=0),
  fact_bytes bigint NOT NULL CHECK(fact_bytes>=0)
);
CREATE TABLE usage_daily_facts (
  day date NOT NULL,
  kind text NOT NULL CHECK(kind IN('task','event','chat')),
  fact_id text NOT NULL,
  user_id uuid NOT NULL,
  event_department_id uuid,
  board_key text,
  model_config_id uuid,
  operation_type text,
  occurred_at timestamptz NOT NULL,
  -- Contains only the bounded dashboard projection, exact duration samples and
  -- result-use evidence. Never prompts, source/result URLs or raw provider errors.
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  PRIMARY KEY(day,kind,fact_id)
);
CREATE INDEX usage_daily_facts_time_idx ON usage_daily_facts(occurred_at);
CREATE INDEX usage_daily_facts_user_time_idx ON usage_daily_facts(user_id,occurred_at);
CREATE INDEX usage_daily_facts_dimensions_idx ON usage_daily_facts(event_department_id,board_key,model_config_id,operation_type,day);
CREATE INDEX usage_dirty_days_ready_idx ON usage_dirty_days(ready_after,day);
CREATE INDEX tasks_usage_result_urls_idx ON tasks USING gin(result_urls);
CREATE INDEX history_usage_result_urls_idx ON generation_history USING gin(result_urls);
CREATE INDEX tasks_usage_compilation_idx ON tasks(prompt_compilation_id) WHERE prompt_compilation_id IS NOT NULL;

CREATE TABLE usage_rollup_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  from_day date NOT NULL,
  to_day date NOT NULL CHECK(to_day>=from_day AND to_day-from_day<31),
  actor_user_id uuid,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','completed','failed')),
  failure_code text,
  completed_days date[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE FUNCTION usage_mark_dirty_day(affected_at timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE target_day date;
BEGIN
  IF affected_at IS NULL THEN RETURN; END IF;
  target_day := (affected_at AT TIME ZONE 'Asia/Shanghai')::date;
  INSERT INTO usage_source_invalidations(day) VALUES(target_day)
    ON CONFLICT(day,source_xid) DO NOTHING;
END $$;
CREATE FUNCTION usage_mark_task_dirty(target_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM usage_mark_dirty_day(queued_at) FROM tasks WHERE id=target_id;
END $$;
CREATE FUNCTION usage_source_dirty_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; task_uuid uuid; asset_uuid uuid; compilation_key text; affected_user uuid;
BEGIN
  -- Both sides matter when a source row moves date, owner, task or result identity.
  FOR item IN SELECT value FROM jsonb_array_elements(
    CASE WHEN TG_OP='INSERT' THEN jsonb_build_array(to_jsonb(NEW))
         WHEN TG_OP='DELETE' THEN jsonb_build_array(to_jsonb(OLD))
         ELSE jsonb_build_array(to_jsonb(OLD),to_jsonb(NEW)) END)
  LOOP
    IF TG_TABLE_NAME='tasks' THEN
      PERFORM usage_mark_dirty_day((item->>'queued_at')::timestamptz);
    ELSIF TG_TABLE_NAME='usage_events' THEN
      PERFORM usage_mark_dirty_day((item->>'occurred_at')::timestamptz);
    ELSIF TG_TABLE_NAME='usage_chat_requests' THEN
      PERFORM usage_mark_dirty_day((item->>'created_at')::timestamptz);
    ELSIF TG_TABLE_NAME='generation_history' THEN
      PERFORM usage_mark_task_dirty((item->>'task_id')::uuid);
    ELSIF TG_TABLE_NAME IN('assets','asset_events') THEN
      task_uuid := (item->>'task_id')::uuid;
      asset_uuid := (item->>CASE WHEN TG_TABLE_NAME='assets' THEN 'id' ELSE 'asset_id' END)::uuid;
      PERFORM usage_mark_task_dirty(task_uuid);
      PERFORM usage_mark_task_dirty(task_id) FROM assets WHERE id=asset_uuid;
      PERFORM usage_mark_dirty_day(t.queued_at) FROM tasks t
        WHERE t.result_urls ? ('/api/assets/'||asset_uuid::text||'/content')
          OR t.id IN(SELECT h.task_id FROM generation_history h WHERE h.result_urls ? ('/api/assets/'||asset_uuid::text||'/content'));
      IF TG_TABLE_NAME='asset_events' THEN
        PERFORM usage_mark_dirty_day((item->>'occurred_at')::timestamptz);
        PERFORM usage_mark_task_dirty(e.task_id) FROM asset_events e WHERE e.id=(item->>'source_event_id')::uuid;
      END IF;
    ELSIF TG_TABLE_NAME='prompt_compilations' THEN
      compilation_key := item->>'id';
      PERFORM usage_mark_dirty_day(t.queued_at) FROM tasks t WHERE t.prompt_compilation_id=compilation_key
        OR t.prompt_compilation_id IN(SELECT id FROM prompt_compilations WHERE reused_from_id=compilation_key);
    ELSIF TG_TABLE_NAME='users' THEN
      affected_user := (item->>'id')::uuid;
      PERFORM usage_mark_dirty_day(at) FROM (
        SELECT queued_at AS at FROM tasks WHERE user_id=affected_user
        UNION SELECT occurred_at FROM usage_events WHERE user_id=affected_user
        UNION SELECT created_at FROM usage_chat_requests WHERE user_id=affected_user
      ) affected;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER usage_tasks_dirty AFTER INSERT OR DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION usage_source_dirty_trigger();
CREATE TRIGGER usage_tasks_changed AFTER UPDATE OF user_id,department_id,operation_type,model_config_id,parameters,tool_key,status,source_urls,result_urls,batch_id,queued_at,started_at,completed_at,failure_reason,attempts,prompt_optimized,prompt_compilation_id ON tasks FOR EACH ROW EXECUTE FUNCTION usage_source_dirty_trigger();
CREATE TRIGGER usage_history_dirty AFTER INSERT OR UPDATE OR DELETE ON generation_history FOR EACH ROW EXECUTE FUNCTION usage_source_dirty_trigger();
CREATE TRIGGER usage_events_dirty AFTER INSERT OR UPDATE OR DELETE ON usage_events FOR EACH ROW EXECUTE FUNCTION usage_source_dirty_trigger();
CREATE TRIGGER usage_chat_dirty AFTER INSERT OR UPDATE OR DELETE ON usage_chat_requests FOR EACH ROW EXECUTE FUNCTION usage_source_dirty_trigger();
CREATE TRIGGER usage_assets_dirty AFTER INSERT OR DELETE ON assets FOR EACH ROW EXECUTE FUNCTION usage_source_dirty_trigger();
CREATE TRIGGER usage_assets_changed AFTER UPDATE OF task_id,owner_user_id,kind,mime_type,metadata ON assets FOR EACH ROW EXECUTE FUNCTION usage_source_dirty_trigger();
CREATE TRIGGER usage_asset_events_dirty AFTER INSERT OR UPDATE OR DELETE ON asset_events FOR EACH ROW EXECUTE FUNCTION usage_source_dirty_trigger();
CREATE TRIGGER usage_compilations_dirty AFTER INSERT OR UPDATE OR DELETE ON prompt_compilations FOR EACH ROW EXECUTE FUNCTION usage_source_dirty_trigger();
CREATE TRIGGER usage_users_guest_dirty AFTER UPDATE OF is_guest ON users FOR EACH ROW WHEN(OLD.is_guest IS DISTINCT FROM NEW.is_guest) EXECUTE FUNCTION usage_source_dirty_trigger();
