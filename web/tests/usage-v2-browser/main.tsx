import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import "antd/dist/reset.css";
import "../../src/styles/globals.css";
import "../../src/styles/workbench.css";
import UsageAnalyticsDashboard from "../../src/pages/admin/usage";
import { getAntThemeConfig } from "../../src/lib/app-theme";
import { useUserStore } from "../../src/stores/use-user-store";
const params = new URLSearchParams(location.search),
    dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.overflow = "auto";
document.body.style.overflow = "visible";
document.body.style.height = "auto";
document.body.classList.add("wb-app");
useUserStore.setState({
    status: "authenticated",
    user: {
        id: "00000000-0000-4000-8000-000000000099",
        username: "isolated",
        displayName: "隔离验证管理员",
        role: params.get("role") === "designer" ? "designer" : "super_admin",
        departmentId: null,
        status: "active",
        mustChangePassword: false,
        creditBalance: 0,
        avatarUrl: "",
    },
});
createRoot(document.getElementById("root")!).render(
    <ConfigProvider locale={zhCN} theme={getAntThemeConfig(dark)}>
        <App>
            <BrowserRouter>
                <main className="wb-page mx-auto min-h-screen max-w-[1560px] p-3 sm:p-6">
                    <p className="mb-3 text-xs text-[var(--muted-foreground)]">隔离合成测试数据 · 不连接正式 API、不调用模型、不代表生产验收</p>
                    <UsageAnalyticsDashboard />
                </main>
            </BrowserRouter>
        </App>
    </ConfigProvider>,
);
