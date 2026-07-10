import type { ReactNode } from "react";
import { useEffect } from "react";

import { useUserStore } from "@/stores/use-user-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const authStatus = useUserStore((state) => state.status);
    const hydrateSession = useUserStore((state) => state.hydrateSession);

    useEffect(() => {
        if (authStatus !== "authenticated") return;
        const refresh = () => void hydrateSession();
        const timer = window.setInterval(refresh, 30_000);
        const onVisibility = () => { if (document.visibilityState === "visible") refresh(); };
        document.addEventListener("visibilitychange", onVisibility);
        return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); };
    }, [authStatus, hydrateSession]);

    return <>{children}</>;
}
