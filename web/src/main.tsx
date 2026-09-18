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
    const owner = deploymentFeatures.oaLoginEnabled && entry === "workspace" ? useUserStore.getState().user?.id : null;
    let workspaceLoaded = false;
    if (owner) {
        useUserStore.subscribe(({ user }) => {
            // Remove every mounted tool immediately. Canvas drains only its old
            // immutable employee partition before restarting the whole app.
            if (user?.id !== owner || user.role !== "designer") root.render(<CompanyOaEntry />);
        });
        subscribeWorkspaceIdentity((nextOwner) => {
            if (nextOwner === owner) return;
            useUserStore.getState().invalidateSession();
            // Once loaded, the canvas owner boundary flushes its immutable old
            // partition and restarts. Before imports there is no work to drain.
            if (!workspaceLoaded) window.location.reload();
        });
    }
    const { AppProviders } = await import("@/components/layout/app-providers");
    workspaceLoaded = true;
    const { router } = await import("@/router");
    if (owner && useUserStore.getState().user?.id !== owner) { root.render(<CompanyOaEntry />); return; }
    root.render(
        <React.StrictMode>
            <AppProviders>
                <RouterProvider router={router} />
            </AppProviders>
        </React.StrictMode>,
    );
});
