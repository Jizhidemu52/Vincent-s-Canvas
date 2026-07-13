ALTER TABLE users
    ADD COLUMN IF NOT EXISTS monthly_credit_limit integer NOT NULL DEFAULT 0 CHECK (monthly_credit_limit >= 0),
    ADD COLUMN IF NOT EXISTS temporary_credit_adjustment integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS credit_period_start date;

UPDATE users SET monthly_credit_limit = credit_limit
WHERE monthly_credit_limit = 0 AND credit_limit > 0;

UPDATE users
SET credit_period_start = date_trunc('month', timezone('Asia/Shanghai', now()))::date
WHERE credit_period_start IS NULL;

ALTER TABLE users
    ALTER COLUMN credit_period_start SET NOT NULL,
    ALTER COLUMN credit_period_start SET DEFAULT (date_trunc('month', timezone('Asia/Shanghai', now()))::date);

ALTER TABLE credit_reservations ADD COLUMN IF NOT EXISTS credit_period_start date;

UPDATE credit_reservations
SET credit_period_start = date_trunc('month', timezone('Asia/Shanghai', created_at))::date
WHERE credit_period_start IS NULL;

ALTER TABLE credit_reservations
    ALTER COLUMN credit_period_start SET NOT NULL,
    ALTER COLUMN credit_period_start SET DEFAULT (date_trunc('month', timezone('Asia/Shanghai', now()))::date);

ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_entry_type_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_entry_type_check
    CHECK (entry_type IN ('adjustment','monthly_reset','hold','capture','release','reversal'));
