import { useEffect, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

import { AppTopNav } from "@/components/layout/app-top-nav";
import { cn } from "@/lib/utils";
import { useUsageTracking } from "@/hooks/use-usage-tracking";
import { useUnsavedNavigationGuard } from "@/hooks/use-unsaved-guard";
import { useUserStore } from "@/stores/use-user-store";
import { deploymentFeatures } from "@/lib/deployment-features";
import { SessionExpiredDialog } from "@/components/auth/session-expired-dialog";
import "@/styles/workbench.css";

export default function UserLayout({ children }: { children: ReactNode }) {
    useUsageTracking();
    useUnsavedNavigationGuard();
    const expired = useUserStore(state => state.status === "expired");
    useEffect(() => {
        if (!deploymentFeatures.authenticationEnabled) return;
        const check = () => {
            const session = useUserStore.getState();
            if (document.visibilityState === "visible" && (session.status === "authenticated" || session.status === "expired")) void session.hydrateSession();
        };
        const timer = window.setInterval(check, 60_000);
        window.addEventListener("focus", check);
        return () => { window.clearInterval(timer); window.removeEventListener("focus", check); };
    }, []);
    const { pathname } = useLocation();
    const hideShell = /^\/canvas\/[^/]+/.test(pathname) || pathname === "/login" || pathname === "/admin/login";

    return (
        <><div inert={expired || undefined} aria-hidden={expired || undefined} className={cn("flex h-dvh overflow-hidden", !hideShell && "wb-app")}>
            <AppTopNav />
            <div className={cn("min-h-0 flex-1 overflow-hidden", !hideShell && "pt-14 md:pt-0")}>{children}</div>
        </div><SessionExpiredDialog /></>
    );
}
