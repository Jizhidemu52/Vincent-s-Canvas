import type { ReactNode } from "react";
import { useEffect } from "react";
import { Navigate, useLocation } from "react-router-dom";

import type { ModuleKey } from "@/services/api/modules";
import { useModuleEnabled, useModuleStore } from "@/stores/use-module-store";
import { standaloneEdition } from "@/lib/standalone-edition";
import { shouldBypassStandaloneModuleGate } from "@/lib/standalone-access";

export function ModuleGate({ children, moduleKey }: { children: ReactNode; moduleKey: ModuleKey | ((search: string) => ModuleKey) }) {
    if (shouldBypassStandaloneModuleGate(standaloneEdition)) return <>{children}</>;
    return <EnabledModuleGate moduleKey={moduleKey}>{children}</EnabledModuleGate>;
}

function EnabledModuleGate({ children, moduleKey }: { children: ReactNode; moduleKey: ModuleKey | ((search: string) => ModuleKey) }) {
    const location = useLocation();
    const status = useModuleStore((state) => state.status);
    const refresh = useModuleStore((state) => state.refresh);
    const resolvedKey = typeof moduleKey === "function" ? moduleKey(location.search) : moduleKey;
    const enabled = useModuleEnabled(resolvedKey);

    useEffect(() => { if (status === "idle") void refresh().catch(() => undefined); }, [refresh, status]);

    if (status === "idle" || status === "loading") {
        return <div className="flex h-full items-center justify-center bg-background" role="status">正在加载模块配置…</div>;
    }
    if (status === "error") return <div className="flex h-full flex-col items-center justify-center gap-3 bg-background" role="alert"><p>模块配置暂时无法加载，尚未确认模块是否可用。</p><button type="button" className="underline" onClick={() => void refresh().catch(() => undefined)}>重新加载</button></div>;
    if (!enabled) return <Navigate to="/" replace state={{ moduleDisabled: resolvedKey }} />;
    return <>{children}</>;
}
