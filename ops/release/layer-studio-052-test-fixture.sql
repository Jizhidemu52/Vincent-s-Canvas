-- Synthetic disposable test records only. Never packaged or used on a host.
INSERT INTO users(id,username,display_name,role,status,must_change_password,credit_balance)
VALUES('05200000-0000-4000-8000-000000000001','layer052-fixture','Original employee','super_admin','active',false,73);
INSERT INTO providers(id,name,protocol,base_url,enabled)
VALUES('05200000-0000-4000-8000-000000000002','Original provider','apimart','https://invalid.example',true);
INSERT INTO model_configs(id,provider_id,name,model_id,capabilities)
VALUES('05200000-0000-4000-8000-000000000003','05200000-0000-4000-8000-000000000002','Original model','offline-fixture',ARRAY['image','edit']);
INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,status,queued_at,parameters,source_urls,result_urls)
VALUES('05200000-0000-4000-8000-000000000004','layer052-original-task','05200000-0000-4000-8000-000000000001','old-project','image_generation','paused','2026-09-01T01:00:00Z','{"prompt":"Original private text","nested":{"keep":true}}','["https://invalid.example/source.png"]','["/api/assets/original/content"]');
UPDATE tool_api_configurations SET enabled=false,credit_cost_override=7,rmb_cost_override=1.234567 WHERE tool_key='image';
INSERT INTO prompt_recipes(key,settings,updated_at)
VALUES('text-to-style','{"name":"Private prior recipe","enabled":false,"modelConfigId":null,"failurePolicy":"stop"}','2000-01-01T00:00:00.000Z');
INSERT INTO prompt_recipe_versions(id,recipe_key,version,content_hash,content,created_by,created_at)
VALUES('layer052-prior-version','text-to-style',1,'prior-hash','{"systemPrompt":"Original private prompt"}','original-author','2000-01-01T00:00:00.000Z');
UPDATE prompt_recipes SET current_version_id='layer052-prior-version' WHERE key='text-to-style';
