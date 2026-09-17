import { standaloneEdition } from "./standalone-edition";

export type DeploymentFeatures = {
    authenticationEnabled: boolean;
    creditsEnabled: boolean;
    rolePortalsEnabled: boolean;
    oaLoginEnabled: boolean;
};

export function normalizeDeploymentFeatures(value: Partial<DeploymentFeatures> = {}): DeploymentFeatures {
    const oaLoginEnabled = value.oaLoginEnabled === true;
    const authenticationEnabled = oaLoginEnabled || value.authenticationEnabled !== false;
    return {
        authenticationEnabled,
        creditsEnabled: authenticationEnabled && value.creditsEnabled !== false,
        rolePortalsEnabled: !oaLoginEnabled && value.rolePortalsEnabled !== false,
        oaLoginEnabled,
    };
}

export const deploymentFeatures = normalizeDeploymentFeatures(standaloneEdition
    ? { authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false }
    : {});

// The server is authoritative. No browser preference can turn off its authentication or billing.
export async function loadDeploymentFeatures() {
    if (standaloneEdition) return true;
    try {
        const response = await fetch("/api/deployment", { credentials: "include", cache: "no-store", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(5000) });
        if (!response.ok) return false;
        Object.assign(deploymentFeatures, normalizeDeploymentFeatures(await response.json()));
        return true;
    } catch {
        // Fail closed: preserve the authenticated defaults when the API is unavailable.
        return false;
    }
}
