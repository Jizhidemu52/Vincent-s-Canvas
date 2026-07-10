import type { ReactNode } from "react";
import { useEffect } from "react";

import { useUserStore } from "@/stores/use-user-store";
import { useAdminStore } from "@/stores/use-admin-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { AdminModelCapability, PricingRule } from "@/lib/admin-domain";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const authStatus = useUserStore((state) => state.status);
    const hydrateSession = useUserStore((state) => state.hydrateSession);

    useEffect(() => {
        if (authStatus !== "authenticated") return;
        const refreshBusinessConfig = async () => {
            const response = await fetch("/api/models", { credentials: "include" });
            if (!response.ok) return;
            const result = await response.json() as { prices: Array<{operationType:string;label:string;credits:number;rmbCost:number}>; models: Array<{id:string;name:string;modelId:string;capabilities:string[];creditCost:number;rmbCost:number}> };
            useAdminStore.setState({
                pricingRules: result.prices as PricingRule[],
                models: result.models.map((model) => ({ id:model.id,name:model.name,modelId:model.modelId,provider:"server",capabilities:model.capabilities as AdminModelCapability[],credits:model.creditCost,rmbCost:model.rmbCost,enabled:true })),
            });
            await Promise.allSettled(useCanvasStore.getState().projects.map((project)=>fetch("/api/projects/sync",{method:"POST",credentials:"include",headers:{"content-type":"application/json"},body:JSON.stringify({externalId:project.id,name:project.title})})));
        };
        const refresh = () => { void hydrateSession(); void refreshBusinessConfig(); };
        refresh();
        const timer = window.setInterval(refresh, 30_000);
        const onVisibility = () => { if (document.visibilityState === "visible") refresh(); };
        document.addEventListener("visibilitychange", onVisibility);
        return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); };
    }, [authStatus, hydrateSession]);

    return <>{children}</>;
}
