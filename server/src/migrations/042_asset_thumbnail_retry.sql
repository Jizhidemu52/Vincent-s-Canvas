ALTER TABLE assets
  ADD COLUMN thumbnail_attempts integer NOT NULL DEFAULT 0 CHECK (thumbnail_attempts >= 0),
  ADD COLUMN thumbnail_retry_at timestamptz,
  ADD COLUMN thumbnail_lease_token uuid,
  ADD COLUMN thumbnail_last_error text;

CREATE INDEX assets_thumbnail_retry_idx ON assets(thumbnail_retry_at,created_at,id)
  WHERE kind='image' AND status='ready' AND deleted_at IS NULL
    AND (thumbnail_256_key IS NULL OR thumbnail_1024_key IS NULL) AND thumbnail_attempts < 4;
