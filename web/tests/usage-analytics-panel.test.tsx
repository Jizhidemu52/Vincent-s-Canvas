import { i18nHarness } from "./helpers/i18n-harness";
import { displayHooksHarness } from "./helpers/display-hooks-harness";
import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as React from "react";
import ts from "typescript";
import * as beijingTime from "../src/lib/beijing-time";
import { setUiLocale, uiText } from "../src/lib/i18n";

const source = new URL("../src/pages/admin/components/usage-analytics-panel.tsx", import.meta.url);
const requireModule = createRequire(source);
const compiled = ts.transpileModule(readFileSync(source, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const summary = { visits: 3, interactions: 6, generationRequests: 2, chatRequests: 1, succeeded: 2, failed: 1, pending: 0, totalRmbCost: 0.2684, generatedImages: 5 };
const coverage = { collectionStartedAt: "2026-10-15T00:00:00Z", historicalTasksAvailable: true, historicalClicksAvailable: false, historicalChatAvailable: false, droppedEventCount: 3, notes: [] };
const person = { userId: "person-1", displayName: "张三", departmentName: "产品部", summary, lastActivityAt: "2026-10-15T02:00:00Z" };
const people = { people: [person], pagination: { page: 1, pageSize: 20, total: 1 }, summary, breakdowns: { boards: [], models: [], controls: [], daily: [] }, coverage };
const frozenPreview = { previewId: "p-1", previewHash: "server-frozen-hash", expiresAt: "2099-10-15T00:00:00Z", content: "不含姓名的精确汇总", estimatedCharacters: 11, includesPromptSamples: false, sampleCount: 0, warnings: [] };
function elements(node: unknown): React.ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement(node)) return [];
    const element = node as React.ReactElement<any>;
    return [element, ...elements(element.props.children), ...elements(element.props.footer)];
}
const text = (node: unknown): string => {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(text).join("");
    if (!React.isValidElement(node)) return "";
    const element = node as React.ReactElement<any>;
    if (element.type === "DisplayText") return element.props.text;
    if (element.type === "SensitiveDisplayValue") return element.props.format ? element.props.format(element.props.value) : typeof element.props.value === "string" ? element.props.value : JSON.stringify(element.props.value, null, 2) ?? "";
    return text(element.props.children);
};

function harness(options: { role?: string; analyze?: (body: unknown, signal: AbortSignal) => Promise<unknown>; preview?: () => Promise<unknown>; list?: (signal: AbortSignal) => Promise<unknown>; models?: (signal: AbortSignal) => Promise<unknown>; detail?: () => Promise<unknown>; export?: () => Promise<unknown> } = {}) {
    const state: any[] = [], effects: Array<{ deps?: React.DependencyList; cleanup?: ReturnType<React.EffectCallback> }> = [], pending: Array<() => void> = [];
    let cursor = 0;
    const calls = { list: [] as any[], models: [] as any[], detail: [] as any[], preview: [] as any[], analyze: [] as any[], export: [] as any[], saves: [] as any[] };
    const userState = { user: { id: "admin-1", role: options.role || "super_admin" } };
    const equal = (a?: React.DependencyList, b?: React.DependencyList) => Boolean(a && b && a.length === b.length && a.every((item, index) => Object.is(item, b[index])));
    const dependencies: Record<string, any> = {
        "@/lib/i18n": i18nHarness,
        "@/hooks/use-display-text": { ...displayHooksHarness, DisplayText: "DisplayText", DisplayTranslationScope: "DisplayTranslationScope", SensitiveDisplayValue: "SensitiveDisplayValue" },
        "@/lib/beijing-time": beijingTime,
        react: { ...React,
            useMemo: (calculate: () => unknown) => calculate(),
            useState: (initial: any) => { const index = cursor++; if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial; return [state[index], (next: any) => { state[index] = typeof next === "function" ? next(state[index]) : next; }]; },
            useRef: (initial: any) => { const index = cursor++; return state[index] ||= { current: initial }; },
            useEffect: (effect: React.EffectCallback, deps?: React.DependencyList) => { const index = cursor++; if (!effects[index] || !equal(effects[index].deps, deps)) pending.push(() => { effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: effect() }; }); },
        },
        antd: { Alert: "Alert", Button: "Button", Checkbox: "Checkbox", Drawer: "Drawer", Empty: "Empty", Input: "Input", Modal: "Modal", Pagination: "Pagination", Select: "Select", Spin: "Spin", Table: "Table", Tag: "Tag", Typography: { Title: "Title" } },
        "lucide-react": new Proxy({}, { get: (_, key) => String(key) }),
        "file-saver": { saveAs: (...args: any[]) => calls.saves.push(args) },
        "@/stores/use-user-store": { useUserStore: (select: Function) => select(userState) },
        "@/stores/use-business-config-store": { useBusinessConfigStore: () => { throw new Error("OA admin must not depend on the creative model store"); } },
        "@/lib/non-financial-usage-export": {
            exportNonFinancialUsageRecords: async (body: unknown, options_: any) => { calls.export.push({ body, options: options_ }); return options.export ? options.export() : { blob: new Blob(["complete"]), recordCount: 10001, manifest: {} }; },
        },
        "@/services/api/usage-analytics": {
            listUsagePeople: async (query: unknown, signal: AbortSignal) => { calls.list.push({ query, signal }); return options.list ? options.list(signal) : people; },
            listUsageAnalysisModels: async (signal: AbortSignal) => { calls.models.push({ signal }); return options.models ? options.models(signal) : { models: [{ id: "text-model", name: "配置的文字模型" }] }; },
            getUsagePerson: async (...args: any[]) => { calls.detail.push(args); return options.detail ? options.detail() : { ...people, person, records: [] }; },
            previewUsageAnalysis: async (body: unknown, signal: AbortSignal) => { calls.preview.push({ body, signal }); return options.preview ? options.preview() : frozenPreview; },
            analyzeUsage: async (body: unknown, signal: AbortSignal) => { calls.analyze.push({ body, signal }); return options.analyze ? options.analyze(body, signal) : { analysisId: "a-1", modelConfigId: "text-model", content: "流程改进建议", createdAt: "2026-10-15T00:00:00Z" }; },
        },
    };
    const module = { exports: {} as any };
    new Function("require", "module", "exports", compiled)((name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireModule(name), module, module.exports);
    const render = () => { cursor = 0; const result = module.exports.UsageAnalyticsPanel(); pending.splice(0).forEach(effect => effect()); return elements(result); };
    return { calls, userState, exports: module.exports, render,
        async settle() { let tree = render(); for (let i = 0; i < 8; i++) { await Promise.resolve(); tree = render(); } return tree; },
        dispose: () => effects.forEach(effect => effect.cleanup?.()),
    };
}
const button = (tree: React.ReactElement<any>[], name: string) => tree.find(element => element.type === "Button" && text(element.props.children) === name)!;
const labelled = (tree: React.ReactElement<any>[], label: string) => tree.find(element => element.props["aria-label"] === label)!;

test("employee charts and deterministic summary use only that person's breakdowns, totals and coverage", async () => {
    const personalSummary = { ...summary, generationRequests: 7, chatRequests: 2, succeeded: 6, failed: 2, pending: 1, totalRmbCost: 1.0065, generatedImages: 3 };
    const personalBreakdowns = { models: [{ key: "personal-model", label: "个人专用模型", count: 7 }], boards: [{ key: "personal-board", label: "个人改图板块", count: 12 }], controls: [{ key: "personal-control", label: "个人尺寸选择", count: 4 }], daily: [] };
    const personalCoverage = { ...coverage, droppedEventCount: 8 };
    const panel = harness({ detail: async () => ({ person, summary: personalSummary, breakdowns: personalBreakdowns, coverage: personalCoverage, records: [], pagination: { page: 1, pageSize: 20, total: 0 } }) });
    try {
        let tree = await panel.settle();
        expect(labelled(tree, "搜索使用分析用户").props.placeholder).toBe("姓名或账号");
        expect(tree.find(element => element.props.title === "操作控件分布")?.props.values).toBe(people.breakdowns.controls);
        const table = tree.find(element => element.type === "Table")!;
        table.props.columns.find((column: any) => column.title === "姓名").render(person.displayName, person).props.onClick();
        tree = await panel.settle();
        expect(panel.calls.detail[0][0]).toBe(person.userId);
        for (const [title, key] of [["个人模型调用分布", "models"], ["个人板块使用分布", "boards"], ["个人操作控件分布", "controls"]] as const) {
            expect(tree.find(element => element.props.title === title)?.props.values).toBe(personalBreakdowns[key]);
            expect(tree.find(element => element.props.title === title)?.props.values).not.toBe(people.breakdowns[key]);
        }
        const brief = labelled(tree, "个人统计简述").props.children;
        expect(brief).toContain("该员工已记录 9 次模型请求");
        expect(brief).not.toContain("已记账生成消费");
        expect(brief).toContain("成功实际出图 3 张（不是请求次数）");
        const personalTotals = elements(labelled(tree, "个人出图统计"));
        expect(personalTotals.some(element => element.props.title === "生成消费（元）")).toBe(false);
        expect(personalTotals.find(element => element.props.title === "成功出图（张）")?.props.value).toBe(3);
        expect(brief).toContain("个人专用模型"); expect(brief).toContain("个人改图板块"); expect(brief).toContain("个人尺寸选择");
        expect(brief).toContain("8 条已知采集缺口"); expect(brief).not.toContain("3 条已知采集缺口");
        expect(brief).toContain("记录不足不能解释为未工作或未使用");
        expect(labelled(tree, "统计简述").props.children).toContain("当前筛选范围已记录 3 次模型请求");
    } finally { panel.dispose(); }
});

test("deterministic brief selects highest observed counts without assuming sort order or inventing zero-activity conclusions", () => {
    const panel = harness();
    const brief = panel.exports.usageSummaryText(summary, { ...people.breakdowns, models: [{ key: "a", label: "少用模型", count: 1 }, { key: "b", label: "常用模型", count: 5 }] }, { ...coverage, droppedEventCount: 0 });
    expect(brief).toContain("常用模型”（5 次调用）"); expect(brief).not.toContain("少用模型");
    expect(brief).toContain("暂无可用板块记录"); expect(brief).toContain("暂无可用操作控件记录");
    expect(brief).toContain("历史点击与聊天不能回补"); expect(brief).not.toContain("已知采集缺口");
});

test("usage display removes known financial explanations but preserves collection gaps and free text", () => {
    const panel = harness();
    const display = panel.exports.usageDisplayExplanation;
    expect(display("生成成本汇总已保存的成功生成历史人民币金额（含图片、视频和音频），不按新单价重算。")).toBe("");
    expect(display("当前筛选中有 2 个成功任务缺少成功结算历史，费用未计入且不补估；已保存的图片结果仍计入张数。")).toBe("已保存的图片结果仍计入张数。");
    expect(display("已保存历史金额不按新单价重算；未上报缺口可能未知。")).toBe("未上报缺口可能未知。");
    expect(display("采集缺失不能推断为未使用；不作人格或绩效评价。")).toBe("采集缺失不能推断为未使用；不作人格或绩效评价。");
    expect(display("分析调用可能产生费用；仅在明确确认后调用一次，不自动重试。")).toBe("分析仅在明确确认后调用一次，不自动重试。");
});

test("preview display omits financial metadata without changing the frozen content or prompt samples", () => {
    const panel = harness();
    const original = { summary, promptSamples: [{ prompt: "参考商品价格99元，保留设计说明" }], coverage: { notes: ["生成成本汇总已保存的成功生成历史人民币金额（含图片、视频和音频）。", "采集缺口仍需说明。"] } };
    const content = JSON.stringify(original);
    const display = JSON.parse(panel.exports.usagePreviewDisplay(content));
    expect(display.summary).not.toHaveProperty("totalRmbCost");
    expect(display.summary.generatedImages).toBe(summary.generatedImages);
    expect(display.coverage.notes).toEqual(["采集缺口仍需说明。"]);
    expect(display.promptSamples).toEqual(original.promptSamples);
    expect(JSON.parse(content)).toEqual(original);
    expect(original.summary.totalRmbCost).toBe(0.2684);
});

test("date filters use inclusive Beijing days, reject impossible ranges and preserve searches for every scope", () => {
    const panel = harness();
    const filters = panel.exports.usageRangeFilters({ from: "2026-10-01", to: "2026-10-15", search: "  私有姓名  " });
    expect(filters).toEqual({ from: "2026-09-30T16:00:00.000Z", to: "2026-10-15T16:00:00.000Z", search: "私有姓名" });
    expect(panel.exports.usageSelectionFilters({ from: "2026-10-01", to: "2026-10-15", search: "私有姓名" })).toEqual(filters);
    expect(panel.exports.usageSelectionFilters({ from: "2026-10-01", to: "2026-10-15", search: "" }, ["one", "one", "two"]).userIds).toEqual(["one", "two"]);
    expect(panel.exports.usageRangeFilters({ from: "2024-02-29", to: "2024-02-29", search: " " })).toEqual({ from: "2024-02-28T16:00:00.000Z", to: "2024-02-29T16:00:00.000Z" });
    expect(panel.exports.usageRangeFilters({ from: "2026-12-31", to: "2026-12-31", search: "" })).toEqual({ from: "2026-12-30T16:00:00.000Z", to: "2026-12-31T16:00:00.000Z" });
    for (const [from, to] of [["2026-02-30", "2026-03-01"], ["2026-10-16", "2026-10-15"], ["", "2026-10-15"]]) expect(() => panel.exports.usageRangeFilters({ from, to, search: "" })).toThrow();
    expect(() => panel.exports.usageSelectionFilters({ from: "2026-10-01", to: "2026-10-15", search: "" }, [])).toThrow();
});

test("Beijing presets cover today, trailing days and calendar months including leap/year boundaries", () => {
    const panel = harness();
    const preset = panel.exports.usageDatePreset;
    expect(preset("today", new Date("2026-12-31T16:00:00Z"))).toEqual({ from: "2027-01-01", to: "2027-01-01" });
    expect(preset("7days", new Date("2026-12-31T16:00:00Z"))).toEqual({ from: "2026-12-26", to: "2027-01-01" });
    expect(preset("30days", new Date("2026-12-31T16:00:00Z"))).toEqual({ from: "2026-12-03", to: "2027-01-01" });
    expect(preset("month", new Date("2026-10-31T15:59:59Z"))).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(preset("lastMonth", new Date("2027-01-01T00:00:00Z"))).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(preset("lastMonth", new Date("2024-03-01T00:00:00Z"))).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(preset("lastMonth", new Date("2026-03-01T00:00:00Z"))).toEqual({ from: "2026-02-01", to: "2026-02-28" });
});

test("daily values keep visits and interactions separate from requests and do not rate unfinished work as failed", () => {
    const panel = harness();
    const daily = { ...summary, visits: 100, interactions: 200, generationRequests: 2, chatRequests: 3, succeeded: 2, failed: 1, pending: 2 };
    expect(panel.exports.usageTrendValue(daily, "requests")).toBe(5);
    expect(panel.exports.usageTrendValue(daily, "images")).toBe(summary.generatedImages);
    expect(panel.exports.usageTrendValue(daily, "successRate")).toBeCloseTo(66.666667);
    expect(panel.exports.usageTrendValue({ ...daily, succeeded: 0, failed: 0 }, "successRate")).toBeNull();
    const chart = panel.exports.UsageDailyTrend({ daily: [{ day: "2026-10-15", ...daily }], from: "2026-10-01", to: "2026-10-30", coverage: { ...coverage, missingHistoryCount: 2 } });
    expect(text(chart)).not.toContain("费用");
    expect(text(chart)).not.toContain("￥0.268400");
    expect(elements(chart).find(element => element.type === "Select")!.props.options.map((option: any) => option.value)).toEqual(["requests", "images", "successRate"]);
    expect(text(chart)).toContain("66.7%");
    expect(elements(chart).find(element => element.type === "table")?.props["aria-label"]).toBe("每日趋势数据表");
    expect(elements(chart).find(element => element.type === "title")?.props.children).toContain("5");
});

test("unknown buckets stay visible but cannot become invalid query filters", () => {
    const panel = harness(); const model = "07bf04dd-3bee-4fc3-9757-2fdd321586be";
    expect(panel.exports.isUsageFilterBucket("model", model)).toBe(true);
    expect(panel.exports.isUsageFilterBucket("board", "canvas-image")).toBe(true);
    for (const kind of ["board", "model"]) expect(panel.exports.isUsageFilterBucket(kind, "unknown")).toBe(false);
    const clicked: string[] = [];
    const bars = panel.exports.UsageBars({ title: "模型调用分布", filterKind: "model", values: [{ key: "unknown", label: "未知模型", count: 4 }, { key: model, label: "图片模型", count: 3 }], onSelect: (key: string) => clicked.push(key) });
    const buttons = elements(bars).filter(element => element.type === "button");
    expect(buttons).toHaveLength(1); expect(text(bars)).toContain("未知模型"); buttons[0]!.props.onClick(); expect(clicked).toEqual([model]);
    expect(() => panel.exports.usageRangeFilters({ from: "2026-10-01", to: "2026-10-30", search: "", modelConfigId: "unknown" })).toThrow("请选择有效的模型");
});

test.each(["UTC", "America/Los_Angeles"])("Beijing date boundaries and recent 30 days ignore runtime timezone: %s", timeZone => {
    const code = `
        import { createRequire } from "node:module";
        import { readFileSync } from "node:fs";
        const require = createRequire(${JSON.stringify(import.meta.url)});
        const ts = require("typescript");
        const beijingTime = require(${JSON.stringify(new URL("../src/lib/beijing-time.ts", import.meta.url).href)});
        const compiled = ts.transpileModule(readFileSync(new URL(${JSON.stringify(source.href)}), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
        const loaded = { exports: {} };
        new Function("require", "module", "exports", compiled)(name => name === "@/lib/beijing-time" ? beijingTime : {}, loaded, loaded.exports);
        process.stdout.write(JSON.stringify({
            range: loaded.exports.usageRangeFilters({ from: "2026-10-31", to: "2026-11-02", search: "张三" }),
            before: loaded.exports.defaultUsageDateFilter(new Date("2026-10-29T15:59:59.999Z")),
            midnight: loaded.exports.defaultUsageDateFilter(new Date("2026-10-29T16:00:00.000Z")),
        }));`;
    const result = spawnSync(process.execPath, ["--eval", code], { encoding: "utf8", env: { ...process.env, TZ: timeZone } });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
        range: { from: "2026-10-30T16:00:00.000Z", to: "2026-11-02T16:00:00.000Z", search: "张三" },
        before: { from: "2026-09-30", to: "2026-10-29", search: "" },
        midnight: { from: "2026-10-01", to: "2026-10-30", search: "" },
    });
});

test("all usage displays omit financial values while retaining counts and original records", async () => {
    const record = { id: "generation-1", kind: "generation", status: "success", occurredAt: "2026-10-29T16:00:00Z", boardLabel: "图片生成", modelName: "图片模型", prompt: "测试", parameters: {}, totalRmbCost: 0.16104, generatedImages: 3 };
    const panel = harness({ detail: async () => ({ ...people, person, records: [record] }) });
    try {
        let tree = await panel.settle();
        const top = elements(labelled(tree, "使用简要统计"));
        expect(top.filter(element => element.props.title).map(element => element.props.title)).toEqual(["成功出图（张）", "模型调用次数", "已完成 / 失败", "板块访问记录", "交互操作记录"]);
        expect(labelled(tree, "统计简述").props.children).not.toContain("已记账生成消费");
        expect(labelled(tree, "统计简述").props.children).not.toContain("￥0.268400");
        expect(top.find(element => element.props.title === "成功出图（张）")?.props.value).toBe(5);
        expect(top.find(element => element.props.title === "模型调用次数")?.props.value).toBe(3);
        const table = tree.find(element => element.type === "Table")!;
        expect(table.props.columns.some((column: any) => column.key === "cost")).toBe(false);
        expect(table.props.columns.find((column: any) => column.title === "成功出图（张）").render(null, person)).toBe(5);
        expect(table.props.columns.find((column: any) => column.title === "模型调用").render(null, person)).toBe(3);
        expect(table.props.columns.find((column: any) => column.title === "最后记录").render("2026-10-29T16:00:00Z")).toBe("2026-10-30 00:00:00");
        expect(text(tree)).not.toContain("历史成本按原记录汇总");
        expect(text(tree)).not.toContain("供应商积分");
        table.props.columns.find((column: any) => column.title === "姓名").render(person.displayName, person).props.onClick();
        tree = await panel.settle();
        const card = tree.find(element => element.props.record?.id === record.id)!;
        const cardText = text((card.type as Function)(card.props));
        expect(cardText).not.toContain("已记账生成消费");
        expect(cardText).not.toContain("￥0.161040");
        expect(record.totalRmbCost).toBe(0.16104);
        expect(cardText).toContain("成功实际出图 3 张");
        expect(cardText).toContain("2026-10-30 00:00:00（北京时间）");
        expect(text(tree)).toContain("成功请求 2 次");
        expect(panel.calls.preview).toHaveLength(0);
        expect(panel.calls.analyze).toHaveLength(0);
    } finally { panel.dispose(); }
});

test("applying a person search keeps list, detail, export and free preview on the same Beijing period", async () => {
    const panel = harness();
    try {
        let tree = await panel.settle();
        labelled(tree, "搜索使用分析用户").props.onChange({ target: { value: " 张三 " } });
        labelled(tree, "使用分析开始日期").props.onChange({ target: { value: "2026-10-01" } });
        labelled(tree, "使用分析结束日期").props.onChange({ target: { value: "2026-10-30" } });
        labelled(tree, "使用分析板块筛选").props.onChange("canvas-image");
        labelled(tree, "使用分析模型筛选").props.onChange("07bf04dd-3bee-4fc3-9757-2fdd321586be");
        tree = panel.render(); button(tree, "应用筛选").props.onClick(); tree = await panel.settle();
        const scope = { from: "2026-09-30T16:00:00.000Z", to: "2026-10-30T16:00:00.000Z", search: "张三", boardKey: "canvas-image", modelConfigId: "07bf04dd-3bee-4fc3-9757-2fdd321586be" };
        expect(panel.calls.list.at(-1).query).toEqual({ ...scope, page: 1, pageSize: 20 });
        const table = tree.find(element => element.type === "Table")!;
        table.props.columns.find((column: any) => column.title === "姓名").render(person.displayName, person).props.onClick();
        tree = await panel.settle();
        expect(panel.calls.detail.at(-1)[1]).toEqual({ ...scope, page: 1, pageSize: 20 });
        button(tree, "导出筛选范围完整记录").props.onClick(); tree = panel.render(); button(tree, "开始导出完整记录").props.onClick(); tree = await panel.settle();
        expect(panel.calls.export[0].body).toEqual(scope);
        expect(panel.calls.saves[0][1]).toBe("使用记录-2026-10-01-2026-10-30-筛选用户.jsonl");
        button(tree, "预览将发送的汇总").props.onClick(); await panel.settle();
        expect(panel.calls.preview[0].body).toEqual({ ...scope, includePromptSamples: false });
        expect(panel.calls.analyze).toHaveLength(0);
    } finally { panel.dispose(); }
});

test("sorting retains cross-page selections while changing a filter clears detail, selection and frozen preview", async () => {
    const panel = harness();
    try {
        let tree = await panel.settle();
        let table = tree.find(element => element.type === "Table")!;
        table.props.rowSelection.onChange(["person-1", "person-2"]);
        tree = panel.render(); button(tree, "预览将发送的汇总").props.onClick(); tree = await panel.settle();
        table = tree.find(element => element.type === "Table")!;
        table.props.columns.find((column: any) => column.title === "姓名").render(person.displayName, person).props.onClick(); tree = await panel.settle();
        table = tree.find(element => element.type === "Table")!;
        table.props.onChange({}, {}, { columnKey: "images", order: "descend" }, { action: "sort" }); tree = await panel.settle();
        expect(panel.calls.list.at(-1).query).toMatchObject({ sort: "images", order: "desc", page: 1 });
        table = tree.find(element => element.type === "Table")!;
        expect(table.props.rowSelection.selectedRowKeys).toEqual(["person-1", "person-2"]);
        expect(tree.some(element => element.props["data-testid"] === "usage-analysis-preview")).toBe(true);
        table.props.pagination.onChange(2); tree = await panel.settle();
        expect(panel.calls.list.at(-1).query).toMatchObject({ sort: "images", order: "desc", page: 2 });
        expect(tree.find(element => element.type === "Table")!.props.rowSelection.selectedRowKeys).toEqual(["person-1", "person-2"]);
        labelled(tree, "使用分析板块筛选").props.onChange("image"); tree = panel.render();
        expect(tree.find(element => element.type === "Table")!.props.rowSelection.selectedRowKeys).toEqual([]);
        expect(tree.find(element => element.type === "Drawer")!.props.open).toBe(false);
        expect(tree.some(element => element.props["data-testid"] === "usage-analysis-preview")).toBe(false);
        expect(button(tree, "导出筛选范围完整记录").props.disabled).toBe(true);
        expect(panel.calls.analyze).toHaveLength(0);
    } finally { panel.dispose(); }
});

test("drilling into a valid bucket applies the same scope and keeps model choices after narrowing", async () => {
    const model = "07bf04dd-3bee-4fc3-9757-2fdd321586be"; let loads = 0;
    const panel = harness({ list: async () => ({ ...people, breakdowns: { ...people.breakdowns, models: loads++ === 0 ? [{ key: model, label: "历史图片模型", count: 3 }] : [] } }) });
    try {
        let tree = await panel.settle();
        expect(labelled(tree, "使用分析模型筛选").props.options).toEqual([{ value: model, label: "历史图片模型" }]);
        tree.find(element => element.props.title === "模型调用分布")!.props.onSelect(model); tree = await panel.settle();
        expect(panel.calls.list.at(-1).query).toMatchObject({ modelConfigId: model, page: 1 });
        expect(labelled(tree, "使用分析模型筛选").props.options).toEqual([{ value: model, label: "历史图片模型" }]);
        expect(labelled(tree, "使用分析模型筛选").props.value).toBe(model);
        expect(text(tree)).toContain("保留当前搜索内零记录员工");
        expect(panel.calls.analyze).toHaveLength(0);
    } finally { panel.dispose(); }
});

test("non-superadmins never read records or expose export and analysis controls", async () => {
    for (const role of ["department_admin", "designer"]) {
        const panel = harness({ role });
        try { const tree = await panel.settle(); expect(panel.calls.list).toHaveLength(0); expect(panel.calls.models).toHaveLength(0); expect(tree[0]?.props.title).toBe("仅超级管理员可访问使用分析"); expect(tree.some(element => element.type === "Table")).toBe(false); }
        finally { panel.dispose(); }
    }
});

test("preview is opt-in, defaults to no prompt samples, and sends only the exact frozen preview after manual confirmation", async () => {
    let finish!: (value: unknown) => void;
    const panel = harness({ analyze: () => new Promise(resolve => { finish = resolve; }) });
    try {
        let tree = await panel.settle();
        expect(panel.calls.preview).toHaveLength(0); expect(panel.calls.analyze).toHaveLength(0);
        const model = labelled(tree, "使用分析文字模型");
        expect(model.props.options.map((item: any) => item.value)).toEqual(["text-model"]);
        model.props.onChange("text-model");
        button(tree, "预览将发送的汇总").props.onClick();
        tree = await panel.settle();
        expect(panel.calls.preview[0].body.includePromptSamples).toBe(false);
        expect(panel.calls.preview[0].body).not.toHaveProperty("userIds");
        expect(text(tree.find(element => element.props["data-testid"] === "usage-analysis-preview")?.props.children)).toBe(frozenPreview.content);
        const submit = button(tree, "发送已预览汇总 · 手动分析").props.onClick;
        submit(); submit();
        expect(panel.calls.analyze).toHaveLength(1);
        expect(panel.calls.analyze[0].body).toEqual({ previewId: "p-1", previewHash: "server-frozen-hash", modelConfigId: "text-model", confirm: true });
        finish({ content: "流程建议", createdAt: "2026-10-15T00:00:00Z" });
        tree = await panel.settle();
        expect(button(tree, "发送已预览汇总 · 手动分析").props.disabled).toBe(true);
    } finally { panel.dispose(); }
});

test("changing selected people or sample consent invalidates preview; selected scope sends only selected IDs", async () => {
    const panel = harness();
    try {
        let tree = await panel.settle();
        tree.find(element => element.type === "Table")!.props.rowSelection.onChange(["person-1", "person-2"]);
        tree = panel.render(); labelled(tree, "使用分析范围").props.onChange("selected");
        tree = panel.render(); button(tree, "预览将发送的汇总").props.onClick();
        tree = await panel.settle();
        expect(panel.calls.preview[0].body.userIds).toEqual(["person-1", "person-2"]);
        tree.find(element => element.type === "Checkbox")!.props.onChange({ target: { checked: true } });
        tree = panel.render(); expect(tree.some(element => element.props["data-testid"] === "usage-analysis-preview")).toBe(false);
        button(tree, "预览将发送的汇总").props.onClick(); await panel.settle();
        expect(panel.calls.preview[1].body.includePromptSamples).toBe(true);
    } finally { panel.dispose(); }
});

test("OA model load failure allows preview but blocks submission until manual retry and explicit UUID selection", async () => {
    let attempts = 0;
    const panel = harness({ models: async () => { if (++attempts === 1) throw new Error("读取失败"); return { models: [{ id: "oa-text-uuid", name: "OA后台文字模型", description: "汇总用途" }] }; } });
    try {
        let tree = await panel.settle();
        expect(panel.calls.models).toHaveLength(1);
        expect(tree.some(element => element.type === "Alert" && String(element.props.title).includes("文字模型读取失败"))).toBe(true);
        expect(labelled(tree, "使用分析文字模型").props.options).toEqual([]);
        button(tree, "预览将发送的汇总").props.onClick(); tree = await panel.settle();
        expect(tree.some(element => element.props["data-testid"] === "usage-analysis-preview")).toBe(true);
        expect(button(tree, "发送已预览汇总 · 手动分析").props.disabled).toBe(true);
        button(tree, "发送已预览汇总 · 手动分析").props.onClick(); await panel.settle(); expect(panel.calls.analyze).toHaveLength(0);
        button(tree, "重新加载文字模型").props.onClick(); tree = await panel.settle();
        expect(labelled(tree, "使用分析文字模型").props.options).toEqual([{ value: "oa-text-uuid", label: "OA后台文字模型 · 汇总用途" }]);
        expect(labelled(tree, "使用分析文字模型").props.value).toBeUndefined();
        expect(button(tree, "发送已预览汇总 · 手动分析").props.disabled).toBe(true);
        labelled(tree, "使用分析文字模型").props.onChange("oa-text-uuid"); tree = panel.render();
        button(tree, "发送已预览汇总 · 手动分析").props.onClick(); await panel.settle();
        expect(panel.calls.analyze).toHaveLength(1); expect(panel.calls.analyze[0].body.modelConfigId).toBe("oa-text-uuid");
    } finally { panel.dispose(); }
});

test("identity changes abort the old model request, clear UUID and preview, and ignore late model results", async () => {
    const pending: Array<(value: unknown) => void> = [];
    const panel = harness({ models: () => new Promise(resolve => { pending.push(resolve); }) });
    try {
        let tree = await panel.settle();
        expect(labelled(tree, "使用分析文字模型").props.disabled).toBe(true);
        button(tree, "预览将发送的汇总").props.onClick(); tree = await panel.settle();
        labelled(tree, "使用分析文字模型").props.onChange("old-uuid");
        panel.userState.user.id = "admin-2"; tree = await panel.settle();
        expect(panel.calls.models[0].signal.aborted).toBe(true); expect(panel.calls.models).toHaveLength(2);
        expect(labelled(tree, "使用分析文字模型").props.value).toBeUndefined();
        expect(tree.some(element => element.props["data-testid"] === "usage-analysis-preview")).toBe(false);
        pending[0]!({ models: [{ id: "old-uuid", name: "旧账号模型" }] });
        pending[1]!({ models: [{ id: "new-uuid", name: "新账号模型" }] }); tree = await panel.settle();
        expect(labelled(tree, "使用分析文字模型").props.options).toEqual([{ value: "new-uuid", label: "新账号模型" }]);
        expect(panel.calls.analyze).toHaveLength(0);
        button(tree, "重新加载文字模型").props.onClick(); await panel.settle();
        panel.userState.user.role = "department_admin"; tree = await panel.settle();
        expect(panel.calls.models[2].signal.aborted).toBe(true); expect(panel.calls.models).toHaveLength(3);
        expect(tree.some(element => element.props["aria-label"] === "使用分析文字模型")).toBe(false);
    } finally { panel.dispose(); }
});

test("cancelled analysis aborts waiting and consumes the preview without automatically resubmitting", async () => {
    let reject!: (error: unknown) => void;
    const panel = harness({ analyze: () => new Promise((_, reject_) => { reject = reject_; }) });
    try {
        let tree = await panel.settle(); labelled(tree, "使用分析文字模型").props.onChange("text-model");
        button(tree, "预览将发送的汇总").props.onClick(); tree = await panel.settle();
        button(tree, "发送已预览汇总 · 手动分析").props.onClick(); tree = panel.render();
        button(tree, "取消等待分析").props.onClick();
        expect(panel.calls.analyze[0].signal.aborted).toBe(true);
        reject(new DOMException("Aborted", "AbortError")); tree = await panel.settle();
        expect(button(tree, "发送已预览汇总 · 手动分析").props.disabled).toBe(true);
        expect(panel.calls.analyze).toHaveLength(1);
        expect(tree.some(element => element.type === "Alert" && String(element.props.title).includes("已提交的请求可能继续处理"))).toBe(true);
    } finally { panel.dispose(); }
});

test("full export has no silent row cap and double clicks create one completed browser download", async () => {
    const panel = harness();
    try {
        let tree = await panel.settle();
        button(tree, "导出筛选范围完整记录").props.onClick(); tree = panel.render();
        const start = button(tree, "开始导出完整记录").props.onClick; start(); start();
        tree = await panel.settle();
        expect(panel.calls.export).toHaveLength(1); expect(panel.calls.export[0].body).not.toHaveProperty("userIds");
        expect(panel.calls.saves).toHaveLength(1);
        expect(tree.some(element => element.type === "Alert" && String(element.props.title).includes("10001 条记录"))).toBe(true);
    } finally { panel.dispose(); }
});

test("incomplete export does not save a file and unmount cancels outstanding authenticated reads", async () => {
    const panel = harness({ export: async () => { throw new Error("未收到完整结束标记"); } });
    try {
        let tree = await panel.settle(); button(tree, "导出筛选范围完整记录").props.onClick(); tree = panel.render(); button(tree, "开始导出完整记录").props.onClick();
        tree = await panel.settle(); expect(panel.calls.saves).toHaveLength(0); expect(tree.some(element => element.type === "Alert" && element.props.title === "未收到完整结束标记")).toBe(true);
    } finally { panel.dispose(); }
    const pending = harness({ list: () => new Promise(() => undefined) });
    await pending.settle(); pending.dispose(); expect(pending.calls.list[0].signal.aborted).toBe(true);
});

test("daily trend localizes its default title and static headers without changing source rows", async () => {
    const panel = harness();
    const daily = [{ ...summary, day: "2026-10-30" }];
    const original = JSON.stringify(daily);
    const props = { daily, from: "2026-10-30", to: "2026-10-30" };
    const headers = ["日期", "生成请求", "文字请求", "成功", "失败 / 取消 / 中断", "未完成", "终态成功率", "实际图片", "访问", "交互"];
    const renderTrend = () => elements(panel.exports.UsageDailyTrend(props));
    try {
        const chinese = renderTrend();
        expect(chinese[0].props["aria-label"]).toBe("每日趋势");
        expect(chinese.filter(item => item.type === "th" && item.props.scope === "col").map(item => text(item))).toEqual(headers);
        await setUiLocale("en-US");
        const english = renderTrend();
        expect(english[0].props["aria-label"]).toBe(uiText("每日趋势"));
        expect(english.find(item => item.type === "h3")?.props.children).toBe(uiText("每日趋势"));
        expect(english.filter(item => item.type === "th" && item.props.scope === "col").map(item => text(item))).toEqual(headers.map(label => uiText(label)));
        expect(english.filter(item => item.type === "td").map(item => text(item))).toEqual(chinese.filter(item => item.type === "td").map(item => text(item)));
        expect(JSON.stringify(daily)).toBe(original);
        await setUiLocale("zh-CN");
        expect(text(renderTrend())).toBe(text(chinese));
    } finally { await setUiLocale("zh-CN"); panel.dispose(); }
});

test("record kinds and statuses translate only on display and restore without mutating records", async () => {
    const records = [
        ["visit", "recorded", "板块访问", "已记录"], ["interaction", "paused", "操作事件", "已暂停"],
        ["generation", "success", "生成请求", "成功"], ["chat", "processing", "文字调用", "处理中"],
        ["gap", "failed", "采集缺口", "失败"], ["generation", "unknown-status", "生成请求", "unknown-status"],
    ].map(([kind, status, kindLabel, statusLabel], index) => ({ id: `record-${index}`, kind, status, kindLabel, statusLabel, occurredAt: "2026-10-30T00:00:00Z", boardLabel: "原始板块", modelName: "原始模型", prompt: "原始提示词", parameters: { caption: "原始参数" }, generatedImages: 1 }));
    const original = JSON.stringify(records);
    const panel = harness({ detail: async () => ({ ...people, person, records }) });
    try {
        let tree = await panel.settle();
        tree.find(item => item.type === "Table")!.props.columns.find((column: any) => column.title === "姓名").render(person.displayName, person).props.onClick();
        tree = await panel.settle();
        const cards = tree.filter(item => records.some(record => item.props.record === record));
        const renderCards = () => cards.map(card => elements((card.type as Function)(card.props)));
        const chinese = renderCards();
        expect(chinese.map(card => card.filter(item => item.type === "Tag").map(item => text(item)))).toEqual(records.map(record => [record.kindLabel, record.statusLabel]));
        await setUiLocale("en-US");
        const english = renderCards();
        expect(english.map(card => card.filter(item => item.type === "Tag").map(item => text(item)))).toEqual(records.map(record => [uiText(record.kindLabel!), uiText(record.statusLabel!)]));
        expect(english.filter((_, index) => ["generation", "chat"].includes(records[index].kind!)).every(card => text(card).includes("原始提示词"))).toBe(true);
        expect(JSON.stringify(records)).toBe(original);
        expect(panel.calls.analyze).toHaveLength(0);
        await setUiLocale("zh-CN");
        expect(renderCards().map(card => text(card))).toEqual(chinese.map(card => text(card)));
    } finally { await setUiLocale("zh-CN"); panel.dispose(); }
});
