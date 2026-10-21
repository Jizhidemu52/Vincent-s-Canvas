-- Register the additional creative tools without changing existing bindings or prices.
ALTER TABLE tool_api_configurations DROP CONSTRAINT IF EXISTS tool_api_configurations_tool_key_check;
ALTER TABLE tool_api_configurations ADD CONSTRAINT tool_api_configurations_tool_key_check CHECK (tool_key IN (
  'image','detail-enhance','image-edit','angle-control','seamless-stitch','midjourney-blend','video',
  'creative-text-to-style','creative-style-to-sketch','creative-local-restyle','creative-garment-colorway',
  'creative-back-design','creative-pattern-extract','creative-pattern-colorway','creative-accessory-design','creative-pattern-craft',
  'creative-series-extension','creative-bestseller-proposal','creative-detail-to-style','creative-fabric-to-style',
  'creative-reference-to-style','creative-style-fusion','creative-outfit-design','creative-apply-pattern',
  'creative-pattern-fill','creative-fabric-change','creative-remove-decoration','creative-sketch-to-style',
  'creative-pattern-create','creative-pattern-fusion','creative-seamless-pattern','creative-pattern-layers',
  'canvas-image','canvas-edit','canvas-mask-edit','canvas-angle','canvas-batch','canvas-chat','canvas-video','canvas-audio',
  'gpt-chat','gpt-chat-image','series-recipe'
));
ALTER TABLE module_flags DROP CONSTRAINT IF EXISTS module_flags_module_key_check;
ALTER TABLE module_flags ADD CONSTRAINT module_flags_module_key_check CHECK (module_key IN (
  'creative','canvas','standard-colors','photo-color-picker','pattern-recolor','svg-trace','creative-selection',
  'creative-sketch-vectorization','creative-pattern-vectorization',
  'canvas-local-tools','canvas-local-agent','assets','prompts','reference-import','design-library','team','performance','pattern-placement','pattern-repeat',
  'image','detail-enhance','image-edit','angle-control','seamless-stitch','midjourney-blend','video',
  'creative-text-to-style','creative-style-to-sketch','creative-local-restyle','creative-garment-colorway',
  'creative-back-design','creative-pattern-extract','creative-pattern-colorway','creative-accessory-design','creative-pattern-craft',
  'creative-series-extension','creative-bestseller-proposal','creative-detail-to-style','creative-fabric-to-style',
  'creative-reference-to-style','creative-style-fusion','creative-outfit-design','creative-apply-pattern',
  'creative-pattern-fill','creative-fabric-change','creative-remove-decoration','creative-sketch-to-style',
  'creative-pattern-create','creative-pattern-fusion','creative-seamless-pattern','creative-pattern-layers',
  'canvas-image','canvas-edit','canvas-mask-edit','canvas-angle','canvas-batch','canvas-chat','canvas-video','canvas-audio',
  'gpt-chat','gpt-chat-image','series-recipe'
));
INSERT INTO module_flags(module_key,enabled) VALUES
  ('creative-series-extension',true),('creative-bestseller-proposal',true),('creative-detail-to-style',true),('creative-fabric-to-style',true),
  ('creative-reference-to-style',true),('creative-style-fusion',true),('creative-outfit-design',true),('creative-apply-pattern',true),
  ('creative-pattern-fill',true),('creative-fabric-change',true),('creative-remove-decoration',true),('creative-sketch-to-style',true),
  ('creative-pattern-create',true),('creative-pattern-fusion',true),('creative-seamless-pattern',true),('creative-pattern-layers',true),
  ('creative-sketch-vectorization',true),('creative-pattern-vectorization',true)
ON CONFLICT(module_key) DO NOTHING;
INSERT INTO tool_api_configurations(tool_key,model_config_id,enabled) VALUES
  ('creative-series-extension',NULL,true),('creative-bestseller-proposal',NULL,true),('creative-detail-to-style',NULL,true),('creative-fabric-to-style',NULL,true),
  ('creative-reference-to-style',NULL,true),('creative-style-fusion',NULL,true),('creative-outfit-design',NULL,true),('creative-apply-pattern',NULL,true),
  ('creative-pattern-fill',NULL,true),('creative-fabric-change',NULL,true),('creative-remove-decoration',NULL,true),('creative-sketch-to-style',NULL,true),
  ('creative-pattern-create',NULL,true),('creative-pattern-fusion',NULL,true),('creative-seamless-pattern',NULL,true),('creative-pattern-layers',NULL,true)
ON CONFLICT(tool_key) DO NOTHING;
