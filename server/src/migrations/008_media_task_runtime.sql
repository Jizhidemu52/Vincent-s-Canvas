ALTER TABLE pricing_rule_versions DROP CONSTRAINT IF EXISTS pricing_rule_versions_operation_type_check;
ALTER TABLE pricing_rule_versions ADD CONSTRAINT pricing_rule_versions_operation_type_check
    CHECK (operation_type IN ('image_generation','video_generation','audio_generation','upscale','remove_background','inpaint','batch_image','seamless_stitch'));

INSERT INTO pricing_rule_versions(operation_type,label,credits,rmb_cost,version,status,published_at)
VALUES('audio_generation','生成音频',10,0.5,1,'published',now())
ON CONFLICT(operation_type,version) DO NOTHING;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parameters jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE generation_history ADD COLUMN IF NOT EXISTS parameters jsonb NOT NULL DEFAULT '{}'::jsonb;
