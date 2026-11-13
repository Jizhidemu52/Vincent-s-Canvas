import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { setUiLocale, uiText } from "../src/lib/i18n";
import { MetricCards } from "../src/pages/admin/usage/components";
import { peopleComparisonExport } from "../src/pages/admin/usage/people-comparison";
import { departmentComparisonRows, departmentDifference } from "../src/pages/admin/usage/department-comparison";
import { comparisonText, metricCoverageText, metricLabels, metricText, snapshotText } from "../src/pages/admin/usage/format";
import { comparison, departments, overview } from "./usage-helper-display-browser/data";

test("English presentation does not alter Chinese comparison exports, metric formatting, IDs or source data", async () => {
    const source = JSON.stringify({ comparison, departments, overview });
    const formatted = () => JSON.stringify({
        people: peopleComparisonExport(comparison), departments: departmentComparisonRows(departments[0], departments[1]),
        difference: departmentDifference(departments[0].metrics.successRate, departments[1].metrics.successRate),
        metric: metricText(overview.metrics.totalMsP50), coverage: metricCoverageText(overview.metrics.resultUseRate),
        snapshot: snapshotText(overview.meta), prior: comparisonText(overview.metrics.successRate),
    });
    const original = formatted();
    try {
        await setUiLocale("en-US");
        expect(formatted()).toBe(original);
        expect(original).toContain("25.0 秒"); expect(original).toContain("+20.0 个百分点");
        expect(original).toContain("隔离比较员工甲"); expect(original).toContain("可用样本");
        expect(JSON.stringify({ comparison, departments, overview })).toBe(source);
        await setUiLocale("zh-CN");
        expect(formatted()).toBe(original);
    } finally { await setUiLocale("zh-CN"); }
});

test("translated metric cards retain their exact original data-usage-metric diagnostics", async () => {
    const render = () => renderToStaticMarkup(<MetricCards metrics={overview.metrics} keys={["activeSeconds", "totalMsP50", "successRate"]}/>);
    try {
        await setUiLocale("zh-CN"); const original = render();
        const attributes = (html: string) => [...html.matchAll(/data-usage-metric="([^"]*)"/g)].map(match => match[1]);
        await setUiLocale("en-US"); const english = render();
        expect(attributes(english)).toEqual(attributes(original));
        expect(attributes(english)).toHaveLength(3);
        await setUiLocale("zh-CN"); expect(render()).toBe(original);
    } finally { await setUiLocale("zh-CN"); }
});

test("every fixed metric label has English coverage and restores its exact Chinese original", async () => {
    const labels = [...Object.values(metricLabels), "个人活跃天数／团队活跃人日", "每位有记录活跃员工的已记账金额"];
    try {
        await setUiLocale("en-US");
        for (const label of labels) expect(uiText(label)).not.toMatch(/[\u3400-\u9fff]/);
        await setUiLocale("zh-CN");
        for (const label of labels) expect(uiText(label)).toBe(label);
    } finally { await setUiLocale("zh-CN"); }
});
