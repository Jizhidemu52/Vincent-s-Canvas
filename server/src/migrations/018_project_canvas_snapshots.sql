CREATE TABLE IF NOT EXISTS project_canvas_snapshots (
    project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
    snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_canvas_snapshots_owner_updated_idx
    ON project_canvas_snapshots(owner_user_id, updated_at DESC);
