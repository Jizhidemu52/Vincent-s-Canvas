import { uiText, useUiLocale } from "@/lib/i18n";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";

import { isAdminRole, useUserStore } from "@/stores/use-user-store";
import { standaloneEdition } from "@/lib/standalone-edition";
import { shouldBypassStandaloneAuthGate } from "@/lib/standalone-access";
import { ServiceUnavailable } from "@/components/auth/service-unavailable";
import { CompanyOaEntry } from "@/components/auth/company-oa-entry";
import { deploymentFeatures } from "@/lib/deployment-features";
import { isWorkspaceRole } from "../../../../shared/workspace-access";

export function AuthGate({ children, admin = false, passwordChange = false }: { children: ReactNode; admin?: boolean; passwordChange?: boolean }) {
    useUiLocale();
    if (shouldBypassStandaloneAuthGate(standaloneEdition, admin)) return <>{children}</>;
    return <AuthenticatedGate admin={admin} passwordChange={passwordChange}>{children}</AuthenticatedGate>;
}

function AuthenticatedGate({ children, admin, passwordChange }: { children: ReactNode; admin: boolean; passwordChange: boolean }) {
    useUiLocale();
    const location = useLocation();
    const user = useUserStore((state) => state.user);
    const status = useUserStore((state) => state.status);
    const hydrateSession = useUserStore((state) => state.hydrateSession);

    useEffect(() => { if (status === "idle") void hydrateSession(); }, [hydrateSession, status]);

    if (status === "idle" || status === "loading") {
        return <div className="flex h-full items-center justify-center bg-background text-foreground" role="status" aria-label={uiText("正在验证账号")}><div className="size-6 animate-spin rounded-full border-2 border-border border-t-primary" /></div>;
    }
    // The layout locks expired sessions without unmounting unsent local drafts.
    // All authenticated API helpers still require status === "authenticated".
    if (!user || (status !== "authenticated" && status !== "expired")) {
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
    if (admin && !isAdminRole(user.role)) return <main role="alert" className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center"><h1 className="text-xl font-semibold">{uiText("当前账号没有管理权限")}</h1><p className="text-sm text-muted-foreground">{uiText("此页面仅供管理员使用。你的作品和当前登录不受影响，请联系管理员处理。")}</p><Link to="/" className="underline">{uiText("返回工作台")}</Link></main>;
    if (!admin && deploymentFeatures.authenticationEnabled && !isWorkspaceRole(user.role)) return deploymentFeatures.oaLoginEnabled ? <CompanyOaEntry /> : <Navigate to="/admin" replace />;
    return <>{children}</>;
}
