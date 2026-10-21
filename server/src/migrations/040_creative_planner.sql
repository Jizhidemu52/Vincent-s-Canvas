-- Add the creative LLM planning entry; its model is resolved from gpt-chat at runtime.
-- Existing bindings, switches, prices and shared LLM selection remain unchanged.
ALTER TABLE tool_api_configurations DROP CONSTRAINT IF EXISTS tool_api_configurations_tool_key_check;
ALTER TABLE tool_api_configurations ADD CONSTRAINT tool_api_configurations_tool_key_check CHECK (tool_key IN (
  'image','detail-enhance','image-edit','angle-control','seamless-stitch','midjourney-blend','video','creative-planner',
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
  'image','detail-enhance','image-edit','angle-control','seamless-stitch','midjourney-blend','video','creative-planner',
  'creative-text-to-style','creative-style-to-sketch','creative-local-restyle','creative-garment-colorway',
  'creative-back-design','creative-pattern-extract','creative-pattern-colorway','creative-accessory-design','creative-pattern-craft',
  'creative-series-extension','creative-bestseller-proposal','creative-detail-to-style','creative-fabric-to-style',
  'creative-reference-to-style','creative-style-fusion','creative-outfit-design','creative-apply-pattern',
  'creative-pattern-fill','creative-fabric-change','creative-remove-decoration','creative-sketch-to-style',
  'creative-pattern-create','creative-pattern-fusion','creative-seamless-pattern','creative-pattern-layers',
  'canvas-image','canvas-edit','canvas-mask-edit','canvas-angle','canvas-batch','canvas-chat','canvas-video','canvas-audio',
  'gpt-chat','gpt-chat-image','series-recipe'
));
INSERT INTO module_flags(module_key,enabled) VALUES ('creative-planner',true)
ON CONFLICT(module_key) DO NOTHING;
INSERT INTO tool_api_configurations(tool_key,model_config_id,enabled) VALUES ('creative-planner',NULL,true)
ON CONFLICT(tool_key) DO NOTHING;
