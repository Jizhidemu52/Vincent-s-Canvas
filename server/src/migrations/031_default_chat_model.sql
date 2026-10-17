-- Initialize the shared chat binding only for untouched first-run configuration.
-- Keep any administrator-selected or explicitly cleared binding unchanged.
INSERT INTO tool_api_configurations(tool_key,model_config_id,enabled)
SELECT 'gpt-chat',id,true FROM model_configs
WHERE provider_id='9567f5da-bb4d-4e4b-b680-c7184d00a001'::uuid AND model_id='claude-sonnet-5-5'
ON CONFLICT(tool_key) DO UPDATE SET model_config_id=EXCLUDED.model_config_id,
    configuration_version=tool_api_configurations.configuration_version+1,updated_at=now()
WHERE tool_api_configurations.model_config_id IS NULL AND tool_api_configurations.updated_by IS NULL
    AND tool_api_configurations.configuration_version=1;
