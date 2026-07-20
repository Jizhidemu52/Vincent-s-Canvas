ALTER TABLE assets
    ADD COLUMN IF NOT EXISTS client_reference_id text;

CREATE UNIQUE INDEX IF NOT EXISTS assets_owner_client_reference_unique
    ON assets(owner_user_id, client_reference_id)
    WHERE client_reference_id IS NOT NULL AND deleted_at IS NULL;
