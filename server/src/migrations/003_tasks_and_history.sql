CREATE TABLE IF NOT EXISTS batch_tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id text NOT NULL UNIQUE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    department_id uuid REFERENCES departments(id) ON DELETE RESTRICT,
    project_id text NOT NULL,
    operation_type text NOT NULL,
    model_config_id uuid REFERENCES model_configs(id) ON DELETE RESTRICT,
    prompt text NOT NULL DEFAULT '',
    priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','priority','urgent')),
    status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','processing','success','partial','failed','paused','cancelled')),
    total_items integer NOT NULL CHECK (total_items > 0),
    completed_items integer NOT NULL DEFAULT 0,
    failed_items integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id text NOT NULL UNIQUE,
    batch_id uuid REFERENCES batch_tasks(id) ON DELETE RESTRICT,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    department_id uuid REFERENCES departments(id) ON DELETE RESTRICT,
    project_id text NOT NULL,
    operation_type text NOT NULL,
    model_config_id uuid REFERENCES model_configs(id) ON DELETE RESTRICT,
    prompt text NOT NULL DEFAULT '',
    source_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
    result_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
    priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','priority','urgent')),
    status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','processing','success','failed','paused','cancelled')),
    credits integer NOT NULL DEFAULT 0,
    rmb_cost numeric(12,4) NOT NULL DEFAULT 0,
    failure_reason text,
    attempts integer NOT NULL DEFAULT 0,
    queued_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tasks_user_time_idx ON tasks(user_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS tasks_batch_idx ON tasks(batch_id, queued_at);
CREATE INDEX IF NOT EXISTS tasks_status_priority_idx ON tasks(status, priority, queued_at);

CREATE TABLE IF NOT EXISTS generation_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    department_id uuid REFERENCES departments(id) ON DELETE RESTRICT,
    project_id text NOT NULL,
    operation_type text NOT NULL,
    model_config_id uuid REFERENCES model_configs(id) ON DELETE RESTRICT,
    prompt text NOT NULL,
    source_urls jsonb NOT NULL,
    result_urls jsonb NOT NULL,
    credits integer NOT NULL,
    rmb_cost numeric(12,4) NOT NULL,
    status text NOT NULL CHECK (status IN ('success','failed')),
    failure_reason text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS history_user_time_idx ON generation_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS history_department_time_idx ON generation_history(department_id, created_at DESC);
