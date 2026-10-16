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

// Remove credentials before any network request, dynamic import or navigation.
let oaToken = consumeOaLoginToken(window.location, window.history);
const root = createRoot(document.getElementById("root")!);
root.render(<main role="status" className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">正在准备工作区…</main>);

document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

void loadDeploymentFeatures().then(async (loaded) => {
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
    const owner = deploymentFeatures.authenticationEnabled && entry === "workspace" ? useUserStore.getState().user?.id : null;
    const sessionUser = deploymentFeatures.authenticationEnabled ? useUserStore.getState().user : null;
    const renderIdentityChanged = () => root.render(deploymentFeatures.oaLoginEnabled ? <CompanyOaEntry />
        : <main role="status" className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background text-sm text-muted-foreground"><p>登录账号已变化，正在重新准备工作区…</p><button type="button" onClick={() => window.location.reload()}>重新加载</button></main>);
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
    root.render(
        <React.StrictMode>
            <AppProviders>
                <RouterProvider router={router} />
            </AppProviders>
        </React.StrictMode>,
    );
});
