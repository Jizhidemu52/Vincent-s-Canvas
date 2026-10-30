import { i18nHarness } from "./helpers/i18n-harness";
import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as React from "react";
import ts from "typescript";
import * as beijingTime from "../src/lib/beijing-time";

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
const text = (node: unknown): string => typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join("") : React.isValidElement(node) ? text((node as React.ReactElement<any>).props.children) : "";

function harness(options: { role?: string; analyze?: (body: unknown, signal: AbortSignal) => Promise<unknown>; preview?: () => Promise<unknown>; list?: (signal: AbortSignal) => Promise<unknown>; models?: (signal: AbortSignal) => Promise<unknown>; detail?: () => Promise<unknown>; export?: () => Promise<unknown> } = {}) {
    const state: any[] = [], effects: Array<{ deps?: React.DependencyList; cleanup?: ReturnType<React.EffectCallback> }> = [], pending: Array<() => void> = [];
    let cursor = 0;
    const calls = { list: [] as any[], models: [] as any[], detail: [] as any[], preview: [] as any[], analyze: [] as any[], export: [] as any[], saves: [] as any[] };
    const userState = { user: { id: "admin-1", role: options.role || "super_admin" } };
    const equal = (a?: React.DependencyList, b?: React.DependencyList) => Boolean(a && b && a.length === b.length && a.every((item, index) => Object.is(item, b[index])));
    const dependencies: Record<string, any> = {
        "@/lib/i18n": i18nHarness,
        "@/lib/beijing-time": beijingTime,
        react: { ...React,
            useState: (initial: any) => { const index = cursor++; if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial; return [state[index], (next: any) => { state[index] = typeof next === "function" ? next(state[index]) : next; }]; },
            useRef: (initial: any) => { const index = cursor++; return state[index] ||= { current: initial }; },
            useEffect: (effect: React.EffectCallback, deps?: React.DependencyList) => { const index = cursor++; if (!effects[index] || !equal(effects[index].deps, deps)) pending.push(() => { effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: effect() }; }); },
        },
        antd: { Alert: "Alert", Button: "Button", Checkbox: "Checkbox", Drawer: "Drawer", Empty: "Empty", Input: "Input", Modal: "Modal", Pagination: "Pagination", Select: "Select", Spin: "Spin", Table: "Table", Tag: "Tag", Typography: { Title: "Title" } },
        "lucide-react": new Proxy({}, { get: (_, key) => String(key) }),
        "file-saver": { saveAs: (...args: any[]) => calls.saves.push(args) },
        "@/stores/use-user-store": { useUserStore: (select: Function) => select(userState) },
        "@/stores/use-business-config-store": { useBusinessConfigStore: () => { throw new Error("OA admin must not depend on the creative model store"); } },
        "@/services/api/usage-analytics": {
            listUsagePeople: async (query: unknown, signal: AbortSignal) => { calls.list.push({ query, signal }); return options.list ? options.list(signal) : people; },
            listUsageAnalysisModels: async (signal: AbortSignal) => { calls.models.push({ signal }); return options.models ? options.models(signal) : { models: [{ id: "text-model", name: "配置的文字模型" }] }; },
            getUsagePerson: async (...args: any[]) => { calls.detail.push(args); return options.detail ? options.detail() : { ...people, person, records: [] }; },
            previewUsageAnalysis: async (body: unknown, signal: AbortSignal) => { calls.preview.push({ body, signal }); return options.preview ? options.preview() : frozenPreview; },
            analyzeUsage: async (body: unknown, signal: AbortSignal) => { calls.analyze.push({ body, signal }); return options.analyze ? options.analyze(body, signal) : { analysisId: "a-1", modelConfigId: "text-model", content: "流程改进建议", createdAt: "2026-10-15T00:00:00Z" }; },
            exportUsageRecords: async (body: unknown, options_: any) => { calls.export.push({ body, options: options_ }); return options.export ? options.export() : { blob: new Blob(["complete"]), recordCount: 10001, manifest: {} }; },
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
        expect(brief).toContain("已记账生成消费 ￥1.006500");
        expect(brief).toContain("成功实际出图 3 张（不是请求次数）");
        const personalTotals = elements(labelled(tree, "个人消费与出图统计"));
        expect(personalTotals.find(element => element.props.title === "生成消费（元）")?.props.value).toBe("￥1.006500");
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

test("summary, people rows and individual records distinguish six-decimal cost and actual image count from calls", async () => {
    const record = { id: "generation-1", kind: "generation", status: "success", occurredAt: "2026-10-29T16:00:00Z", boardLabel: "图片生成", modelName: "图片模型", prompt: "测试", parameters: {}, totalRmbCost: 0.16104, generatedImages: 3 };
    const panel = harness({ detail: async () => ({ ...people, person, records: [record] }) });
    try {
        let tree = await panel.settle();
        const top = elements(labelled(tree, "使用简要统计"));
        expect(top.find(element => element.props.title === "生成消费（元）")?.props.value).toBe("￥0.268400");
        expect(top.find(element => element.props.title === "成功出图（张）")?.props.value).toBe(5);
        expect(top.find(element => element.props.title === "模型调用次数")?.props.value).toBe(3);
        const table = tree.find(element => element.type === "Table")!;
        expect(text(table.props.columns.find((column: any) => column.title === "生成消费（元）").render(null, person))).toBe("￥0.268400");
        expect(table.props.columns.find((column: any) => column.title === "成功出图（张）").render(null, person)).toBe(5);
        expect(table.props.columns.find((column: any) => column.title === "模型调用").render(null, person)).toBe(3);
        expect(table.props.columns.find((column: any) => column.title === "最后记录").render("2026-10-29T16:00:00Z")).toBe("2026-10-30 00:00:00");
        expect(text(tree)).toContain("历史成本按原记录汇总，不按当前单价追溯重算");
        expect(text(tree)).not.toContain("供应商积分");
        table.props.columns.find((column: any) => column.title === "姓名").render(person.displayName, person).props.onClick();
        tree = await panel.settle();
        const card = tree.find(element => element.props.record?.id === record.id)!;
        const cardText = text((card.type as Function)(card.props));
        expect(cardText).toContain("已记账生成消费 ￥0.161040");
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
        tree = panel.render(); button(tree, "应用筛选").props.onClick(); tree = await panel.settle();
        const scope = { from: "2026-09-30T16:00:00.000Z", to: "2026-10-30T16:00:00.000Z", search: "张三" };
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
        expect(tree.find(element => element.props["data-testid"] === "usage-analysis-preview")?.props.children).toBe(frozenPreview.content);
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
        expect(tree.some(element => element.type === "Alert" && String(element.props.title).includes("仍可能产生费用"))).toBe(true);
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
