ALTER TABLE projects ALTER COLUMN external_id SET NOT NULL;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_external_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS projects_owner_external_unique ON projects(owner_user_id, external_id);
