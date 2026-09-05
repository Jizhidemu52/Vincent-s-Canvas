import { standaloneEdition } from "./standalone-edition";

export type DeploymentFeatures = {
    authenticationEnabled: boolean;
    creditsEnabled: boolean;
    rolePortalsEnabled: boolean;
};

export function normalizeDeploymentFeatures(value: Partial<DeploymentFeatures> = {}): DeploymentFeatures {
    const authenticationEnabled = value.authenticationEnabled !== false;
    return {
        authenticationEnabled,
        creditsEnabled: authenticationEnabled && value.creditsEnabled !== false,
        rolePortalsEnabled: value.rolePortalsEnabled !== false,
    };
}

export const deploymentFeatures = normalizeDeploymentFeatures(standaloneEdition
    ? { authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false }
    : {});

// The server is authoritative. No browser preference can turn off its authentication or billing.
export async function loadDeploymentFeatures() {
    if (standaloneEdition) return;
    try {
        const response = await fetch("/api/deployment", { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(5000) });
        if (!response.ok) return;
        Object.assign(deploymentFeatures, normalizeDeploymentFeatures(await response.json()));
    } catch {
        // Fail closed: preserve the authenticated defaults when the API is unavailable.
    }
}
