import type { ReactNode } from "react";
import { useEffect } from "react";
import { useLocation } from "react-router-dom";

import { AppTopNav } from "@/components/layout/app-top-nav";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/use-theme-store";

export default function UserLayout({ children }: { children: ReactNode }) {
    const { pathname } = useLocation();
    const hideShell = /^\/canvas\/[^/]+/.test(pathname) || pathname === "/login" || pathname === "/admin/login";
    const setTheme = useThemeStore((state) => state.setTheme);

    useEffect(() => {
        if (!hideShell) setTheme("light");
    }, [hideShell, setTheme]);

    return (
        <div className="flex h-dvh overflow-hidden bg-[#eeeeec] text-stone-950">
            <AppTopNav />
            <div className={cn("min-h-0 flex-1 overflow-hidden", !hideShell && "pt-14 md:pt-0")}>{children}</div>
        </div>
    );
}
