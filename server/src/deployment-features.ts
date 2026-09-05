import type { AppConfig } from "./config";

export function deploymentFeatures(config: Pick<AppConfig, "AUTH_ENABLED" | "CREDITS_ENABLED" | "ROLE_PORTALS_ENABLED">) {
    const authenticationEnabled = config.AUTH_ENABLED !== "false";
    return {
        authenticationEnabled,
        // Anonymous identities cannot provide enforceable per-person quotas.
        creditsEnabled: authenticationEnabled && config.CREDITS_ENABLED !== "false",
        rolePortalsEnabled: config.ROLE_PORTALS_ENABLED !== "false",
    };
}
