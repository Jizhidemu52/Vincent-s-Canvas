import type { ReactNode } from "react";
import { useEffect } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { isAdminRole, useUserStore } from "@/stores/use-user-store";
import { standaloneEdition } from "@/lib/standalone-edition";
import { shouldBypassStandaloneAuthGate } from "@/lib/standalone-access";
import { deploymentFeatures } from "@/lib/deployment-features";

export function AuthGate({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
    if (shouldBypassStandaloneAuthGate(standaloneEdition, admin)) return <>{children}</>;

    const location = useLocation();
    const user = useUserStore((state) => state.user);
    const status = useUserStore((state) => state.status);
    const hydrateSession = useUserStore((state) => state.hydrateSession);

    useEffect(() => { if (status === "idle") void hydrateSession(); }, [hydrateSession, status]);

    if (status === "idle" || status === "loading") {
        return <div className="flex h-full items-center justify-center bg-[#eeeeec]"><div className="size-6 animate-spin rounded-full border-2 border-orange-200 border-t-orange-600" /></div>;
    }
    if (!user) {
        if (!deploymentFeatures.authenticationEnabled && !admin) return <div role="alert" className="flex h-full flex-col items-center justify-center gap-3"><p>暂时无法连接服务，请检查后端是否已启动。</p><button type="button" onClick={() => void hydrateSession()}>重新连接</button></div>;
        return <Navigate to={admin ? "/admin/login" : "/login"} replace state={{ from: location.pathname + location.search }} />;
    }
    if (user.mustChangePassword && location.pathname !== "/change-password") return <Navigate to="/change-password" replace />;
    if (admin && !isAdminRole(user.role)) return <Navigate to="/" replace />;
    return <>{children}</>;
}
