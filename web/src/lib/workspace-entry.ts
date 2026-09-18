import { deploymentFeatures } from "@/lib/deployment-features";
import { isAdminRole, useUserStore } from "@/stores/use-user-store";

export function isMaintenancePath(pathname: string) {
    return /^\/admin(?:\/|$)/.test(pathname) || pathname === "/change-password";
}

/** This runs before importing any workspace or media singleton. Never persist the token. */
export async function prepareWorkspaceEntry(token: string | null, pathname: string): Promise<"workspace" | "maintenance" | "maintenance-login" | "oa-required"> {
    if (!deploymentFeatures.oaLoginEnabled) return "workspace";
    if (token !== null) await useUserStore.getState().exchangeOaToken(token);
    else await useUserStore.getState().hydrateSession();
    const { user, status } = useUserStore.getState();
    // Maintenance has a separate real-password entrance, never an anonymous employee fallback.
    if (token === null && isMaintenancePath(pathname)) {
        return status === "authenticated" && isAdminRole(user?.role) ? "maintenance" : "maintenance-login";
    }
    return status === "authenticated" && user?.role === "designer" ? "workspace" : "oa-required";
}
