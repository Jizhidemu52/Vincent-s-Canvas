import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { UsageV2Overview } from "../src/services/api/usage-analytics-v2";
import DepartmentComparison, { departmentComparisonRows, departmentDifference } from "../src/pages/admin/usage/department-comparison";
import { fixture } from "./usage-v2-browser/fixture";

const overview = () => fixture(new URL("http://localhost/api/admin/usage/overview")) as UsageV2Overview;
test("department differences use percentage points, suppress missing coverage and keep zero baseline explicit", () => {
    const metric = overview().metrics.successRate;
    expect(departmentDifference({ ...metric, value: 0.8 }, { ...metric, value: 0.5 })).toBe("+30.0 个百分点");
    expect(departmentDifference({ ...metric, value: 0.4 }, { ...metric, value: 0.5 })).toBe("−10.0 个百分点");
    expect(departmentDifference({ ...metric, state: "partial" }, metric)).toContain("不计算");
    expect(departmentDifference({ ...metric, missingCount: 1 }, metric)).toContain("不计算");
    expect(departmentDifference({ ...metric, value: null }, metric)).toContain("不计算");
    expect(departmentDifference({ ...metric, definitionId: "other" }, metric)).toContain("口径不同");
    expect(departmentDifference({ ...metric, unit: "count", value: 5 }, { ...metric, unit: "count", value: 0 })).toBe("+5；B 为 0，不计算相对差异");
});
test("department rows retain aggregate rates and use active-person denominator, not averages", () => {
    const data = overview();
    const a = { key: "a", label: "甲部", metrics: { ...data.metrics, activePeople: { ...data.metrics.activePeople, value: 2 } } };
    const b = { key: "b", label: "乙部", metrics: { ...data.metrics, activePeople: { ...data.metrics.activePeople, value: 4 } } };
    const rows = departmentComparisonRows(a, b);
    expect(rows.find((row) => row.key === "successRate")?.a).toBe(a.metrics.successRate);
    const perPerson = rows.find((row) => row.key === "perActivePerson")!;
    expect(perPerson.a.value).toBe(6.3);
    expect(perPerson.a.denominator).toBe(2);
    expect(perPerson.b.value).toBe(3.15);
    expect(perPerson.difference).toContain("100.0%");
});
test("department comparison renders only known departments and does not invent missing peers", () => {
    const data = overview();
    const a = { key: "a", label: "甲部", metrics: data.metrics };
    const b = { key: "b", label: "乙部", metrics: data.metrics };
    const unknown = { key: "unknown-department", label: "未知归属", metrics: data.metrics };
    const html = renderToStaticMarkup(<DepartmentComparison departments={[a, unknown, b]} meta={data.meta} />);
    for (const label of ["部门 A/B 同周期对照", "A · 甲部", "B · 乙部", "差异 A − B", "导出部门对照 Excel", "不平均个人百分比", "覆盖不完整，不计算差异"]) expect(html).toContain(label);
    expect(html).not.toContain("未知归属");
    const empty = renderToStaticMarkup(<DepartmentComparison departments={[a, unknown]} meta={data.meta} />);
    expect(empty).toContain("至少两个有记录的已知部门");
    expect(empty).not.toContain("ant-table");
});
