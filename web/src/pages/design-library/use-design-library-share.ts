import { useUiText } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import { App } from "antd";
import { useNavigate } from "react-router-dom";
import { deploymentFeatures } from "@/lib/deployment-features";
import { useModuleEnabled } from "@/stores/use-module-store";
import { useUserStore } from "@/stores/use-user-store";
import type { DesignLibraryShareSource } from "./share-draft";

export function useDesignLibraryShare() {
    const t = useUiText();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const user = useUserStore(state => state.user);
    const enabled = useModuleEnabled("design-library");
    const [busy, setBusy] = useState(false);
    const pending = useRef<AbortController | null>(null);
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; pending.current?.abort(); }; }, []);
    const canShare = enabled && deploymentFeatures.oaLoginEnabled && user?.role === "designer" && user.status === "active";
    const share = async (source: DesignLibraryShareSource) => {
        if (!canShare || pending.current) return;
        const controller = new AbortController(); pending.current = controller; setBusy(true);
        const unsubscribe = useUserStore.subscribe(state => {
            if (state.status !== "authenticated" || state.user?.id !== source.ownerId || state.user.role !== "designer" || state.user.status !== "active") controller.abort();
        });
        try {
            const { prepareDesignLibraryShareDraft } = await import("./prepare-share");
            const result = await prepareDesignLibraryShareDraft(source, AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]));
            if (controller.signal.aborted || !alive.current) return;
            if (result.savedPrivateCopy) message.info(t("原图已保存为本人私有素材，请核对草稿后再确认公开"));
            navigate("/design-library?publish=1", { state: { designLibraryDraft: result.draft } });
        } catch (error) {
            if (!controller.signal.aborted && alive.current && useUserStore.getState().user?.id === source.ownerId) message.error(error instanceof Error ? error.message : t("分享草稿准备失败，请重试"));
        } finally {
            unsubscribe(); if (pending.current === controller) pending.current = null;
            if (alive.current) setBusy(false);
        }
    };
    return { canShare, busy, share };
}
