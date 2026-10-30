import { uiText, useUiLocale } from "@/lib/i18n";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";

import type { ModuleKey } from "@/services/api/modules";
import { useModuleEnabled, useModuleStore } from "@/stores/use-module-store";
import { standaloneEdition } from "@/lib/standalone-edition";
import { shouldBypassStandaloneModuleGate } from "@/lib/standalone-access";

export function ModuleGate({ children, moduleKey }: { children: ReactNode; moduleKey: ModuleKey | ((search: string) => ModuleKey) }) {
    useUiLocale();
    if (shouldBypassStandaloneModuleGate(standaloneEdition)) return <>{children}</>;
    return <EnabledModuleGate moduleKey={moduleKey}>{children}</EnabledModuleGate>;
}

function EnabledModuleGate({ children, moduleKey }: { children: ReactNode; moduleKey: ModuleKey | ((search: string) => ModuleKey) }) {
    useUiLocale();
    const location = useLocation();
    const status = useModuleStore((state) => state.status);
    const refresh = useModuleStore((state) => state.refresh);
    const resolvedKey = typeof moduleKey === "function" ? moduleKey(location.search) : moduleKey;
    const enabled = useModuleEnabled(resolvedKey);

    useEffect(() => { if (status === "idle") void refresh().catch(() => undefined); }, [refresh, status]);

    if (status === "idle" || status === "loading") {
        return <div className="flex h-full items-center justify-center bg-background" role="status">{uiText("正在加载模块配置…")}</div>;
    }
    if (status === "error") return <div className="flex h-full flex-col items-center justify-center gap-3 bg-background" role="alert"><p>{uiText("模块配置暂时无法加载，尚未确认模块是否可用。")}</p><button type="button" className="underline" onClick={() => void refresh().catch(() => undefined)}>{uiText("重新加载")}</button></div>;
    if (!enabled) return <main role="alert" className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center"><h1 className="text-xl font-semibold">{uiText("此功能暂未开放")}</h1><p className="text-sm text-muted-foreground">{uiText("管理员已关闭此功能，或尚未配置可用模型。已有作品不会因此删除，请联系管理员。")}</p><Link to="/" className="underline">{uiText("返回工作台")}</Link><button type="button" className="underline" onClick={() => void refresh().catch(() => undefined)}>{uiText("重新检查")}</button></main>;
    return <>{children}</>;
}
