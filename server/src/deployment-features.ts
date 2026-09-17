import type { AppConfig } from "./config";

export function deploymentFeatures(config: Pick<AppConfig, "AUTH_ENABLED" | "CREDITS_ENABLED" | "ROLE_PORTALS_ENABLED"> & Partial<Pick<AppConfig, "OA_LOGIN_ENABLED">>) {
    const oaLoginEnabled = config.OA_LOGIN_ENABLED === "true";
    const authenticationEnabled = oaLoginEnabled || config.AUTH_ENABLED !== "false";
    return {
        oaLoginEnabled,
        authenticationEnabled,
        // Anonymous identities cannot provide enforceable per-person quotas.
        creditsEnabled: authenticationEnabled && config.CREDITS_ENABLED !== "false",
        rolePortalsEnabled: !oaLoginEnabled && config.ROLE_PORTALS_ENABLED !== "false",
    };
}
