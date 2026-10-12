import type { ReactNode } from "react";
import { useEffect } from "react";

import { useUserStore } from "@/stores/use-user-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useModuleStore } from "@/stores/use-module-store";
import { deploymentFeatures } from "@/lib/deployment-features";
import { createCanvasProjectMetadataSync } from "@/lib/canvas/canvas-project-metadata-sync";
import { syncProjectMetadata } from "@/services/api/projects";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const authStatus = useUserStore((state) => state.status);
    const ownerId = useUserStore((state) => state.user?.id);
    const hydrateSession = useUserStore((state) => state.hydrateSession);
    const refreshBusinessConfig = useBusinessConfigStore((state) => state.refresh);
    const refreshModules = useModuleStore((state) => state.refresh);

    useEffect(() => {
        if (authStatus === "idle") void hydrateSession();
    }, [authStatus, hydrateSession]);

    useEffect(() => {
        if (authStatus !== "authenticated" || !ownerId) return;
        if (deploymentFeatures.oaLoginEnabled && useUserStore.getState().user?.role !== "designer") return;
        let disposed = false;
        const projectSync = createCanvasProjectMetadataSync({
            ownerId,
            getProjects: () => useCanvasStore.getState().projects,
            isCurrentOwner: () => {
                const session = useUserStore.getState();
                return session.status === "authenticated" && session.user?.id === ownerId && useCanvasStore.getState().hydrated
                    && (!deploymentFeatures.oaLoginEnabled || session.user.role === "designer");
            },
            isVisible: () => document.visibilityState === "visible",
            submit: syncProjectMetadata,
        });
        const refresh = async () => {
            await hydrateSession();
            if (disposed || useUserStore.getState().user?.id !== ownerId) return;
            void refreshBusinessConfig().catch(() => undefined);
            void refreshModules().catch(() => undefined);
            void projectSync.sync();
        };
        refresh();
        const timer = window.setInterval(refresh, 10_000);
        const onVisibility = () => {
            if (document.visibilityState === "visible") refresh();
        };
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            disposed = true;
            projectSync.dispose();
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [authStatus, ownerId, hydrateSession, refreshBusinessConfig, refreshModules]);

    return <>{children}</>;
}
