CREATE TABLE tryout_model_bindings (
    tier text PRIMARY KEY CHECK (tier IN ('quick','hd')),
    model_config_id uuid REFERENCES model_configs(id) ON DELETE RESTRICT,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0)
);
INSERT INTO tryout_model_bindings(tier) VALUES ('quick'),('hd');
