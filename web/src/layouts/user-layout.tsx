import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";

import { AppTopNav } from "@/components/layout/app-top-nav";
import { cn } from "@/lib/utils";
import { useUsageTracking } from "@/hooks/use-usage-tracking";
import { UsageCollectionNotice } from "@/components/layout/frequent-navigation";
import "@/styles/workbench.css";

export default function UserLayout({ children }: { children: ReactNode }) {
    useUsageTracking();
    const { pathname } = useLocation();
    const hideShell = /^\/canvas\/[^/]+/.test(pathname) || pathname === "/login" || pathname === "/admin/login";

    return (
        <div className={cn("flex h-dvh overflow-hidden", !hideShell && "wb-app")}>
            <AppTopNav />
            <div className={cn("min-h-0 flex-1 overflow-hidden", !hideShell && "pt-14 md:pt-0")}>{children}</div>
            {/^\/canvas\/[^/]+/.test(pathname) ? <div className="pointer-events-none fixed bottom-1 left-2 z-[5] hidden md:block"><UsageCollectionNotice compact /></div> : null}
        </div>
    );
}
