import { uiText, useUiLocale } from "@/lib/i18n";
import { App } from "antd";
import { LoaderCircle, LogOut } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { deploymentFeatures } from "@/lib/deployment-features";
import { flushCanvasCloudPersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";

// The desktop footer and mobile drawer can both be mounted at once.
let logoutInFlight = false;

export function PersonalSessionActions({ onSignedOut }: { onSignedOut?: () => void }) {
    useUiLocale();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const user = useUserStore(state => state.user);
    const status = useUserStore(state => state.status);
    const [busy, setBusy] = useState(false);

    if (!deploymentFeatures.authenticationEnabled || deploymentFeatures.oaLoginEnabled || status !== "authenticated" || !user) return null;

    const signOut = async () => {
        if (logoutInFlight || useUserStore.getState().user?.id !== user.id || useUserStore.getState().status !== "authenticated") return;
        logoutInFlight = true;
        setBusy(true);
        try {
            // Always flush: a debounced local write may not yet have changed
            // cloudStatus from "synced" to "pending".
            await flushCanvasCloudPersistence();
            if (useUserStore.getState().user?.id !== user.id || useUserStore.getState().status !== "authenticated") return;
            const { cloudStatus, cloudError } = useCanvasStore.getState();
            // Cloud flush records failures in the store instead of throwing.
            if (cloudStatus !== "synced" && cloudStatus !== "local") {
                throw new Error(cloudError || uiText("画布尚未保存完成，请稍后重试退出登录。"));
            }
            await useUserStore.getState().clearSession();
            const session = useUserStore.getState();
            if (session.user || session.status !== "guest") return;
            onSignedOut?.();
            navigate("/login", { replace: true });
        } catch (error) {
            message.error(error instanceof Error ? error.message : uiText("退出登录失败，请稍后重试。"));
        } finally {
            logoutInFlight = false;
            setBusy(false);
        }
    };

    return (
        <div className="mt-2 flex items-center gap-2 border-t border-stone-200 px-2 pt-3" aria-label={uiText("个人账号")}>
            <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-foreground" title={user.displayName || user.username}>{user.displayName || user.username}</div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">{uiText("个人账号")}</div>
            </div>
            <button
                type="button"
                className="wb-nav-link inline-flex h-9 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-xs disabled:cursor-wait disabled:opacity-60"
                onClick={signOut}
                disabled={busy}
                aria-label={uiText("退出登录")}
                aria-busy={busy}
                title={uiText("保存画布并退出登录")}
            >
                {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <LogOut className="size-3.5" />}
                {busy ? uiText("退出中") : uiText("退出")}
            </button>
        </div>
    );
}
