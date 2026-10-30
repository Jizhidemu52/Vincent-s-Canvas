-- Preserve all historical values while retaining exact per-image RMB prices.
ALTER TABLE model_configs ALTER COLUMN rmb_cost TYPE numeric(16,6);
ALTER TABLE pricing_rule_versions ALTER COLUMN rmb_cost TYPE numeric(16,6);
ALTER TABLE credit_reservations ALTER COLUMN rmb_cost TYPE numeric(16,6);
ALTER TABLE tasks ALTER COLUMN rmb_cost TYPE numeric(16,6);
ALTER TABLE generation_history ALTER COLUMN rmb_cost TYPE numeric(16,6);
ALTER TABLE asset_events ALTER COLUMN rmb_cost TYPE numeric(16,6);
ALTER TABLE tool_api_configurations ALTER COLUMN rmb_cost_override TYPE numeric(16,6);

-- Current configuration only: no history, snapshots, employee balances or credentials change.
UPDATE model_configs SET rmb_cost=CASE model_id
  WHEN 'gpt-image-2' THEN 0.05368
  WHEN 'gpt-image-2.5-flare' THEN 0.1342
  WHEN 'gpt-image-2.5-sunburst' THEN 0.1342
  WHEN 'gemini-3.1-flash-image-preview' THEN 0.3355
  WHEN 'gemini-3.1-flash-image-preview-official' THEN 0.3355
END,updated_at=now()
WHERE provider_id='9567f5da-bb4d-4e4b-b680-c7184d00a001'
  AND model_id IN ('gpt-image-2','gpt-image-2.5-flare','gpt-image-2.5-sunburst',
    'gemini-3.1-flash-image-preview','gemini-3.1-flash-image-preview-official');
