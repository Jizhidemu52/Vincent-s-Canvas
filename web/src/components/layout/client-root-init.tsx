import type { ReactNode } from "react";
import { useEffect } from "react";

import { useUserStore } from "@/stores/use-user-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useModuleStore } from "@/stores/use-module-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const authStatus = useUserStore((state) => state.status);
    const hydrateSession = useUserStore((state) => state.hydrateSession);
    const refreshBusinessConfig = useBusinessConfigStore((state) => state.refresh);
    const refreshModules = useModuleStore((state) => state.refresh);

    useEffect(() => {
        if (authStatus !== "authenticated") return;
        const syncProjects = async () => {
            await Promise.allSettled(
                useCanvasStore
                    .getState()
                    .projects.map((project) => fetch("/api/projects/sync", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ externalId: project.id, name: project.title }) })),
            );
        };
        const refresh = () => {
            void hydrateSession();
            void refreshBusinessConfig().catch(() => undefined);
            void refreshModules().catch(() => undefined);
            void syncProjects();
        };
        refresh();
        const timer = window.setInterval(refresh, 10_000);
        const onVisibility = () => {
            if (document.visibilityState === "visible") refresh();
        };
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [authStatus, hydrateSession, refreshBusinessConfig, refreshModules]);

    return <>{children}</>;
}
