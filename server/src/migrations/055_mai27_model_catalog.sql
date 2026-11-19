INSERT INTO model_configs(provider_id,name,model_id,capabilities,credit_cost,rmb_cost,concurrency_limit,enabled,created_by)
SELECT provider_id,'aplmart-mai2.7-flash','mai-image-2.7-flash',ARRAY['generate','edit','batch'],
  credit_cost,rmb_cost,concurrency_limit,enabled,created_by
FROM model_configs source
WHERE source.provider_id='9567f5da-bb4d-4e4b-b680-c7184d00a001' AND source.model_id='mai-image-2.6-flash'
  AND NOT EXISTS (
    SELECT 1 FROM model_configs target
    WHERE target.provider_id=source.provider_id AND target.model_id='mai-image-2.7-flash'
  )
ON CONFLICT(provider_id,model_id) DO NOTHING;
