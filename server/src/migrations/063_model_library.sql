CREATE TABLE model_presets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 identity text NOT NULL CHECK(identity IN ('white-woman','white-man','white-girl','white-boy')),
 name text NOT NULL,
 audience text NOT NULL CHECK((identity,audience) IN (('white-woman','women'),('white-man','men'),('white-girl','girls'),('white-boy','boys'))),
 framing text NOT NULL CHECK(framing IN ('full','half','head')),
 asset_id uuid NOT NULL REFERENCES assets(id),
 draft_asset_id uuid REFERENCES assets(id),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','hidden')),
 sort_order int NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(identity,framing)
);
CREATE TABLE user_model_defaults (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 preset_identity text CHECK(preset_identity IN ('white-woman','white-man','white-girl','white-boy')),
 asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
 last_child text CHECK(last_child IN ('girls','boys')),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (preset_identity IS NULL OR asset_id IS NULL)
);
