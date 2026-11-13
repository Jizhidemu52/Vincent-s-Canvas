import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import "antd/dist/reset.css";
import "../../src/styles/globals.css";
import "../../src/styles/workbench.css";
import { UsageAnalyticsPanel } from "../../src/pages/admin/components/usage-analytics-panel";
import { useUserStore } from "../../src/stores/use-user-store";
import { setUiLocale, setUiPathname, useUiLocale } from "../../src/lib/i18n";
import { getAntThemeConfig } from "../../src/lib/app-theme";

useUserStore.setState({ status: "authenticated", user: { id: "00000000-0000-4000-8000-000000000098", username: "fixture", displayName: "Admin", role: "super_admin", status: "active", departmentId: null, creditBalance: 0, mustChangePassword: false, avatarUrl: "" } });
setUiPathname("/admin");
setUiLocale("en-US");
document.documentElement.style.overflow = "auto";
document.body.style.overflow = "visible";
document.body.style.height = "auto";
function Fixture() {
    const locale = useUiLocale();
    return <ConfigProvider theme={getAntThemeConfig(false)}><App><main className="mx-auto max-w-[1200px] space-y-4 p-4">
        <nav className="flex gap-3"><button type="button" onClick={() => setUiLocale("en-US")}>English</button><button type="button" onClick={() => setUiLocale("zh-CN")}>中文</button><span>{locale}</span></nav>
        <p>Synthetic local display test · no real API or model</p>
        <UsageAnalyticsPanel/>
    </main></App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
