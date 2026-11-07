-- Synthetic offline test rows only. This file is never packaged.
INSERT INTO users(id,username,display_name,role,status,must_change_password,credit_balance)
VALUES('05100000-0000-4000-8000-000000000001','creative051-fixture','Unchanged employee','super_admin','active',false,73);
INSERT INTO providers(id,name,protocol,base_url,enabled)
VALUES('9567f5da-bb4d-4e4b-b680-c7184d00a001','Offline fixture','apimart','https://invalid.example',true);
INSERT INTO model_configs(id,provider_id,name,model_id,capabilities)
VALUES('05100000-0000-4000-8000-000000000002','9567f5da-bb4d-4e4b-b680-c7184d00a001','Fixture optimizer','fixture-chat',ARRAY['chat']),
 ('05100000-0000-4000-8000-000000000003','9567f5da-bb4d-4e4b-b680-c7184d00a001','Fixture image','gpt-image-2.6-flare',ARRAY['edit']);
INSERT INTO prompt_recipes(key,settings,updated_at)
VALUES('text-to-style','{"name":"Private legacy fixture","enabled":false,"modelConfigId":null,"failurePolicy":"stop"}','2000-01-01T00:00:00.000Z');
INSERT INTO prompt_recipe_versions(id,recipe_key,version,content_hash,content,created_by,created_at)
VALUES('private-fixture-version','text-to-style',1,'private-fixture-hash','{"systemPrompt":"Private fixture must remain unchanged"}','original-author','2000-01-01T00:00:00.000Z');
UPDATE prompt_recipes SET current_version_id='private-fixture-version' WHERE key='text-to-style';
