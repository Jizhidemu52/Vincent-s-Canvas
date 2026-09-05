import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";

import { AppTopNav } from "@/components/layout/app-top-nav";
import { cn } from "@/lib/utils";
import "@/styles/workbench.css";

export default function UserLayout({ children }: { children: ReactNode }) {
    const { pathname } = useLocation();
    const hideShell = /^\/canvas\/[^/]+/.test(pathname) || pathname === "/login" || pathname === "/admin/login";

    return (
        <div className={cn("flex h-dvh overflow-hidden", !hideShell && "wb-app")}>
            <AppTopNav />
            <div className={cn("min-h-0 flex-1 overflow-hidden", !hideShell && "pt-14 md:pt-0")}>{children}</div>
        </div>
    );
}
