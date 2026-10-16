-- An absent row uses the deployment default. Once saved, the administrator's
-- choice survives restarts and takes precedence over that default.
CREATE TABLE credit_policy (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    credits_enabled boolean NOT NULL DEFAULT false,
    updated_by uuid REFERENCES users(id),
    updated_at timestamptz NOT NULL DEFAULT now()
);
