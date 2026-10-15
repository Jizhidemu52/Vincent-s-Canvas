-- Formal catalog: independently scoped bindings and per-call TOTAL price overrides.
ALTER TABLE tool_api_configurations DROP CONSTRAINT IF EXISTS tool_api_configurations_tool_key_check;
ALTER TABLE tool_api_configurations ADD CONSTRAINT tool_api_configurations_tool_key_check CHECK (tool_key IN (
  'image','detail-enhance','image-edit','angle-control','seamless-stitch','video',
  'creative-text-to-style','creative-style-to-sketch','creative-local-restyle','creative-garment-colorway',
  'creative-back-design','creative-pattern-extract','creative-pattern-colorway','creative-accessory-design','creative-pattern-craft',
  'canvas-image','canvas-edit','canvas-mask-edit','canvas-angle','canvas-batch','canvas-chat','canvas-video','canvas-audio',
  'gpt-chat','gpt-chat-image','series-recipe'
));
ALTER TABLE tool_api_configurations ALTER COLUMN model_config_id DROP NOT NULL;
ALTER TABLE tool_api_configurations ADD COLUMN credit_cost_override integer CHECK (credit_cost_override >= 0);
ALTER TABLE tool_api_configurations ADD COLUMN rmb_cost_override numeric(12,4) CHECK (rmb_cost_override >= 0);
ALTER TABLE tool_api_configurations ADD COLUMN configuration_version integer NOT NULL DEFAULT 1 CHECK (configuration_version > 0);

ALTER TABLE module_flags DROP CONSTRAINT IF EXISTS module_flags_module_key_check;
ALTER TABLE module_flags ADD CONSTRAINT module_flags_module_key_check CHECK (module_key IN (
  'creative','canvas','standard-colors','photo-color-picker','pattern-recolor','svg-trace','creative-selection',
  'canvas-local-tools','canvas-local-agent','assets','prompts','reference-import','design-library','team','performance','pattern-placement','pattern-repeat',
  'image','detail-enhance','image-edit','angle-control','seamless-stitch','video',
  'creative-text-to-style','creative-style-to-sketch','creative-local-restyle','creative-garment-colorway',
  'creative-back-design','creative-pattern-extract','creative-pattern-colorway','creative-accessory-design','creative-pattern-craft',
  'canvas-image','canvas-edit','canvas-mask-edit','canvas-angle','canvas-batch','canvas-chat','canvas-video','canvas-audio',
  'gpt-chat','gpt-chat-image','series-recipe'
));
INSERT INTO module_flags(module_key,enabled)
SELECT key,true FROM unnest(ARRAY[
  'creative','canvas','standard-colors','photo-color-picker','pattern-recolor','svg-trace','creative-selection',
  'canvas-local-tools','canvas-local-agent','assets','prompts','reference-import','design-library','team','performance','pattern-placement','pattern-repeat',
  'image','detail-enhance','image-edit','angle-control','seamless-stitch','video',
  'creative-text-to-style','creative-style-to-sketch','creative-local-restyle','creative-garment-colorway',
  'creative-back-design','creative-pattern-extract','creative-pattern-colorway','creative-accessory-design','creative-pattern-craft',
  'canvas-image','canvas-edit','canvas-mask-edit','canvas-angle','canvas-batch','canvas-chat','canvas-video','canvas-audio',
  'gpt-chat','gpt-chat-image','series-recipe'
]) AS key ON CONFLICT(module_key) DO NOTHING;
INSERT INTO tool_api_configurations(tool_key,model_config_id,enabled)
SELECT key,NULL,true FROM unnest(ARRAY[
  'image','detail-enhance','image-edit','angle-control','seamless-stitch','video',
  'creative-text-to-style','creative-style-to-sketch','creative-local-restyle','creative-garment-colorway',
  'creative-back-design','creative-pattern-extract','creative-pattern-colorway','creative-accessory-design','creative-pattern-craft',
  'canvas-image','canvas-edit','canvas-mask-edit','canvas-angle','canvas-batch','canvas-chat','canvas-video','canvas-audio',
  'gpt-chat','gpt-chat-image','series-recipe'
]) AS key ON CONFLICT(tool_key) DO NOTHING;

ALTER TABLE tasks ADD COLUMN tool_key text REFERENCES tool_api_configurations(tool_key);
ALTER TABLE batch_tasks ADD COLUMN tool_key text REFERENCES tool_api_configurations(tool_key);
-- Reservation price_snapshot includes toolKey, configurationVersion and nullable overrides.
-- Chat remains unbilled; this migration does not alter pricing_rule_versions or model_configs.
