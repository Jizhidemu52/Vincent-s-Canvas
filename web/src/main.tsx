import React, { useEffect, useRef, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "./styles/globals.css";
import { RouterProvider } from "react-router-dom";

import { ServiceUnavailable } from "@/components/auth/service-unavailable";
import { CompanyOaEntry } from "@/components/auth/company-oa-entry";
import { deploymentFeatures, loadDeploymentFeatures } from "@/lib/deployment-features";
import { consumeOaLoginToken } from "@/lib/oa-login";
import { prepareWorkspaceEntry } from "@/lib/workspace-entry";
import { subscribeWorkspaceIdentity } from "@/lib/workspace-session-events";
import { getWorkspaceIdentityDrainStatus, startWorkspaceIdentityDrain, subscribeWorkspaceIdentityDrain } from "@/lib/workspace-identity-drain";
import { useUserStore } from "@/stores/use-user-store";
import { isWorkspaceRole } from "../../shared/workspace-access";
import { initializeUiLocale, setUiPathname, useUiText } from "@/lib/i18n";

// Remove credentials before any network request, dynamic import or navigation.
let oaToken = consumeOaLoginToken(window.location, window.history);
const root = createRoot(document.getElementById("root")!);
function PreparingWorkspace() {
    const t = useUiText();
    return <main role="status" className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background text-sm text-muted-foreground"><p>{t("正在准备工作区…")}</p></main>;
}
function IdentityChangedWorkspace() {
    const t = useUiText();
    const status = useSyncExternalStore(subscribeWorkspaceIdentityDrain, getWorkspaceIdentityDrainStatus, getWorkspaceIdentityDrainStatus);
    const allowReload = useRef(false);
    const saving = status === "idle" || status === "saving";
    const failed = status === "failed";
    useEffect(() => {
        const beforeUnload = (event: BeforeUnloadEvent) => {
            if (allowReload.current || (!saving && !failed)) return;
            event.preventDefault(); event.returnValue = "";
        };
        window.addEventListener("beforeunload", beforeUnload);
        return () => window.removeEventListener("beforeunload", beforeUnload);
    }, [saving, failed]);
    const reload = () => {
        if (saving) return;
        if (failed && !window.confirm(t("旧账号草稿尚未确认保存。重新加载可能丢失未写入的修改。仍要继续？"))) return;
        allowReload.current = true;
        window.location.reload();
    };
    return <main role="alert" className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center text-foreground">
        <h1 className="text-xl font-semibold">{t("登录状态已变化，工作区已暂停")}</h1>
        <p className="max-w-md text-sm text-muted-foreground">{t("已停止旧账号的操作，页面不会自动刷新。")}</p>
        <p role="status" className="max-w-md text-sm text-muted-foreground">{t(saving ? "正在保存旧账号的本机草稿，请暂时保留此页面…"
            : failed ? "旧账号草稿未确认保存。请保留本页并联系管理员协助；重新加载可能丢失尚未写入的修改。"
            : "旧账号的本机保存检查已完成。可主动重新加载，重新验证登录状态。")}</p>
        {deploymentFeatures.oaLoginEnabled ? <p className="max-w-md text-sm text-muted-foreground">{t("如需重新登录，请从企业微信中的公司 OA 再次进入。")}</p> : null}
        <button type="button" className="rounded-lg bg-primary px-5 py-3 text-sm text-primary-foreground disabled:opacity-50" disabled={saving} onClick={reload}>{t(saving ? "等待草稿保存…" : "重新加载")}</button>
    </main>;
}
root.render(<PreparingWorkspace />);
const localeReady = initializeUiLocale();

document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

void loadDeploymentFeatures().then(async (loaded) => {
    await localeReady;
    if (!loaded) {
        oaToken = null;
        root.render(<ServiceUnavailable onRetry={() => window.location.reload()} />);
        return;
    }
    const preparing = prepareWorkspaceEntry(oaToken, window.location.pathname);
    oaToken = null;
    const entry = await preparing;
    if (entry === "oa-required") { root.render(<CompanyOaEntry />); return; }
    if (entry === "maintenance-login") {
        const { default: AdminLoginEntry } = await import("@/pages/admin/login-entry");
        root.render(<AdminLoginEntry />);
        return;
    }
    if (entry === "password-login") {
        const { default: PasswordLoginEntry } = await import("@/pages/login/login-entry");
        root.render(<PasswordLoginEntry />);
        return;
    }
    if (entry === "password-change") {
        const { default: PasswordChangeEntry } = await import("@/pages/change-password/entry");
        root.render(<PasswordChangeEntry />);
        return;
    }
    const sessionUser = deploymentFeatures.authenticationEnabled ? useUserStore.getState().user : null;
    const owner = sessionUser && isWorkspaceRole(sessionUser.role) ? sessionUser.id : null;
    let identityChanged = false;
    const renderIdentityChanged = () => {
        identityChanged = true;
        startWorkspaceIdentityDrain();
        root.render(<IdentityChangedWorkspace />);
    };
    if (sessionUser) {
        useUserStore.subscribe(({ user }) => {
            // Remove every mounted tool immediately. Canvas drains only its old
            // immutable employee partition before an explicit user reload.
            if (user?.id !== sessionUser.id || user.role !== sessionUser.role) {
                renderIdentityChanged();
            }
        });
        subscribeWorkspaceIdentity((nextOwner) => {
            if (owner && nextOwner === owner) return;
            useUserStore.getState().invalidateSession();
        });
    }
    const [{ AppProviders }, { router }] = await Promise.all([
        import("@/components/layout/app-providers"),
        import("@/router"),
    ]);
    if (identityChanged || (sessionUser && (useUserStore.getState().user?.id !== sessionUser.id || useUserStore.getState().user?.role !== sessionUser.role))) { renderIdentityChanged(); return; }
    setUiPathname(router.state.location.pathname);
    router.subscribe(state => setUiPathname(state.location.pathname));
    root.render(
        <React.StrictMode>
            <AppProviders>
                <RouterProvider router={router} />
            </AppProviders>
        </React.StrictMode>,
    );
});
