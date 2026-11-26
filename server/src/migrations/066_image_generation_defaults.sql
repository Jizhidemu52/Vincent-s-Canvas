CREATE TABLE IF NOT EXISTS image_generation_defaults (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  default_model_config_id uuid REFERENCES model_configs(id) ON DELETE SET NULL,
  model_options jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(model_options) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
