import type { ReactNode } from "react";
import { useEffect } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { isAdminRole, useUserStore } from "@/stores/use-user-store";

export function AuthGate({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
    const location = useLocation();
    const user = useUserStore((state) => state.user);
    const status = useUserStore((state) => state.status);
    const hydrateSession = useUserStore((state) => state.hydrateSession);

    useEffect(() => { if (status === "idle") void hydrateSession(); }, [hydrateSession, status]);

    if (status === "idle" || status === "loading") {
        return <div className="flex h-full items-center justify-center bg-[#eeeeec]"><div className="size-6 animate-spin rounded-full border-2 border-orange-200 border-t-orange-600" /></div>;
    }
    if (!user) return <Navigate to={admin ? "/admin/login" : "/login"} replace state={{ from: location.pathname + location.search }} />;
    if (user.mustChangePassword && location.pathname !== "/change-password") return <Navigate to="/change-password" replace />;
    if (user.role === "super_admin" && !user.mfaEnabled && location.pathname !== "/setup-mfa") return <Navigate to="/setup-mfa" replace />;
    if (admin && !isAdminRole(user.role)) return <Navigate to="/" replace />;
    return <>{children}</>;
}
