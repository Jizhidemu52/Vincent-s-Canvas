import { displayNotice, useDisplayText } from "@/hooks/use-display-text";
import { uiText, useUiLocale } from "@/lib/i18n";
import { App, Popover, Tooltip } from "antd";
import { KeyRound, LoaderCircle, LogOut } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { deploymentFeatures } from "@/lib/deployment-features";
import { flushCanvasCloudPersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";

// The desktop footer and mobile drawer can both be mounted at once.
let logoutInFlight = false;

export function PersonalSessionActions({ onSignedOut, compact = false }: { onSignedOut?: () => void; compact?: boolean }) {
    useUiLocale();
    const display = useDisplayText();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const user = useUserStore(state => state.user);
    const status = useUserStore(state => state.status);
    const [busy, setBusy] = useState(false);

    if (!deploymentFeatures.authenticationEnabled || deploymentFeatures.oaLoginEnabled || status !== "authenticated" || !user) return null;
    const name = user.displayName ? display(user.displayName) : user.username;

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
            message.error(displayNotice(error instanceof Error ? error.message : uiText("退出登录失败，请稍后重试。")));
        } finally {
            logoutInFlight = false;
            setBusy(false);
        }
    };

    const actions = (
        <div className="mt-2 flex items-center gap-2 border-t border-stone-200 px-2 pt-3" aria-label={uiText("个人账号")}>
            <div className="min-w-0 flex-1">
                <Tooltip title={name}><div className="truncate text-xs font-medium text-foreground">{name}</div></Tooltip>
                <div className="mt-0.5 text-xs text-muted-foreground">{uiText("个人账号")}</div>
            </div>
            <Tooltip title={uiText("修改密码")}><span className="inline-flex"><button type="button" className="wb-nav-link inline-flex size-9 items-center justify-center rounded-md" disabled={busy} aria-label={uiText("修改密码")} onClick={() => navigate(`/change-password?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`)}><KeyRound className="size-3.5" /></button></span></Tooltip>
            <Tooltip title={uiText("保存画布并退出登录")}><span className="inline-flex"><button
                type="button"
                className="wb-nav-link inline-flex h-9 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-xs disabled:cursor-wait disabled:opacity-60"
                onClick={signOut}
                disabled={busy}
                aria-label={uiText("退出登录")}
                aria-busy={busy}
            >
                {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <LogOut className="size-3.5" />}
                {busy ? uiText("退出中") : uiText("退出")}
            </button></span></Tooltip>
        </div>
    );
    return compact ? <Popover content={actions} trigger="click" placement="topRight"><Tooltip title={name}><button type="button" className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold" aria-label={uiText("个人账号")}>{(name || "U").slice(0, 1)}</button></Tooltip></Popover> : actions;
}
