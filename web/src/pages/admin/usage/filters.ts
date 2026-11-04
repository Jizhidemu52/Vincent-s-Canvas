import type { UsageV2Query, UsageV2Scope } from "@/services/api/usage-analytics-v2";
import type { UsageFilters } from "@/services/api/usage-analytics";
export const usageTabs = [
    { key: "overview", label: "总览" },
    { key: "people", label: "人员" },
    { key: "boards", label: "板块与功能" },
    { key: "models", label: "模型与成本" },
    { key: "quality", label: "生成质量" },
    { key: "flows", label: "流程分析" },
] as const;
export type UsageTab = (typeof usageTabs)[number]["key"];
export type UsageFilterForm = {
    from: string;
    to: string;
    compare: UsageV2Scope["compare"];
    departmentBasis: UsageV2Scope["departmentBasis"];
    departmentIds: string[];
    userIds: string[];
    boardKeys: string[];
    modelConfigIds: string[];
    operationTypes: string[];
};
const dayMs = 86400000;
export const beijingDay = (date: Date) => new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
export function datePreset(days: number | "month", now = new Date()) {
    const today = beijingDay(now);
    return { from: days === "month" ? `${today.slice(0, 7)}-01` : beijingDay(new Date(new Date(`${today}T00:00:00+08:00`).getTime() - (days - 1) * dayMs)), to: today };
}
export function readUsageLocation(params: URLSearchParams, now = new Date()) {
    const base = datePreset(30, now);
    const list = (key: string) => [...new Set((params.get(key) || "").split(",").filter(Boolean))];
    const compare = params.get("uCompare"),
        basis = params.get("uBasis");
    const filters: UsageFilterForm = {
        from: params.get("uFrom") || base.from,
        to: params.get("uTo") || base.to,
        compare: compare === "none" || compare === "previous_year" ? compare : "previous_period",
        departmentBasis: basis === "current" ? "current" : "at_event",
        departmentIds: list("uDepartments"),
        userIds: list("uUsers"),
        boardKeys: list("uBoards"),
        modelConfigIds: list("uModels"),
        operationTypes: list("uOperations"),
    };
    return { filters, tab: (usageTabs.some((tab) => tab.key === params.get("uTab")) ? params.get("uTab") : "overview") as UsageTab, personId: params.get("uPerson") || undefined };
}
export function usageQuery(filters: UsageFilterForm): UsageV2Query {
    const start = new Date(`${filters.from}T00:00:00+08:00`),
        end = new Date(`${filters.to}T00:00:00+08:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(filters.from) || !/^\d{4}-\d{2}-\d{2}$/.test(filters.to) || !Number.isFinite(+start) || !Number.isFinite(+end) || beijingDay(start) !== filters.from || beijingDay(end) !== filters.to || start > end)
        throw new Error("请选择有效日期，且开始日期不能晚于结束日期。");
    if ((+end - +start) / dayMs + 1 > 366) throw new Error("单次分析最多 366 天，请缩短日期范围。");
    return { ...filters, from: start.toISOString(), to: new Date(+end + dayMs).toISOString() };
}
export function writeUsageLocation(current: URLSearchParams, filters: UsageFilterForm, tab: UsageTab, personId?: string) {
    const params = new URLSearchParams(current);
    params.set("tab", "usage-analysis");
    params.set("uTab", tab);
    params.set("uFrom", filters.from);
    params.set("uTo", filters.to);
    params.set("uCompare", filters.compare);
    params.set("uBasis", filters.departmentBasis);
    for (const [key, values] of [
        ["uDepartments", filters.departmentIds],
        ["uUsers", filters.userIds],
        ["uBoards", filters.boardKeys],
        ["uModels", filters.modelConfigIds],
        ["uOperations", filters.operationTypes],
    ] as const) {
        if (values.length) params.set(key, values.join(","));
        else params.delete(key);
    }
    if (personId) params.set("uPerson", personId);
    else params.delete("uPerson");
    return params;
}
export function legacyUsageScope(query: UsageV2Query): { filters: UsageFilters | null; reason?: string } {
    if (query.departmentIds?.length || (query.boardKeys?.length || 0) > 1 || (query.modelConfigIds?.length || 0) > 1 || query.operationTypes?.length)
        return { filters: null, reason: "原始 JSONL 与既有 AI 预览暂不支持部门或多个板块 / 模型筛选。请清除这些条件后操作；不会自动扩大范围。" };
    return {
        filters: {
            from: query.from,
            to: query.to,
            ...(query.userIds?.length ? { userIds: query.userIds } : {}),
            ...(query.boardKeys?.length ? { boardKey: query.boardKeys[0] } : {}),
            ...(query.modelConfigIds?.length ? { modelConfigId: query.modelConfigIds[0] } : {}),
        },
    };
}
