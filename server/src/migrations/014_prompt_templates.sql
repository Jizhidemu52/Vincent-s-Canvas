ALTER TABLE model_configs
    ADD COLUMN IF NOT EXISTS replacement_model_config_id uuid REFERENCES model_configs(id) ON DELETE SET NULL;

ALTER TABLE model_configs DROP CONSTRAINT IF EXISTS model_replacement_not_self;
ALTER TABLE model_configs
    ADD CONSTRAINT model_replacement_not_self
    CHECK (replacement_model_config_id IS NULL OR replacement_model_config_id <> id);

CREATE TABLE IF NOT EXISTS prompt_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scope text NOT NULL CHECK (scope IN ('personal','team','public')),
    owner_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
    group_id uuid REFERENCES designer_groups(id) ON DELETE RESTRICT,
    department_id uuid REFERENCES departments(id) ON DELETE RESTRICT,
    source_template_id uuid REFERENCES prompt_templates(id) ON DELETE RESTRICT,
    current_version_id uuid,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CHECK (
        (scope='personal' AND owner_user_id IS NOT NULL AND group_id IS NULL)
        OR (scope='team' AND owner_user_id IS NULL AND group_id IS NOT NULL AND department_id IS NOT NULL)
        OR (scope='public' AND owner_user_id IS NULL AND group_id IS NULL)
    )
);

CREATE TABLE IF NOT EXISTS prompt_template_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id uuid NOT NULL REFERENCES prompt_templates(id) ON DELETE RESTRICT,
    version integer NOT NULL CHECK (version > 0),
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
    prompt text NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 20000),
    target_tool text NOT NULL CHECK (target_tool IN ('image-generation','detail-enhance','image-edit','angle-control','batch-edit','seamless-stitch','video','canvas')),
    model_config_id uuid REFERENCES model_configs(id) ON DELETE SET NULL,
    model_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
    category text NOT NULL DEFAULT '' CHECK (char_length(category) <= 80),
    tags text[] NOT NULL DEFAULT '{}',
    notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 2000),
    source_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
    source_asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(template_id,version),
    CHECK (cardinality(tags) <= 20)
);

ALTER TABLE prompt_templates DROP CONSTRAINT IF EXISTS prompt_templates_current_version_fk;
ALTER TABLE prompt_templates
    ADD CONSTRAINT prompt_templates_current_version_fk
    FOREIGN KEY(current_version_id) REFERENCES prompt_template_versions(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS prompt_template_reference_assets (
    version_id uuid NOT NULL REFERENCES prompt_template_versions(id) ON DELETE RESTRICT,
    asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
    position smallint NOT NULL CHECK (position >= 0 AND position < 20),
    PRIMARY KEY(version_id,asset_id),
    UNIQUE(version_id,position)
);

CREATE TABLE IF NOT EXISTS prompt_template_submissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 8 AND 160),
    source_template_id uuid NOT NULL REFERENCES prompt_templates(id) ON DELETE RESTRICT,
    source_version_id uuid NOT NULL REFERENCES prompt_template_versions(id) ON DELETE RESTRICT,
    submitted_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    target_group_id uuid NOT NULL REFERENCES designer_groups(id) ON DELETE RESTRICT,
    target_department_id uuid NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn')),
    reviewer_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
    review_note text NOT NULL DEFAULT '' CHECK (char_length(review_note) <= 1000),
    reviewed_at timestamptz,
    published_template_id uuid REFERENCES prompt_templates(id) ON DELETE RESTRICT,
    published_version_id uuid REFERENCES prompt_template_versions(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(submitted_by,request_id),
    CHECK ((status='pending' AND reviewer_user_id IS NULL AND reviewed_at IS NULL)
        OR (status<>'pending' AND reviewer_user_id IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS prompt_template_user_stats (
    template_id uuid NOT NULL REFERENCES prompt_templates(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    favorite boolean NOT NULL DEFAULT false,
    use_count integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),
    last_used_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(template_id,user_id)
);

CREATE TABLE IF NOT EXISTS prompt_template_usage_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 8 AND 160),
    template_id uuid NOT NULL REFERENCES prompt_templates(id) ON DELETE RESTRICT,
    version_id uuid NOT NULL REFERENCES prompt_template_versions(id) ON DELETE RESTRICT,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    mode text NOT NULL CHECK (mode IN ('fill','fill_and_generate')),
    resolved_model_config_id uuid REFERENCES model_configs(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id,request_id)
);

CREATE TABLE IF NOT EXISTS prompt_reuse_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash text NOT NULL UNIQUE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    template_id uuid NOT NULL REFERENCES prompt_templates(id) ON DELETE RESTRICT,
    version_id uuid NOT NULL REFERENCES prompt_template_versions(id) ON DELETE RESTRICT,
    mode text NOT NULL CHECK (mode IN ('fill','fill_and_generate')),
    resolved_model_config_id uuid REFERENCES model_configs(id) ON DELETE SET NULL,
    resolution jsonb NOT NULL DEFAULT '{}'::jsonb,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prompt_templates_owner_time_idx ON prompt_templates(owner_user_id,updated_at DESC) WHERE scope='personal' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS prompt_templates_group_time_idx ON prompt_templates(group_id,updated_at DESC) WHERE scope='team' AND status='active' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS prompt_templates_public_time_idx ON prompt_templates(updated_at DESC) WHERE scope='public' AND status='active' AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_team_template_per_source ON prompt_templates(source_template_id,group_id) WHERE scope='team' AND status='active' AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_public_template_per_source ON prompt_templates(source_template_id) WHERE scope='public' AND status='active' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS prompt_submissions_group_status_idx ON prompt_template_submissions(target_group_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS prompt_reuse_tokens_expiry_idx ON prompt_reuse_tokens(user_id,expires_at DESC);

CREATE OR REPLACE FUNCTION reject_prompt_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'prompt_template_versions are immutable';
END $$;

DROP TRIGGER IF EXISTS prompt_versions_no_update ON prompt_template_versions;
CREATE TRIGGER prompt_versions_no_update BEFORE UPDATE OR DELETE ON prompt_template_versions
FOR EACH ROW EXECUTE FUNCTION reject_prompt_version_mutation();

