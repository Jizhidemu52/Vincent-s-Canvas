CREATE TABLE IF NOT EXISTS tool_api_configurations (
    tool_key text PRIMARY KEY CHECK (tool_key IN (
        'detail-enhance', 'image-edit', 'angle-control',
        'seamless-stitch', 'image', 'video'
    )),
    model_config_id uuid NOT NULL REFERENCES model_configs(id) ON DELETE RESTRICT,
    enabled boolean NOT NULL DEFAULT true,
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tool_api_configurations_model_idx
    ON tool_api_configurations(model_config_id);
