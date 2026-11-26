INSERT INTO providers (id,name,protocol,base_url)
VALUES ('d718f582-371a-43e1-8808-12eb1d85f7c0','Recraft','custom','https://external.api.recraft.ai/v1');
INSERT INTO model_configs (id,provider_id,name,model_id,capabilities)
SELECT id::uuid,'d718f582-371a-43e1-8808-12eb1d85f7c0'::uuid,name,endpoint,CASE WHEN endpoint='crispUpscale' THEN ARRAY['edit','upscale'] ELSE ARRAY['edit'] END
FROM (VALUES
  ('d718f582-371a-43e1-8808-12eb1d85f7c1','Recraft 去背景','removeBackground'),
  ('d718f582-371a-43e1-8808-12eb1d85f7c2','Recraft 高清放大','crispUpscale'),
  ('d718f582-371a-43e1-8808-12eb1d85f7c3','Recraft 矢量化','vectorize')
) AS tools(id,name,endpoint);
