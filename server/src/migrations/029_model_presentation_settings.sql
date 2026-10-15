-- Absence of a row enables the curated first-run default. Do not seed an empty row:
-- an explicitly stored empty list means the administrator disabled all featured models.
CREATE TABLE IF NOT EXISTS model_presentation_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  featured_model_ids uuid[] NOT NULL CHECK (
    cardinality(featured_model_ids) <= 5 AND array_position(featured_model_ids,NULL) IS NULL
  ),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
