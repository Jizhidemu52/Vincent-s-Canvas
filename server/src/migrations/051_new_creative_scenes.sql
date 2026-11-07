-- Add only the requested try-on and sketch-realization boards. Product extraction
-- is the separately managed quick-image action, not a third creative recipe.
ALTER TABLE tool_api_configurations DROP CONSTRAINT tool_api_configurations_tool_key_check;
ALTER TABLE tool_api_configurations ADD CONSTRAINT tool_api_configurations_tool_key_check CHECK (tool_key IN (
  'image','detail-enhance','image-edit','angle-control','seamless-stitch','midjourney-blend','video',
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
  'image','detail-enhance','image-edit','angle-control','seamless-stitch','midjourney-blend','video',
  'creative-text-to-style','creative-style-to-sketch','creative-local-restyle','creative-garment-colorway',
  'creative-back-design','creative-pattern-extract','creative-pattern-colorway','creative-accessory-design','creative-pattern-craft',
  'creative-virtual-try-on','creative-sketch-to-photo',
  'canvas-image','canvas-edit','canvas-mask-edit','canvas-angle','canvas-batch','canvas-chat','canvas-video','canvas-audio',
  'gpt-chat','gpt-chat-image','series-recipe'
));
INSERT INTO module_flags(module_key,enabled)
VALUES ('creative-virtual-try-on',true),('creative-sketch-to-photo',true)
ON CONFLICT(module_key) DO NOTHING;
INSERT INTO tool_api_configurations(tool_key,model_config_id,enabled)
SELECT key, (SELECT m.id FROM model_configs m JOIN providers p ON p.id=m.provider_id
  WHERE m.provider_id='9567f5da-bb4d-4e4b-b680-c7184d00a001'::uuid
    AND m.model_id='gpt-image-2.6-flare' AND m.enabled=true AND p.enabled=true
    AND p.protocol='apimart' AND 'edit'=ANY(m.capabilities) AND m.workflow_config_id IS NULL LIMIT 1), true
FROM unnest(ARRAY['creative-virtual-try-on','creative-sketch-to-photo']) AS key
ON CONFLICT(tool_key) DO NOTHING;
