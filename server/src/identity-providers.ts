export type ExternalIdentityProfile = {
    subject: string;
    username?: string;
    displayName?: string;
    email?: string;
    employeeNo?: string;
    metadata?: Record<string, unknown>;
};

export interface IdentityProviderAdapter {
    readonly id: "wecom" | "ldap" | "oidc";
    getAuthorizationUrl(state: string): Promise<string>;
    exchangeCallback(input: Record<string, string>): Promise<ExternalIdentityProfile>;
}

export class IdentityProviderRegistry {
    private adapters = new Map<string, IdentityProviderAdapter>();

    register(adapter: IdentityProviderAdapter) {
        this.adapters.set(adapter.id, adapter);
    }

    get(id: string) {
        return this.adapters.get(id);
    }
}
