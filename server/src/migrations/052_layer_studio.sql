-- Dedicated layer workspace. Existing bindings, business rows and cost policy stay unchanged.
ALTER TABLE tool_api_configurations DROP CONSTRAINT tool_api_configurations_tool_key_check;
ALTER TABLE tool_api_configurations ADD CONSTRAINT tool_api_configurations_tool_key_check CHECK (tool_key IN (
  'image','detail-enhance','image-edit','angle-control','seamless-stitch','midjourney-blend','video','layer-studio',
  'creative-text-to-style','creative-style-to-sketch','creative-local-restyle','creative-garment-colorway',
  'creative-back-design','creative-pattern-extract','creative-pattern-colorway','creative-accessory-design','creative-pattern-craft',
  'creative-virtual-try-on','creative-sketch-to-photo',
  'canvas-image','canvas-edit','canvas-mask-edit','canvas-angle','canvas-batch','canvas-chat','canvas-video','canvas-audio',
  'gpt-chat','gpt-chat-image','series-recipe'
));
ALTER TABLE module_flags DROP CONSTRAINT module_flags_module_key_check;
ALTER TABLE module_flags ADD CONSTRAINT module_flags_module_key_check CHECK (module_key IN (
  'creative','canvas','standard-colors','photo-color-picker','pattern-recolor','svg-trace','creative-selection',
  'canvas-local-tools','canvas-local-agent','assets','prompts','reference-import','design-library','team','performance','pattern-placement','pattern-repeat',
  'image','detail-enhance','image-edit','angle-control','seamless-stitch','midjourney-blend','video','layer-studio',
  'creative-text-to-style','creative-style-to-sketch','creative-local-restyle','creative-garment-colorway',
  'creative-back-design','creative-pattern-extract','creative-pattern-colorway','creative-accessory-design','creative-pattern-craft',
  'creative-virtual-try-on','creative-sketch-to-photo',
  'canvas-image','canvas-edit','canvas-mask-edit','canvas-angle','canvas-batch','canvas-chat','canvas-video','canvas-audio',
  'gpt-chat','gpt-chat-image','series-recipe'
));
INSERT INTO module_flags(module_key,enabled) VALUES('layer-studio',false) ON CONFLICT(module_key) DO NOTHING;
INSERT INTO tool_api_configurations(tool_key,model_config_id,enabled)
VALUES('layer-studio',NULL,false) ON CONFLICT(tool_key) DO NOTHING;

ALTER TABLE tasks ADD COLUMN result_document jsonb CHECK (result_document IS NULL OR jsonb_typeof(result_document)='object');
ALTER TABLE tasks ADD COLUMN upstream_result_document jsonb CHECK (upstream_result_document IS NULL OR jsonb_typeof(upstream_result_document)='object');

-- Explicit account/channel rates in CNY. Never infer a missing reference-image price as zero.
CREATE TABLE layer_studio_prices (
  model_config_id uuid PRIMARY KEY REFERENCES model_configs(id),
  input_rmb numeric(12,6) NOT NULL CHECK(input_rmb >= 0 AND input_rmb <= 1000),
  low_output_rmb numeric(12,6) NOT NULL CHECK(low_output_rmb > 0 AND low_output_rmb <= 1000),
  high_output_rmb numeric(12,6) NOT NULL CHECK(high_output_rmb >= low_output_rmb AND high_output_rmb <= 1000),
  source_note text NOT NULL CHECK(length(source_note) BETWEEN 1 AND 500),
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
