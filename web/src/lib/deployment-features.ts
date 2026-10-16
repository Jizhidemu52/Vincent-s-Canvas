import { standaloneEdition } from "./standalone-edition";

export type DeploymentFeatures = {
    authenticationEnabled: boolean;
    creditsEnabled: boolean;
    rolePortalsEnabled: boolean;
    oaLoginEnabled: boolean;
};

export function normalizeDeploymentFeatures(value: Partial<DeploymentFeatures> = {}): DeploymentFeatures {
    const oaLoginEnabled = value.oaLoginEnabled === true;
    const authenticationEnabled = oaLoginEnabled || value.authenticationEnabled === true;
    return {
        authenticationEnabled,
        creditsEnabled: authenticationEnabled && value.creditsEnabled === true,
        rolePortalsEnabled: authenticationEnabled && value.rolePortalsEnabled === true,
        oaLoginEnabled,
    };
}

export const deploymentFeatures = normalizeDeploymentFeatures(standaloneEdition
    ? { authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false }
    : {});

// The server selects password/OA access or trial mode and the persisted credit policy.
export async function loadDeploymentFeatures() {
    if (standaloneEdition) return true;
    try {
        const response = await fetch("/api/deployment", { credentials: "include", cache: "no-store", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(5000) });
        if (!response.ok) return false;
        const value = await response.json();
        if (!value || typeof value !== "object" || Object.keys(deploymentFeatures).some((key) => typeof value[key] !== "boolean")) return false;
        Object.assign(deploymentFeatures, normalizeDeploymentFeatures(value));
        return true;
    } catch {
        // The caller must stop startup when configuration cannot be verified.
        return false;
    }
}
