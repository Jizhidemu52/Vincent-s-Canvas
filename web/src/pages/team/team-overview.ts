import { uiText } from "@/lib/i18n";
import Papa from "papaparse";
import { getTeamAudit, getTeamHistory, getTeamOverview } from "@/services/api/groups";
import { getServerAssetOverview } from "@/services/api/server-assets";

export async function loadTeamOverview(isLeader: boolean) {
    const [overview, history, assets, audit] = await Promise.allSettled([
        isLeader ? getTeamOverview() : Promise.resolve(undefined),
        isLeader ? getTeamHistory() : Promise.resolve(undefined),
        isLeader ? getServerAssetOverview() : Promise.resolve(undefined),
        isLeader ? getTeamAudit() : Promise.resolve(undefined),
    ]);
    const errors = [overview, history, assets, audit].flatMap((result, index) => result.status === "rejected" ? [`${[uiText("小组概览"), uiText("任务记录"), uiText("最近成果"), uiText("审计记录")][index]}：${result.reason instanceof Error ? result.reason.message : uiText("加载失败")}`] : []);
    return {
        overview: overview.status === "fulfilled" ? overview.value : undefined,
        history: history.status === "fulfilled" ? history.value?.history : undefined,
        assets: assets.status === "fulfilled" ? assets.value?.assets : undefined,
        assetTotal: assets.status === "fulfilled" ? assets.value?.total : undefined,
        auditLogs: audit.status === "fulfilled" ? audit.value?.auditLogs : undefined,
        errors,
    };
}

/** Presentation-only projection of the complete audited export; prompt contents and server formula guards stay intact. */
export function nonFinancialTeamCsv(csv: string): string {
    const source = csv.replace(/^\uFEFF/, "");
    const parsed = Papa.parse<string[]>(source, { delimiter: ",", skipEmptyLines: true });
    const rows = parsed.data;
    const header = rows[0];
    const expected = ["时间", "设计师", "功能板块", "模型", "完整提示词", "积分", "人民币成本", "状态", "失败原因"];
    // Refuse a changed schema rather than guessing a column and leaking hidden values.
    if (parsed.errors.length || !header || header.length !== expected.length || header.some((value, index) => value !== expected[index]) || rows.some(row => row.length !== header.length)) throw new Error(uiText("报表格式异常，请重新导出。"));
    const keep = header.map((value, index) => value === "积分" || value === "人民币成本" ? -1 : index).filter(index => index >= 0);
    return "\uFEFF" + Papa.unparse(rows.map(row => keep.map(index => row[index])), { quotes: true, newline: "\r\n" }) + (/\r?\n$/.test(source) ? "\r\n" : "");
}
