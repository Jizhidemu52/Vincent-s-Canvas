import React from "react";
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
import { useUserStore } from "@/stores/use-user-store";
import { isWorkspaceRole } from "../../shared/workspace-access";
import { initializeUiLocale, setUiPathname, useUiText } from "@/lib/i18n";

// Remove credentials before any network request, dynamic import or navigation.
let oaToken = consumeOaLoginToken(window.location, window.history);
const root = createRoot(document.getElementById("root")!);
function PreparingWorkspace({ changed = false }: { changed?: boolean }) {
    const t = useUiText();
    return <main role="status" className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background text-sm text-muted-foreground"><p>{t(changed ? "登录账号已变化，正在重新准备工作区…" : "正在准备工作区…")}</p>{changed ? <button type="button" onClick={() => window.location.reload()}>{t("重新加载")}</button> : null}</main>;
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
    const renderIdentityChanged = () => root.render(deploymentFeatures.oaLoginEnabled ? <CompanyOaEntry />
        : <PreparingWorkspace changed />);
    let workspaceLoaded = false;
    if (sessionUser) {
        useUserStore.subscribe(({ user }) => {
            // Remove every mounted tool immediately. Canvas drains only its old
            // immutable employee partition before restarting the whole app.
            if (user?.id !== sessionUser.id || user.role !== sessionUser.role) {
                renderIdentityChanged();
                if (!owner || !workspaceLoaded) window.location.reload();
            }
        });
        subscribeWorkspaceIdentity((nextOwner) => {
            if (owner && nextOwner === owner) return;
            useUserStore.getState().invalidateSession();
            // Once loaded, the canvas owner boundary flushes its immutable old
            // partition and restarts. Before imports there is no work to drain.
            if (!owner || !workspaceLoaded) window.location.reload();
        });
    }
    const [{ AppProviders }, { router }] = await Promise.all([
        import("@/components/layout/app-providers"),
        import("@/router"),
    ]);
    workspaceLoaded = true;
    if (sessionUser && (useUserStore.getState().user?.id !== sessionUser.id || useUserStore.getState().user?.role !== sessionUser.role)) { renderIdentityChanged(); return; }
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
