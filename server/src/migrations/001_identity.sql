CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('super_admin', 'department_admin', 'designer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE user_status AS ENUM ('active', 'disabled', 'locked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS departments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE,
    code citext NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username citext NOT NULL UNIQUE,
    display_name text NOT NULL,
    email citext UNIQUE,
    employee_no citext UNIQUE,
    password_hash text,
    role user_role NOT NULL DEFAULT 'designer',
    status user_status NOT NULL DEFAULT 'active',
    department_id uuid REFERENCES departments(id) ON DELETE RESTRICT,
    must_change_password boolean NOT NULL DEFAULT true,
    mfa_enabled boolean NOT NULL DEFAULT false,
    mfa_secret_encrypted text,
    credit_balance integer NOT NULL DEFAULT 0 CHECK (credit_balance >= 0),
    credit_limit integer NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
    failed_login_count integer NOT NULL DEFAULT 0,
    locked_until timestamptz,
    last_login_at timestamptz,
    password_changed_at timestamptz,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT department_admin_requires_department CHECK (role <> 'department_admin' OR department_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS users_department_idx ON users(department_id);
CREATE INDEX IF NOT EXISTS users_role_status_idx ON users(role, status);

CREATE TABLE IF NOT EXISTS external_identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider IN ('wecom', 'ldap', 'oidc')),
    subject text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(provider, subject),
    UNIQUE(user_id, provider)
);

CREATE TABLE IF NOT EXISTS sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    ip_address inet,
    user_agent text,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id, expires_at);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_logs (
    id bigserial PRIMARY KEY,
    actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    actor_role user_role,
    action text NOT NULL,
    target_type text NOT NULL,
    target_id text,
    department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
    result text NOT NULL CHECK (result IN ('success', 'denied', 'failed')),
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip_address inet,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_actor_time_idx ON audit_logs(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_department_time_idx ON audit_logs(department_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_action_time_idx ON audit_logs(action, created_at DESC);
