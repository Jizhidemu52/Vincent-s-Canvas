CREATE TABLE asset_fact_cards (
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  version smallint NOT NULL CHECK(version=2),
  status text NOT NULL CHECK(status IN ('pending','ready','unavailable')),
  card jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(content_sha256,version),
  CHECK ((status='ready')=(card IS NOT NULL))
);
CREATE TABLE asset_product_card_overrides (
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(asset_id,user_id)
);
