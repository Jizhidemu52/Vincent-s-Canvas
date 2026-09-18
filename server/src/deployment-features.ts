import type { AppConfig } from "./config";

export function deploymentFeatures(config?: Partial<Pick<AppConfig, "AUTH_ENABLED" | "CREDITS_ENABLED" | "ROLE_PORTALS_ENABLED" | "OA_LOGIN_ENABLED">>) {
    // Employee workspaces opt in to trusted OA sessions. The separate local
    // trial stays open; legacy password/billing flags never change either mode.
    const oaLoginEnabled = config?.OA_LOGIN_ENABLED === "true";
    return {
        oaLoginEnabled,
        authenticationEnabled: oaLoginEnabled,
        creditsEnabled: false,
        rolePortalsEnabled: false,
    };
}
