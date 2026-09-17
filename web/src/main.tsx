import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "./styles/globals.css";
import { RouterProvider } from "react-router-dom";

import { OaEntryNotice } from "@/components/auth/oa-entry-notice";
import { deploymentFeatures, loadDeploymentFeatures } from "@/lib/deployment-features";
import { consumeOaLoginToken } from "@/lib/oa-login";
import { useUserStore } from "@/stores/use-user-store";

let oaToken = consumeOaLoginToken(window.location, window.history);

document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

void loadDeploymentFeatures().then(async (loaded) => {
    if (!loaded) {
        oaToken = null;
        createRoot(document.getElementById("root")!).render(<OaEntryNotice unavailable />);
        return;
    }
    if (deploymentFeatures.oaLoginEnabled && oaToken !== null) {
        const exchange = useUserStore.getState().exchangeOaToken(oaToken);
        oaToken = null;
        await exchange;
    } else if (deploymentFeatures.oaLoginEnabled) {
        await useUserStore.getState().hydrateSession();
    }
    oaToken = null;
    // Persistent workspaces must not initialize until the OA owner is known.
    const { AppProviders } = await import("@/components/layout/app-providers");
    const { router } = await import("@/router");
    createRoot(document.getElementById("root")!).render(
        <React.StrictMode>
            <AppProviders>
                <RouterProvider router={router} />
            </AppProviders>
        </React.StrictMode>,
    );
});
