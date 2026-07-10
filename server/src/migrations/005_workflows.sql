CREATE TABLE IF NOT EXISTS workflow_configs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id uuid NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
    name text NOT NULL,
    protocol text NOT NULL CHECK (protocol IN ('runninghub','comfyui','custom')),
    capability text NOT NULL CHECK (capability IN ('generate','edit','upscale','batch')),
    workflow_id text,
    submit_path text NOT NULL,
    status_path text,
    cancel_path text,
    request_template jsonb NOT NULL DEFAULT '{}'::jsonb,
    external_task_path text,
    status_value_path text,
    success_values text[] NOT NULL DEFAULT ARRAY['success','succeeded','completed'],
    failure_values text[] NOT NULL DEFAULT ARRAY['failed','error','cancelled'],
    output_path text NOT NULL,
    poll_interval_ms integer NOT NULL DEFAULT 2000 CHECK (poll_interval_ms BETWEEN 500 AND 60000),
    timeout_seconds integer NOT NULL DEFAULT 600 CHECK (timeout_seconds BETWEEN 30 AND 7200),
    enabled boolean NOT NULL DEFAULT true,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(provider_id,name)
);

ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS workflow_config_id uuid REFERENCES workflow_configs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS model_workflow_idx ON model_configs(workflow_config_id) WHERE workflow_config_id IS NOT NULL;
