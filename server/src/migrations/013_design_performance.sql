ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS category text,
    ADD COLUMN IF NOT EXISTS deadline_at timestamptz;

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS deadline_at timestamptz;

ALTER TABLE assets
    ADD COLUMN IF NOT EXISTS primary_direction text,
    ADD COLUMN IF NOT EXISTS secondary_directions jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS direction_rule_version text,
    ADD COLUMN IF NOT EXISTS direction_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS admin_direction_tags jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS assets_direction_time_idx
    ON assets(primary_direction, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS projects_deadline_idx
    ON projects(deadline_at) WHERE deadline_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_deadline_idx
    ON tasks(deadline_at) WHERE deadline_at IS NOT NULL;

INSERT INTO module_flags(module_key,enabled) VALUES('performance',true)
ON CONFLICT(module_key) DO NOTHING;

UPDATE assets
SET primary_direction = CASE
      WHEN operation_type='seamless_stitch' THEN 'seamless_stitch'
      WHEN operation_type='upscale' THEN 'detail_enhance'
      WHEN operation_type='batch_image' THEN 'batch_edit'
      WHEN operation_type='inpaint' THEN 'image_edit'
      WHEN lower(coalesce(prompt,'')) ~ '(花型|图案|印花|纹样|pattern|print)' THEN 'pattern'
      WHEN lower(coalesce(prompt,'')) ~ '(服装|款式|上衣|裙|裤|外套|garment|apparel|fashion)' THEN 'apparel'
      WHEN lower(coalesce(prompt,'')) ~ '(商品|产品|白底|电商|product|catalog)' THEN 'product'
      ELSE 'image_edit'
    END,
    direction_rule_version='v1',
    direction_evidence=jsonb_build_object('source','migration-013','operationType',operation_type)
WHERE primary_direction IS NULL AND status='ready' AND source IN ('generation','edit');
