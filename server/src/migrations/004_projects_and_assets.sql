CREATE TABLE IF NOT EXISTS projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id text UNIQUE,
    name text NOT NULL,
    owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    department_id uuid REFERENCES departments(id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_members (
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','editor','member')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(project_id,user_id)
);

CREATE TABLE IF NOT EXISTS assets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    department_id uuid REFERENCES departments(id) ON DELETE RESTRICT,
    project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
    project_external_id text,
    task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
    object_key text NOT NULL UNIQUE,
    filename text NOT NULL,
    mime_type text NOT NULL,
    byte_size bigint NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
    kind text NOT NULL DEFAULT 'image' CHECK (kind IN ('image','video','text','other')),
    source text NOT NULL DEFAULT 'upload' CHECK (source IN ('upload','generation','edit','import')),
    operation_type text,
    prompt text,
    model_config_id uuid REFERENCES model_configs(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','failed')),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    deleted_at timestamptz,
    purge_after timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assets_owner_time_idx ON assets(owner_user_id,created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS assets_department_time_idx ON assets(department_id,created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS assets_project_time_idx ON assets(project_id,created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS assets_external_project_time_idx ON assets(project_external_id,created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS asset_shares (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    scope text NOT NULL CHECK (scope IN ('department','project','user')),
    department_id uuid REFERENCES departments(id) ON DELETE CASCADE,
    project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
    user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((department_id IS NOT NULL)::integer + (project_id IS NOT NULL)::integer + (user_id IS NOT NULL)::integer = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS asset_share_department_unique ON asset_shares(asset_id,department_id) WHERE department_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS asset_share_project_unique ON asset_shares(asset_id,project_id) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS asset_share_user_unique ON asset_shares(asset_id,user_id) WHERE user_id IS NOT NULL;
