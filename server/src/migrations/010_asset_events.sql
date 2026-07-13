ALTER TABLE assets
    ADD COLUMN IF NOT EXISTS visibility_scope text NOT NULL DEFAULT 'private';

ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_visibility_scope_check;
ALTER TABLE assets ADD CONSTRAINT assets_visibility_scope_check
    CHECK (visibility_scope IN ('private','company'));

CREATE TABLE IF NOT EXISTS asset_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sequence_no bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
    designer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
    department_id uuid REFERENCES departments(id) ON DELETE RESTRICT,
    group_id uuid,
    project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
    project_external_id text,
    task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
    model_config_id uuid REFERENCES model_configs(id) ON DELETE SET NULL,
    event_type text NOT NULL CHECK (event_type IN (
        'asset.generated','asset.candidate_added','asset.project_added',
        'asset.edited','asset.reused','asset.downloaded','asset.exported',
        'asset.adopted','asset.delivered','asset.pending','asset.rejected',
        'asset.event_reversed'
    )),
    prompt text NOT NULL DEFAULT '',
    credits integer NOT NULL DEFAULT 0 CHECK (credits >= 0),
    rmb_cost numeric(12,4) NOT NULL DEFAULT 0 CHECK (rmb_cost >= 0),
    first_effective boolean NOT NULL DEFAULT false,
    idempotency_key text NOT NULL UNIQUE,
    source_event_id uuid REFERENCES asset_events(id) ON DELETE RESTRICT,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (event_type = 'asset.event_reversed' AND source_event_id IS NOT NULL)
        OR (event_type <> 'asset.event_reversed' AND source_event_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS asset_events_asset_time_idx
    ON asset_events(asset_id, sequence_no);
CREATE INDEX IF NOT EXISTS asset_events_designer_time_idx
    ON asset_events(designer_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS asset_events_department_time_idx
    ON asset_events(department_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS asset_events_task_idx
    ON asset_events(task_id) WHERE task_id IS NOT NULL;

INSERT INTO asset_events(
    asset_id, designer_user_id, actor_user_id, department_id, project_id,
    project_external_id, task_id, model_config_id, event_type, prompt,
    credits, rmb_cost, first_effective, idempotency_key, metadata, occurred_at
)
SELECT
    a.id, a.owner_user_id, NULL, a.department_id, a.project_id,
    a.project_external_id, a.task_id, a.model_config_id, 'asset.generated',
    COALESCE(a.prompt, ''), COALESCE(t.credits, 0), COALESCE(t.rmb_cost, 0),
    true, 'migration:asset.generated:' || a.id::text,
    jsonb_build_object('source', 'migration-010'), a.created_at
FROM assets a
LEFT JOIN tasks t ON t.id = a.task_id
WHERE a.status = 'ready'
  AND a.deleted_at IS NULL
  AND a.source IN ('generation','edit')
ON CONFLICT(idempotency_key) DO NOTHING;
