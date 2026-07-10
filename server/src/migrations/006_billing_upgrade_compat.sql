ALTER TABLE credit_reservations ADD COLUMN IF NOT EXISTS department_credits integer NOT NULL DEFAULT 0 CHECK (department_credits >= 0);
ALTER TABLE pricing_rule_versions DROP COLUMN IF EXISTS department_credits;

ALTER TABLE pricing_rule_versions DROP CONSTRAINT IF EXISTS pricing_rule_versions_operation_type_check;
ALTER TABLE pricing_rule_versions ADD CONSTRAINT pricing_rule_versions_operation_type_check
    CHECK (operation_type IN ('image_generation','video_generation','upscale','remove_background','inpaint','batch_image','seamless_stitch'));

INSERT INTO pricing_rule_versions(operation_type,label,credits,rmb_cost,version,status,published_at)
VALUES('video_generation','生成视频',30,3.0,1,'published',now())
ON CONFLICT(operation_type,version) DO NOTHING;
