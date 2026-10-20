-- Only newly verified WeCom logins receive this provider. Existing local
-- sessions and local password/onboarding requirements are deliberately unchanged.
ALTER TABLE sessions DROP CONSTRAINT sessions_auth_provider_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_auth_provider_check
    CHECK (auth_provider IN ('local', 'oa', 'wecom'));
