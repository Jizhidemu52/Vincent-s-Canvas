-- Add the independent Blend board without changing any existing module or tool binding.
ALTER TABLE tool_api_configurations DROP CONSTRAINT IF EXISTS tool_api_configurations_tool_key_check;
ALTER TABLE tool_api_configurations ADD CONSTRAINT tool_api_configurations_tool_key_check CHECK (tool_key IN (
  'image','detail-enhance','image-edit','angle-control','seamless-stitch','midjourney-blend','video',
  'creative-text-to-style','creative-style-to-sketch','creative-local-restyle','creative-garment-colorway',
  'creative-back-design','creative-pattern-extract','creative-pattern-colorway','creative-accessory-design','creative-pattern-craft',
  'canvas-image','canvas-edit','canvas-mask-edit','canvas-angle','canvas-batch','canvas-chat','canvas-video','canvas-audio',
  'gpt-chat','gpt-chat-image','series-recipe'
));
ALTER TABLE module_flags DROP CONSTRAINT IF EXISTS module_flags_module_key_check;
ALTER TABLE module_flags ADD CONSTRAINT module_flags_module_key_check CHECK (module_key IN (
  'creative','canvas','standard-colors','photo-color-picker','pattern-recolor','svg-trace','creative-selection',
  'canvas-local-tools','canvas-local-agent','assets','prompts','reference-import','design-library','team','performance','pattern-placement','pattern-repeat',
  'image','detail-enhance','image-edit','angle-control','seamless-stitch','midjourney-blend','video',
  'creative-text-to-style','creative-style-to-sketch','creative-local-restyle','creative-garment-colorway',
  'creative-back-design','creative-pattern-extract','creative-pattern-colorway','creative-accessory-design','creative-pattern-craft',
  'canvas-image','canvas-edit','canvas-mask-edit','canvas-angle','canvas-batch','canvas-chat','canvas-video','canvas-audio',
  'gpt-chat','gpt-chat-image','series-recipe'
));
INSERT INTO module_flags(module_key,enabled)
VALUES('midjourney-blend',true) ON CONFLICT(module_key) DO NOTHING;
INSERT INTO tool_api_configurations(tool_key,model_config_id,enabled)
VALUES('midjourney-blend',NULL,true) ON CONFLICT(tool_key) DO NOTHING;

-- The fixed APIMart preset fuses images; it does not support prompt-based editing.
UPDATE model_configs SET capabilities=ARRAY['generate']::text[],updated_at=now()
WHERE provider_id='9567f5da-bb4d-4e4b-b680-c7184d00a001'::uuid AND model_id='midjourney-blend'
  AND capabilities IS DISTINCT FROM ARRAY['generate']::text[];
