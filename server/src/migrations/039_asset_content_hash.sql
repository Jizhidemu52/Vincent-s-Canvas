-- Only server-verified bytes populate this column. Client metadata is not proof.
ALTER TABLE assets ADD COLUMN content_sha256 text CHECK (content_sha256 ~ '^[0-9a-f]{64}$');
CREATE INDEX assets_owner_content_hash_idx ON assets(owner_user_id,content_sha256)
  WHERE status='ready' AND deleted_at IS NULL AND content_sha256 IS NOT NULL;
