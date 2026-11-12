import { expect, test } from "bun:test";
import Papa from "papaparse";
import { nonFinancialHistoryCsv } from "../src/lib/non-financial-history-csv";

const header = ["时间", "设计师", "部门", "项目", "操作", "模型", "提示词", "积分", "人民币成本", "状态", "失败原因", "原图", "结果图"];
const row = ["2026-11-12T01:00:00Z", "设计师甲", "开发部", "'@project", "image_generation", "模型A", '设计报价99元,"保留引号"\n价格文字不删😀', "7", "0.125", "success", "", "https://example.invalid/source.png", "https://example.invalid/result.png"];
const input = (rows: string[][]) => "\uFEFF" + Papa.unparse(rows, { quotes: true, newline: "\r\n" });

test("admin history CSV hides only the two finance columns and preserves every other cell and row order", () => {
    const csv = nonFinancialHistoryCsv(input([header, row, [...row.slice(0, 6), "'=1+1", ...row.slice(7)]]));
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(Papa.parse<string[]>(csv).data).toEqual([
        ["时间", "设计师", "部门", "项目", "操作", "模型", "提示词", "状态", "失败原因", "原图", "结果图"],
        ["2026-11-12T01:00:00Z", "设计师甲", "开发部", "'@project", "image_generation", "模型A", '设计报价99元,"保留引号"\n价格文字不删😀', "success", "", "https://example.invalid/source.png", "https://example.invalid/result.png"],
        ["2026-11-12T01:00:00Z", "设计师甲", "开发部", "'@project", "image_generation", "模型A", "'=1+1", "success", "", "https://example.invalid/source.png", "https://example.invalid/result.png"],
    ]);
    expect(csv).not.toContain('"人民币成本"');
    expect(csv).not.toContain('"0.125"');
});

test("history projection keeps valid empty exports but refuses changed schemas and malformed rows", () => {
    expect(Papa.parse<string[]>(nonFinancialHistoryCsv(input([header]))).data[0]).toHaveLength(11);
    for (const invalid of [input([[...header, "新金额"], [...row, "9"]]), input([header, row.slice(1)]), input([header.slice(1), row.slice(1)]), input([header, row]) + '\r\n"unterminated']) {
        expect(() => nonFinancialHistoryCsv(invalid)).toThrow();
    }
});
