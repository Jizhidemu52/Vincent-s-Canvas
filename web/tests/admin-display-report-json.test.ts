import { expect, test } from "bun:test";
import { displayUsageReportJson } from "../src/pages/admin/usage/report-actions";
import { displayValue } from "../src/lib/display-value";

test("opt-in v2 report JSON translates its schema-known prose and anonymous labels without changing technical values", () => {
    const original = { schemaVersion: 2, reportVersion: "usage-report-v2.1", instructions: "按证据阅读", warnings: ["不是因果", "existing-warning"],
        title: "报告标题", modelId: "原始模型标识", apiKey: "保留密钥", metrics: { requested: { value: 12, state: "available", unit: "count" } },
        tables: [{ id: "departments", title: "匿名分组", columns: ["匿名标签", "次数", "状态"], rows: [["部门组 1", 12, "available", null], ["模型组 2 · 图片", 3.125, "partial", "1.20000"]] }] };
    const before = JSON.stringify(original), seen: string[] = [];
    const dictionary: Record<string, string> = { "按证据阅读": "Read the evidence", "不是因果": "Not causation", "报告标题": "Report title", "匿名分组": "Anonymous groups", "匿名标签": "Anonymous label", "次数": "Count", "状态": "State", "部门组 1": "Department group 1", "模型组 2 · 图片": "Model group 2 · Image" };
    const translate = (text: string) => { seen.push(text); return dictionary[text] ?? text; };
    const result = displayUsageReportJson(original, translate, value => displayValue(value, translate)) as typeof original;
    expect(JSON.stringify(original)).toBe(before);
    expect(result.instructions).toBe("Read the evidence");
    expect(result.warnings).toEqual(["Not causation", "existing-warning"]);
    expect(result.tables[0].columns).toEqual(["Anonymous label", "Count", "State"]);
    expect(result.tables[0].rows).toEqual([["Department group 1", 12, "available", null], ["Model group 2 · Image", 3.125, "partial", "1.20000"]]);
    expect(result.tables[0].id).toBe("departments");
    expect(result.modelId).toBe("原始模型标识");
    expect(result.apiKey).toBe("保留密钥");
    expect(result.metrics).toEqual(original.metrics);
    for (const protectedValue of ["原始模型标识", "保留密钥", "available", "partial", "1.20000", "departments"]) expect(seen).not.toContain(protectedValue);
});

test("unknown report schemas do not opt their special fields into translation", () => {
    const original = { schemaVersion: 9, reportVersion: "future", warnings: ["未知来源"], instructions: "未知规则", tables: [{ id: "future", columns: ["未知列"], rows: [["未知原值"]] }] };
    const seen: string[] = [], translate = (text: string) => { seen.push(text); return "translated"; };
    expect(displayUsageReportJson(original, translate, value => displayValue(value, translate))).toEqual(original);
    expect(seen).toEqual([]);
});
