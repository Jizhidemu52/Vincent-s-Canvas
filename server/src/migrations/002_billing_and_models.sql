ALTER TABLE departments ADD COLUMN IF NOT EXISTS credit_balance integer NOT NULL DEFAULT 0 CHECK (credit_balance >= 0);
ALTER TABLE departments ADD COLUMN IF NOT EXISTS credit_limit integer NOT NULL DEFAULT 0 CHECK (credit_limit >= 0);

CREATE TABLE IF NOT EXISTS providers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE,
    protocol text NOT NULL CHECK (protocol IN ('openai','gemini','volcengine','runninghub','comfyui','custom')),
    base_url text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    encrypted_credentials text,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_configs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id uuid NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
    name text NOT NULL,
    model_id text NOT NULL,
    capabilities text[] NOT NULL DEFAULT '{}',
    credit_cost integer NOT NULL DEFAULT 0 CHECK (credit_cost >= 0),
    rmb_cost numeric(12,4) NOT NULL DEFAULT 0 CHECK (rmb_cost >= 0),
    concurrency_limit integer NOT NULL DEFAULT 5 CHECK (concurrency_limit > 0),
    enabled boolean NOT NULL DEFAULT true,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(provider_id, model_id)
);

CREATE TABLE IF NOT EXISTS pricing_rule_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_type text NOT NULL CHECK (operation_type IN ('image_generation','video_generation','upscale','remove_background','inpaint','batch_image','seamless_stitch')),
    label text NOT NULL,
    credits integer NOT NULL CHECK (credits >= 0),
    department_credits integer NOT NULL DEFAULT 0 CHECK (department_credits >= 0),
    rmb_cost numeric(12,4) NOT NULL CHECK (rmb_cost >= 0),
    version integer NOT NULL,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','testing','published','retired')),
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    UNIQUE(operation_type, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_published_price_per_operation
    ON pricing_rule_versions(operation_type) WHERE status='published';

INSERT INTO pricing_rule_versions(operation_type,label,credits,rmb_cost,version,status,published_at) VALUES
    ('image_generation','生成一张图',8,0.8,1,'published',now()),
    ('video_generation','生成视频',30,3.0,1,'published',now()),
    ('upscale','放大图片',5,0.5,1,'published',now()),
    ('remove_background','去背景',3,0.3,1,'published',now()),
    ('inpaint','局部编辑',6,0.6,1,'published',now()),
    ('batch_image','批量处理每张图',4,0.4,1,'published',now()),
    ('seamless_stitch','无缝拼接',2,0.2,1,'published',now())
ON CONFLICT(operation_type,version) DO NOTHING;

CREATE TABLE IF NOT EXISTS credit_reservations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id text NOT NULL UNIQUE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    department_id uuid REFERENCES departments(id) ON DELETE RESTRICT,
    operation_type text NOT NULL,
    model_config_id uuid REFERENCES model_configs(id) ON DELETE RESTRICT,
    quantity integer NOT NULL CHECK (quantity > 0),
    credits integer NOT NULL CHECK (credits >= 0),
    rmb_cost numeric(12,4) NOT NULL CHECK (rmb_cost >= 0),
    price_snapshot jsonb NOT NULL,
    status text NOT NULL DEFAULT 'held' CHECK (status IN ('held','captured','released')),
    created_at timestamptz NOT NULL DEFAULT now(),
    settled_at timestamptz
);

CREATE TABLE IF NOT EXISTS credit_ledger (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id text NOT NULL UNIQUE,
    user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
    department_id uuid REFERENCES departments(id) ON DELETE RESTRICT,
    actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    entry_type text NOT NULL CHECK (entry_type IN ('adjustment','hold','capture','release','reversal')),
    amount integer NOT NULL,
    balance_after integer NOT NULL CHECK (balance_after >= 0),
    reference_type text NOT NULL,
    reference_id text NOT NULL,
    reason text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((user_id IS NOT NULL)::integer + (department_id IS NOT NULL)::integer = 1)
);

CREATE INDEX IF NOT EXISTS credit_ledger_user_time_idx ON credit_ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS credit_ledger_department_time_idx ON credit_ledger(department_id, created_at DESC);

CREATE OR REPLACE FUNCTION reject_credit_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'credit_ledger is append-only';
END $$;

DROP TRIGGER IF EXISTS credit_ledger_no_update ON credit_ledger;
CREATE TRIGGER credit_ledger_no_update BEFORE UPDATE OR DELETE ON credit_ledger
FOR EACH ROW EXECUTE FUNCTION reject_credit_ledger_mutation();
