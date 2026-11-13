import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import "antd/dist/reset.css";
import "../../src/styles/globals.css";
import "../../src/styles/workbench.css";
import PeopleComparison from "../../src/pages/admin/usage/people-comparison";
import DepartmentComparison from "../../src/pages/admin/usage/department-comparison";
import { Coverage, DimensionTable, Insights, MetricCards } from "../../src/pages/admin/usage/components";
import { OptimizationMetrics } from "../../src/pages/admin/usage/quality";
import { useUserStore } from "../../src/stores/use-user-store";
import { setUiLocale, setUiPathname, useUiLocale } from "../../src/lib/i18n";
import { getAntThemeConfig } from "../../src/lib/app-theme";
import { comparison, departments, insights, original, overview } from "./data";

useUserStore.setState({ status: "authenticated", user: { id: "00000000-0000-4000-8000-000000000096", username: "fixture", displayName: "Admin", role: "super_admin", status: "active", departmentId: null, creditBalance: 0, mustChangePassword: false, avatarUrl: "" } });
setUiPathname("/admin");
setUiLocale("zh-CN");
document.documentElement.style.overflow = "auto";
document.body.style.overflow = "visible";
document.body.style.height = "auto";
Object.assign(window, { usageHelperFixture: { original, current: () => JSON.stringify({ overview, comparison, departments, insights }) } });
function Fixture() {
    const locale = useUiLocale(), [selected, setSelected] = useState("");
    const helpers = new URLSearchParams(location.search).get("view") === "helpers";
    return <ConfigProvider theme={getAntThemeConfig(false)}><App><main className="mx-auto max-w-[1200px] space-y-4 p-4">
        <nav className="flex gap-3"><button type="button" onClick={() => setUiLocale("en-US")}>English</button><button type="button" onClick={() => setUiLocale("zh-CN")}>中文</button><span>{locale}</span></nav>
        <p>Synthetic local display test · no real API or model</p><output data-testid="selection">{selected}</output>
        {helpers ? <>
            <MetricCards metrics={comparison.people[0].metrics} keys={["activeSeconds", "totalMsP50", "successRate"]}/>
            <section data-testid="optimization"><OptimizationMetrics metrics={overview.metrics}/></section>
            <Coverage meta={overview.meta}/>
            <Insights items={insights} fallback="" onDrilldown={value => setSelected(JSON.stringify(value))}/>
            <DimensionTable rows={departments} label="测试维度" keys={["totalMsP50", "resultUseRate"]} onSelect={row => setSelected(row.key)}/>
        </> : <>
            <PeopleComparison data={comparison} onProfile={setSelected}/>
            <DepartmentComparison departments={departments} meta={overview.meta}/>
        </>}
    </main></App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
