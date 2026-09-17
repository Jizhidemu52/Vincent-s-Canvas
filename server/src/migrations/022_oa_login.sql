ALTER TABLE external_identities DROP CONSTRAINT external_identities_provider_check;
ALTER TABLE external_identities ADD CONSTRAINT external_identities_provider_check
    CHECK (provider IN ('wecom', 'ldap', 'oidc', 'oa'));

-- Existing sessions are deliberately not OA sessions; enabling OA rejects them.
ALTER TABLE sessions ADD COLUMN auth_provider text NOT NULL DEFAULT 'local'
    CHECK (auth_provider IN ('local', 'oa'));
