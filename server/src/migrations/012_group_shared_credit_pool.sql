ALTER TABLE designer_groups
    ADD COLUMN IF NOT EXISTS monthly_shared_credit_limit integer NOT NULL DEFAULT 0 CHECK (monthly_shared_credit_limit >= 0),
    ADD COLUMN IF NOT EXISTS shared_credit_per_request_limit integer NOT NULL DEFAULT 0 CHECK (shared_credit_per_request_limit >= 0),
    ADD COLUMN IF NOT EXISTS shared_credit_daily_user_limit integer NOT NULL DEFAULT 0 CHECK (shared_credit_daily_user_limit >= 0),
    ADD COLUMN IF NOT EXISTS shared_credit_monthly_user_limit integer NOT NULL DEFAULT 0 CHECK (shared_credit_monthly_user_limit >= 0),
    ADD COLUMN IF NOT EXISTS shared_credit_updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS shared_credit_updated_at timestamptz;

CREATE TABLE IF NOT EXISTS group_credit_periods (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id uuid NOT NULL REFERENCES designer_groups(id) ON DELETE RESTRICT,
    period_start date NOT NULL,
    fixed_credits integer NOT NULL CHECK (fixed_credits >= 0),
    contributed_credits integer NOT NULL DEFAULT 0 CHECK (contributed_credits >= 0),
    allocated_credits integer NOT NULL DEFAULT 0 CHECK (allocated_credits >= 0),
    expired_credits integer NOT NULL DEFAULT 0 CHECK (expired_credits >= 0),
    pool_balance integer NOT NULL CHECK (pool_balance >= 0),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz,
    UNIQUE(group_id, period_start)
);

CREATE INDEX IF NOT EXISTS group_credit_periods_group_time_idx
    ON group_credit_periods(group_id, period_start DESC);

CREATE TABLE IF NOT EXISTS group_credit_wallets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id uuid NOT NULL REFERENCES designer_groups(id) ON DELETE RESTRICT,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    period_start date NOT NULL,
    granted_credits integer NOT NULL DEFAULT 0 CHECK (granted_credits >= 0),
    available_credits integer NOT NULL DEFAULT 0 CHECK (available_credits >= 0),
    spent_credits integer NOT NULL DEFAULT 0 CHECK (spent_credits >= 0),
    expired_credits integer NOT NULL DEFAULT 0 CHECK (expired_credits >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(group_id, user_id, period_start)
);

CREATE INDEX IF NOT EXISTS group_credit_wallets_user_period_idx
    ON group_credit_wallets(user_id, period_start DESC);

CREATE TABLE IF NOT EXISTS group_credit_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id text NOT NULL UNIQUE,
    group_id uuid NOT NULL REFERENCES designer_groups(id) ON DELETE RESTRICT,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    period_start date NOT NULL,
    amount integer NOT NULL CHECK (amount > 0),
    reason text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled','expired')),
    decision_note text,
    reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS group_credit_requests_group_status_time_idx
    ON group_credit_requests(group_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS group_credit_requests_user_period_idx
    ON group_credit_requests(user_id, period_start, created_at DESC);

CREATE TABLE IF NOT EXISTS group_credit_ledger (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id text NOT NULL UNIQUE,
    group_id uuid NOT NULL REFERENCES designer_groups(id) ON DELETE RESTRICT,
    user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
    actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    period_start date NOT NULL,
    entry_type text NOT NULL CHECK (entry_type IN (
        'period_opened','period_expired','request_submitted','request_expired','request_rejected',
        'contribution','allocation_approved','hold','capture','release','correction'
    )),
    pool_amount integer NOT NULL DEFAULT 0,
    wallet_amount integer NOT NULL DEFAULT 0,
    pool_balance_after integer CHECK (pool_balance_after >= 0),
    wallet_balance_after integer CHECK (wallet_balance_after >= 0),
    reference_type text NOT NULL,
    reference_id text NOT NULL,
    reason text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS group_credit_ledger_group_time_idx
    ON group_credit_ledger(group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS group_credit_ledger_user_time_idx
    ON group_credit_ledger(user_id, created_at DESC) WHERE user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION reject_group_credit_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'group_credit_ledger is append-only';
END $$;

DROP TRIGGER IF EXISTS group_credit_ledger_no_update ON group_credit_ledger;
CREATE TRIGGER group_credit_ledger_no_update BEFORE UPDATE OR DELETE ON group_credit_ledger
FOR EACH ROW EXECUTE FUNCTION reject_group_credit_ledger_mutation();

ALTER TABLE credit_reservations
    ADD COLUMN IF NOT EXISTS personal_credits integer NOT NULL DEFAULT 0 CHECK (personal_credits >= 0),
    ADD COLUMN IF NOT EXISTS group_credits integer NOT NULL DEFAULT 0 CHECK (group_credits >= 0),
    ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES designer_groups(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS group_period_start date;

UPDATE credit_reservations
SET personal_credits=credits
WHERE personal_credits=0 AND group_credits=0 AND credits>0;

ALTER TABLE credit_reservations
    ADD CONSTRAINT credit_reservations_source_total_check
    CHECK (personal_credits + group_credits = credits),
    ADD CONSTRAINT credit_reservations_group_source_check
    CHECK ((group_credits=0 AND group_id IS NULL AND group_period_start IS NULL)
        OR (group_credits>0 AND group_id IS NOT NULL AND group_period_start IS NOT NULL));

ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_entry_type_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_entry_type_check
    CHECK (entry_type IN ('adjustment','monthly_reset','group_contribution','hold','capture','release','reversal'));
