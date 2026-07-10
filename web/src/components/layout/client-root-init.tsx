import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { App } from "antd";

import { useCanManageConfig } from "@/hooks/use-can-manage-config";
import { createModelChannel, useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const handledConfigParams = useRef(false);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const config = useConfigStore((state) => state.config);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const canManageConfig = useCanManageConfig();
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

    useEffect(() => {
        if (handledConfigParams.current) return;
        if (!canManageConfig) return;
        const searchParams = new URLSearchParams(window.location.search);
        const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
        const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
        if (!baseUrl && !apiKey) return;
        handledConfigParams.current = true;
        searchParams.delete("baseUrl");
        searchParams.delete("baseurl");
        searchParams.delete("apiKey");
        searchParams.delete("apikey");
        window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);
        const firstChannel = config.channels[0];
        updateConfig(
            "channels",
            firstChannel
                ? config.channels.map((channel, index) =>
                      index === 0
                          ? {
                                ...channel,
                                ...(baseUrl ? { baseUrl } : {}),
                                ...(apiKey ? { apiKey } : {}),
                            }
                          : channel,
                  )
                : [createModelChannel({ id: "default", name: "默认渠道", baseUrl: baseUrl || undefined, apiKey: apiKey || "" })],
        );
        if (baseUrl) updateConfig("baseUrl", baseUrl);
        if (apiKey) updateConfig("apiKey", apiKey);
        openConfigDialog(false);
        message.success("已导入本地直连配置");
    }, [canManageConfig, config.channels, message, openConfigDialog, updateConfig]);

    return <>{children}</>;
}
