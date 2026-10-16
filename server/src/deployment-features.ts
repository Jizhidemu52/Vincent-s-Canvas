import type { AppConfig } from "./config";

export function deploymentFeatures(config?: Partial<Pick<AppConfig, "AUTH_ENABLED" | "CREDITS_ENABLED" | "ROLE_PORTALS_ENABLED" | "OA_LOGIN_ENABLED">>) {
    const oaLoginEnabled = config?.OA_LOGIN_ENABLED === "true";
    const authenticationEnabled = oaLoginEnabled || config?.AUTH_ENABLED === "true";
    return {
        oaLoginEnabled,
        authenticationEnabled,
        creditsEnabled: authenticationEnabled && config?.CREDITS_ENABLED === "true",
        rolePortalsEnabled: authenticationEnabled && config?.ROLE_PORTALS_ENABLED === "true",
    };
}
