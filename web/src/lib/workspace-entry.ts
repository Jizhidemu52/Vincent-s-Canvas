import { deploymentFeatures } from "@/lib/deployment-features";
import { isAdminRole, useUserStore } from "@/stores/use-user-store";
import { isWorkspaceRole } from "../../../shared/workspace-access";

export function isMaintenancePath(pathname: string) {
    return /^\/admin(?:\/|$)/.test(pathname) || pathname === "/change-password";
}

/** This runs before importing any workspace or media singleton. Never persist the token. */
export async function prepareWorkspaceEntry(token: string | null, pathname: string): Promise<"workspace" | "maintenance" | "maintenance-login" | "password-login" | "password-change" | "oa-required"> {
    if (!deploymentFeatures.authenticationEnabled) return "workspace";
    const explicitOaToken = deploymentFeatures.oaLoginEnabled && token !== null;
    if (explicitOaToken) await useUserStore.getState().exchangeOaToken(token);
    else await useUserStore.getState().hydrateSession();
    const { user, status } = useUserStore.getState();
    const authenticated = status === "authenticated" && Boolean(user);
    if (explicitOaToken && (!authenticated || user?.role !== "designer")) return "oa-required";
    if (authenticated && user && (isAdminRole(user.role) || !deploymentFeatures.oaLoginEnabled)
        && (user.mustChangePassword || pathname === "/change-password")) return "password-change";
    if (!explicitOaToken && pathname === "/admin/login") return "maintenance-login";
    if (!deploymentFeatures.oaLoginEnabled && pathname === "/login") return "password-login";
    // Maintenance has a separate real-password entrance, never an anonymous employee fallback.
    if (!explicitOaToken && isMaintenancePath(pathname)) {
        return authenticated && isAdminRole(user?.role) ? "maintenance" : "maintenance-login";
    }
    if (authenticated && isWorkspaceRole(user?.role)) return "workspace";
    if (!deploymentFeatures.oaLoginEnabled && authenticated && isAdminRole(user?.role)) return "maintenance";
    return deploymentFeatures.oaLoginEnabled ? "oa-required" : "password-login";
}
