-- Administrator-only quick-image settings. No seed rows: absent settings use
-- the server defaults, without changing ordinary image/edit model bindings.
CREATE TABLE quick_image_configurations (
  action text PRIMARY KEY CHECK (action IN ('remove-background', 'hd-upscale')),
  model_config_id uuid NOT NULL REFERENCES model_configs(id),
  prompt text NOT NULL CHECK (char_length(btrim(prompt)) BETWEEN 1 AND 4000),
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(parameters) = 'object' AND char_length(parameters::text) <= 8000
  ),
  configuration_version integer NOT NULL DEFAULT 1 CHECK (configuration_version > 0),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
