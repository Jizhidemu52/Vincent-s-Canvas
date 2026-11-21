CREATE TABLE provider_upload_cache (
  provider_id uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_scope text NOT NULL,
  content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
  reference_spec text NOT NULL,
  url text,
  expires_at timestamptz NOT NULL,
  lease_token uuid,
  generation_id uuid NOT NULL UNIQUE,
  CHECK ((url IS NULL) = (lease_token IS NOT NULL)),
  PRIMARY KEY(provider_id,owner_user_id,credential_scope,content_sha256,reference_spec)
);
CREATE INDEX provider_upload_cache_expiry ON provider_upload_cache(expires_at);
CREATE TABLE provider_upload_task_inputs (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  generation_id uuid NOT NULL,
  PRIMARY KEY(task_id,generation_id)
);
