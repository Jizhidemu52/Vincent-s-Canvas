DO $$ BEGIN
    CREATE TYPE designer_group_status AS ENUM ('active', 'disabled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE group_member_role AS ENUM ('member', 'leader');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS designer_groups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id uuid NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
    name text NOT NULL,
    code citext NOT NULL,
    status designer_group_status NOT NULL DEFAULT 'active',
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(department_id, name),
    UNIQUE(department_id, code)
);

CREATE TABLE IF NOT EXISTS group_memberships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id uuid NOT NULL REFERENCES designer_groups(id) ON DELETE RESTRICT,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    member_role group_member_role NOT NULL DEFAULT 'member',
    effective_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    ended_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (ended_at IS NULL OR ended_at >= effective_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS group_memberships_one_active_group_idx
    ON group_memberships(user_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS group_memberships_one_active_leader_idx
    ON group_memberships(group_id) WHERE ended_at IS NULL AND member_role='leader';
CREATE INDEX IF NOT EXISTS group_memberships_group_period_idx
    ON group_memberships(group_id, effective_at, ended_at);
CREATE INDEX IF NOT EXISTS group_memberships_user_period_idx
    ON group_memberships(user_id, effective_at, ended_at);

ALTER TABLE asset_events
    ADD CONSTRAINT asset_events_group_id_fkey
    FOREIGN KEY (group_id) REFERENCES designer_groups(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS asset_events_group_time_idx
    ON asset_events(group_id, occurred_at DESC) WHERE group_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS module_flags (
    module_key text PRIMARY KEY,
    enabled boolean NOT NULL DEFAULT true,
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO module_flags(module_key,enabled) VALUES
    ('detail-enhance',true),('image-edit',true),('angle-control',true),
    ('seamless-stitch',true),('image',true),('video',true),
    ('prompts',true),('assets',true),('gpt-chat',true),('canvas',true),('team',true)
ON CONFLICT(module_key) DO NOTHING;
