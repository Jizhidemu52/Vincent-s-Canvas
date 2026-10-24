import type { ReactNode } from "react";
import { useEffect } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { isAdminRole, useUserStore } from "@/stores/use-user-store";
import { standaloneEdition } from "@/lib/standalone-edition";
import { shouldBypassStandaloneAuthGate } from "@/lib/standalone-access";
import { ServiceUnavailable } from "@/components/auth/service-unavailable";
import { CompanyOaEntry } from "@/components/auth/company-oa-entry";
import { deploymentFeatures } from "@/lib/deployment-features";
import { isWorkspaceRole } from "../../../../shared/workspace-access";

export function AuthGate({ children, admin = false, passwordChange = false }: { children: ReactNode; admin?: boolean; passwordChange?: boolean }) {
    if (shouldBypassStandaloneAuthGate(standaloneEdition, admin)) return <>{children}</>;
    return <AuthenticatedGate admin={admin} passwordChange={passwordChange}>{children}</AuthenticatedGate>;
}

function AuthenticatedGate({ children, admin, passwordChange }: { children: ReactNode; admin: boolean; passwordChange: boolean }) {
    const location = useLocation();
    const user = useUserStore((state) => state.user);
    const status = useUserStore((state) => state.status);
    const hydrateSession = useUserStore((state) => state.hydrateSession);

    useEffect(() => { if (status === "idle") void hydrateSession(); }, [hydrateSession, status]);

    if (status === "idle" || status === "loading") {
        return <div className="flex h-full items-center justify-center bg-background text-foreground" role="status" aria-label="正在验证账号"><div className="size-6 animate-spin rounded-full border-2 border-border border-t-primary" /></div>;
    }
    if (!user || status !== "authenticated") {
        if (admin) return <Navigate to="/admin/login" replace state={{ from: location.pathname + location.search }} />;
        if (deploymentFeatures.oaLoginEnabled) return <CompanyOaEntry />;
        if (deploymentFeatures.authenticationEnabled) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
        return <ServiceUnavailable onRetry={() => void hydrateSession()} />;
    }
    if (passwordChange) {
        return isAdminRole(user.role) || (deploymentFeatures.authenticationEnabled && !deploymentFeatures.oaLoginEnabled)
            ? <>{children}</> : <Navigate to="/" replace />;
    }
    if (user.mustChangePassword && ((isAdminRole(user.role) && (admin || deploymentFeatures.authenticationEnabled)) || (deploymentFeatures.authenticationEnabled && !deploymentFeatures.oaLoginEnabled))) return <Navigate to="/change-password" replace />;
    if (admin && !isAdminRole(user.role)) return <Navigate to="/admin/login" replace />;
    if (!admin && deploymentFeatures.authenticationEnabled && !isWorkspaceRole(user.role)) return deploymentFeatures.oaLoginEnabled ? <CompanyOaEntry /> : <Navigate to="/admin" replace />;
    return <>{children}</>;
}
