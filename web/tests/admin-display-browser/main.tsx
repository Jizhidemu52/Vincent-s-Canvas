import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App, ConfigProvider } from "antd";
import * as echarts from "echarts/core";
import type { EChartsOption } from "echarts";
import "antd/dist/reset.css";
import "../../src/styles/globals.css";
import "../../src/styles/workbench.css";
import UsageChart from "../../src/pages/admin/usage/chart";
import { CompilationResult } from "../../src/pages/admin/prompt-recipes/components/compilation-history";
import ReportActions from "../../src/pages/admin/usage/report-actions";
import { PerformanceDashboard } from "../../src/pages/performance/dashboard";
import { useUserStore } from "../../src/stores/use-user-store";
import { setUiLocale, setUiPathname, useUiLocale } from "../../src/lib/i18n";
import { getAntThemeConfig } from "../../src/lib/app-theme";
import type { AdminPromptCompilation } from "../../../shared/prompt-contracts";

useUserStore.setState({ status: "authenticated", user: { id: "00000000-0000-4000-8000-000000000099", username: "fixture", displayName: "Admin", role: "super_admin", status: "active", departmentId: null, creditBalance: 0, mustChangePassword: false, avatarUrl: "" } });
setUiPathname("/admin");
await setUiLocale(new URLSearchParams(location.search).get("locale") === "zh" ? "zh-CN" : "en-US");
document.documentElement.style.overflow = "auto";
document.body.style.overflow = "visible";
document.body.style.height = "auto";
const option: EChartsOption = { grid: { left: 90, right: 40, top: 50, bottom: 60 },
    xAxis: { type: "category", name: "团队", data: ["开发组"] }, yAxis: { type: "value", name: "提交到完成 ms" }, legend: { data: ["成果"] },
    series: [{ type: "bar", name: "成果", data: [12] }] };
const compilation: AdminPromptCompilation = { id: "compilation", requestId: "原始请求标识", status: "success", optimized: false,
    userId: "fixture", recipeKey: "fixture", recipeVersionId: "version", modelConfigId: "原始模型标识", targetModelConfigId: "target",
    summaryZh: "开发摘要", prompt: "保留图案形状", inputSnapshot: { promptInput: { scene: "product-design", mode: "image", fields: { description: "隐藏快照说明", apiKey: "保密令牌", code: "保留程序代码", url: "https://example.invalid/原路径" }, userText: "隐藏输入描述", referenceRoles: [], hasMask: false }, sourceUrls: [] },
    inputHash: "hash", reusedFromId: null, cacheHit: false, rawResponse: JSON.stringify({ summary: "隐藏响应说明", token: "保留令牌", code: "原始代码" }), latencyMs: 15,
    inputTokens: null, outputTokens: null, actualCost: null, estimatedCost: null, currency: "CNY", createdAt: "2026-11-13T00:00:00Z", completedAt: "2026-11-13T00:00:01Z" };
const original = JSON.stringify({ option, compilation });
Object.assign(window, { adminDisplayFixture: { original, current: () => JSON.stringify({ option, compilation }), readChart: () => {
    const element = document.querySelector<HTMLElement>("[data-usage-chart]")!;
    const chart = echarts.getInstanceByDom(element)!;
    const actual = chart.getOption() as any;
    return { category: actual.xAxis[0].data[0], seriesName: actual.series[0].name, axisLabel: actual.xAxis[0].axisLabel.formatter("开发组"),
        legendLabel: actual.legend[0].formatter("成果"), axisName: actual.yAxis[0].name,
        tooltip: actual.tooltip[0].formatter({ name: "开发组", seriesName: "成果", value: 12 }),
        point: chart.convertToPixel({ seriesIndex: 0 }, [0, 6]) };
} } });
function Fixture() {
    const locale = useUiLocale(), [selected, setSelected] = useState("");
    const view = new URLSearchParams(location.search).get("view") || "chart";
    return <ConfigProvider theme={getAntThemeConfig(false)}><App><BrowserRouter><main className="mx-auto max-w-[1200px] space-y-4 p-4">
        <nav className="flex gap-3"><button type="button" onClick={() => setUiLocale("en-US")}>English</button><button type="button" onClick={() => setUiLocale("zh-CN")}>中文</button><span>{locale}</span></nav>
        <p>Synthetic local display test · no real API or model</p>
        {view === "chart" ? <><UsageChart option={option} label="部门产出" height={360} onSelect={(index, name) => setSelected(JSON.stringify({ index, name }))}/><output data-testid="chart-selection">{selected}</output></> : null}
        {view === "compilation" ? <CompilationResult compilation={compilation}/> : null}
        {view === "report" ? <ReportActions page="overview" query={{ from: "2026-10-01T00:00:00.000Z", to: "2026-10-08T00:00:00.000Z", compare: "none" }} disabled={false} scopeText="Fixture scope"/> : null}
        {view === "performance" ? <PerformanceDashboard/> : null}
    </main></BrowserRouter></App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
