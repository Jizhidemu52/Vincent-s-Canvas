import type { ReactNode } from "react";
import { useEffect } from "react";
import { Navigate, useLocation } from "react-router-dom";

import type { ModuleKey } from "@/services/api/modules";
import { useModuleStore } from "@/stores/use-module-store";

export function ModuleGate({ children, moduleKey }: { children: ReactNode; moduleKey: ModuleKey | ((search: string) => ModuleKey) }) {
    const location = useLocation();
    const status = useModuleStore((state) => state.status);
    const refresh = useModuleStore((state) => state.refresh);
    const resolvedKey = typeof moduleKey === "function" ? moduleKey(location.search) : moduleKey;
    const enabled = useModuleStore((state) => state.flags[resolvedKey]);

    useEffect(() => { if (status === "idle") void refresh().catch(() => undefined); }, [refresh, status]);

    if (status === "idle" || status === "loading") {
        return <div className="flex h-full items-center justify-center bg-[#eeeeec]"><div className="size-6 animate-spin rounded-full border-2 border-orange-200 border-t-orange-600" /></div>;
    }
    if (!enabled) return <Navigate to="/" replace state={{ moduleDisabled: resolvedKey }} />;
    return <>{children}</>;
}
