import Papa from "papaparse";
import { uiText } from "./i18n";

/** Same schema-checked presentation projection as the Team report; the audited original stays intact. */
export function nonFinancialHistoryCsv(csv: string): string {
    const source = csv.replace(/^\uFEFF/, "");
    const parsed = Papa.parse<string[]>(source, { delimiter: ",", skipEmptyLines: true });
    const rows = parsed.data, header = rows[0];
    const expected = ["时间", "设计师", "部门", "项目", "操作", "模型", "提示词", "积分", "人民币成本", "状态", "失败原因", "原图", "结果图"];
    if (parsed.errors.length || !header || header.length !== expected.length || header.some((value, index) => value !== expected[index]) || rows.some(row => row.length !== header.length)) throw new Error(uiText("报表格式异常，请重新导出。"));
    const keep = header.map((value, index) => value === "积分" || value === "人民币成本" ? -1 : index).filter(index => index >= 0);
    return "\uFEFF" + Papa.unparse(rows.map(row => keep.map(index => row[index])), { quotes: true, newline: "\r\n" }) + (/\r?\n$/.test(source) ? "\r\n" : "");
}
