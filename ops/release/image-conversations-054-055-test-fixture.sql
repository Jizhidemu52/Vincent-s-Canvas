INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost,concurrency_limit,enabled,created_by)
VALUES('05400000-0000-4000-8000-000000000026','9567f5da-bb4d-4e4b-b680-c7184d00a001','Original MAI 2.6','mai-image-2.6-flash',
 ARRAY['generate','edit','batch'],17,1.234567,11,false,'05300000-0000-4000-8000-000000000001');
INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost,concurrency_limit,enabled)
VALUES('05400000-0000-4000-8000-000000000006','9567f5da-bb4d-4e4b-b680-c7184d00a001','Original unchanged model','gpt-image-2.6-flare',
 ARRAY['generate','edit'],23,2.345678,7,true);
UPDATE tool_api_configurations SET model_config_id='05400000-0000-4000-8000-000000000026',configuration_version=9
WHERE tool_key IN ('image','canvas-image','canvas-edit');
INSERT INTO quick_image_configurations(action,model_config_id,prompt,parameters)
VALUES('remove-background','05400000-0000-4000-8000-000000000026','Keep the exact old fixed-board choice','{"size":"auto"}');
