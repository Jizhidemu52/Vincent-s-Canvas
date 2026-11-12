import { i18nHarness } from "./helpers/i18n-harness";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import ts from "typescript";
import { nonFinancialTeamCsv } from "@/pages/team/team-overview";

function elements(value: unknown): ReactElement<any>[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!React.isValidElement(value)) return [];
    const element = value as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}
async function settle() { for (let index = 0; index < 20; index++) await Promise.resolve(); }

function componentHarness(path: string, exportName: string, dependencies: Record<string, unknown>) {
    const url = new URL(path, import.meta.url);
    const requireModule = createRequire(url);
    const code = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const values: unknown[] = [];
    const effects: Array<{ dependencies: unknown[]; cleanup?: () => void }> = [];
    const queue: Array<() => void> = [];
    let cursor = 0;
    const equal = (first: unknown[], second?: unknown[]) => !!second && first.length === second.length && first.every((value, index) => Object.is(value, second[index]));
    const form = { resetFields() {}, setFieldsValue() {} };
    const mocks: Record<string, unknown> = {
        "@/lib/i18n": i18nHarness,
        react: { ...React, useState(initial: unknown) { const index = cursor++; if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial; return [values[index], (next: any) => { values[index] = typeof next === "function" ? next(values[index]) : next; }]; }, useRef(initial: unknown) { const index = cursor++; return values[index] ||= { current: initial }; }, useCallback(callback: unknown, deps: unknown[]) { const index = cursor++; const previous = values[index] as any; if (!previous || !equal(deps, previous.deps)) values[index] = { callback, deps }; return (values[index] as any).callback; }, useEffect(effect: () => (() => void) | undefined, deps: unknown[]) { const index = cursor++; if (!equal(deps, effects[index]?.dependencies)) { queue.push(() => { effects[index]?.cleanup?.(); effects[index] = { dependencies: deps, cleanup: effect() }; }); } } },
        antd: new Proxy({ App: { useApp: () => ({ message: { success() {}, error() {} }, modal: { confirm() {} } }) }, Form: Object.assign("Form", { useForm: () => [form], Item: "FormItem" }), Input: { TextArea: "TextArea" }, DatePicker: { RangePicker: "RangePicker" } }, { get(target, key) { return key in target ? target[key as keyof typeof target] : String(key); } }),
        ...dependencies,
    };
    const module = { exports: {} as any };
    new Function("require", "module", "exports", code)((name: string) => Object.hasOwn(mocks, name) ? mocks[name] : requireModule(name), module, module.exports);
    return {
        render(props = {}) { cursor = 0; const result = module.exports[exportName](props); while (queue.length) queue.shift()!(); return elements(result); },
        unmount() { effects.forEach((effect) => effect.cleanup?.()); },
    };
}

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
afterEach(() => { globalThis.window = originalWindow; globalThis.document = originalDocument; URL.createObjectURL = originalCreateObjectURL; URL.revokeObjectURL = originalRevokeObjectURL; });

describe("admin/team interaction guards", () => {
    test("project supervision retains successful data when the independent assets read fails", async () => {
        const options: any[] = [];
        let params = new URLSearchParams("tab=projects&keep=unchanged");
        const designer = "11111111-1111-4111-8111-111111111111";
        const harness = componentHarness("../src/pages/admin/components/admin-assets-panel.tsx", "AdminAssetsPanel", {
            "react-router-dom": { useSearchParams: () => [params, (update: any) => { params = typeof update === "function" ? update(params) : update; }] },
            "@/stores/use-user-store": { useUserStore: (selector: any) => selector({ user: { id: "admin-a" } }) },
            "@/components/infinite-load-more": { InfiniteLoadMore: "InfiniteLoadMore" },
            "@tanstack/react-query": {
                useInfiniteQuery: (value: any) => { options.push(value); return { data: undefined, error: new Error("素材暂不可用"), isFetching: false }; },
                useQuery: (value: any) => { options.push(value); return { data: value.queryKey[0] === "admin-asset-projects" ? { projects: [{ id: "project" }] } : { owners: [{ value: designer, label: "未加载页设计师" }] }, isFetching: false }; },
            },
            "@/services/api/server-assets": { listAdminServerAssets: async () => { throw new Error("素材暂不可用"); }, listAdminServerProjects: async () => ({ projects: [{ id: "project" }] }), listAdminAssetOwners: async () => ({ owners: [] }) },
        });
        harness.render(); await settle();
        const rendered = harness.render();
        const tables = rendered.filter((element) => element.type === "Table");
        expect(tables[0].props.dataSource).toEqual([{ id: "project" }]);
        expect(tables[0].props.loading).toBe(false);
        expect(tables.every((element) => element.props.scroll.x > 0)).toBe(true);
        expect(rendered.find((element) => element.type === "Alert")!.props.description).toContain("素材暂不可用");
        const ownerSelect = rendered.find(element => element.props["aria-label"] === "按设计师筛选素材")!;
        expect(ownerSelect.props.options).toContainEqual({ value: designer, label: "未加载页设计师" });
        expect(options[0].queryKey).toEqual(["admin-assets", "admin-a", expect.objectContaining({ kind: "image", sort: "newest" })]);
        expect(options[0].retry).toBe(false);
        ownerSelect.props.onChange(designer);
        harness.render();
        expect(options.at(-3).queryKey).toEqual(["admin-assets", "admin-a", expect.objectContaining({ ownerUserId: designer, kind: "image" })]);
        expect(params.get("tab")).toBe("projects"); expect(params.get("keep")).toBe("unchanged");
        harness.unmount();
    });

    test("asset wall fetches details only after a click and closes them on filters or account changes", async () => {
        let user = { id: "admin-a" }, params = new URLSearchParams("tab=projects");
        const id = "11111111-1111-4111-8111-111111111111";
        const asset = { id, metadata: {}, filename: "完整花型.png", ownerName: "设计师", kind: "image", status: "ready", createdAt: "2026-11-01T12:00:00Z" };
        const requested: any[] = [], options: any[] = [];
        const harness = componentHarness("../src/pages/admin/components/admin-assets-panel.tsx", "AdminAssetsPanel", {
            "react-router-dom": { useSearchParams: () => [params, (update: any) => { params = update(params); }] },
            "@/stores/use-user-store": { useUserStore: (selector: any) => selector({ user }) },
            "@/components/infinite-load-more": { InfiniteLoadMore: "InfiniteLoadMore" },
            "../assets/components/asset-detail": { AssetDetail: "AssetDetail" },
            "../assets/components/asset-media": { AssetImage: "AssetImage" },
            "@tanstack/react-query": {
                useInfiniteQuery: (value: any) => { options.push(value); return { data: { pages: [{ assets: [asset] }] }, isFetching: false }; },
                useQuery: (value: any) => ({ data: value.queryKey[0] === "admin-asset-projects" ? { projects: [{ id, name: "春季项目" }] } : { owners: [] }, isFetching: false }),
            },
            "@/services/api/server-assets": { listAdminServerAssets: async (...args: any[]) => { requested.push(args); return { assets: [] }; }, listAdminServerProjects: async () => ({ projects: [] }), listAdminAssetOwners: async () => ({ owners: [] }) },
        });
        let rendered = harness.render();
        expect(rendered.some(element => element.type === "AssetDetail")).toBe(false);
        const signal = new AbortController().signal;
        await options[0].queryFn({ pageParam: "page-2", signal });
        expect(requested[0]).toEqual([expect.objectContaining({ kind: "image", limit: 60, cursor: "page-2" }), signal]);
        rendered.find(element => element.props["aria-label"] === "查看素材：完整花型.png")!.props.onClick();
        rendered = harness.render(); expect(rendered.find(element => element.type === "AssetDetail")!.props).toMatchObject({ id, userId: "admin-a" });
        rendered.find(element => element.props["aria-label"] === "素材视图")!.props.onChange("list");
        rendered = harness.render(); expect(rendered.some(element => element.type === "AssetDetail")).toBe(false);
        expect(options.at(-1).queryKey[2].kind).toBeUndefined();
        const table = rendered.filter(element => element.type === "Table")[1];
        const action = table.props.columns.at(-1).render(null, asset); action.props.onClick();
        expect(harness.render().some(element => element.type === "AssetDetail")).toBe(true);
        user = { id: "admin-b" }; rendered = harness.render();
        expect(rendered.some(element => element.type === "AssetDetail")).toBe(false);
        expect(params.toString()).toBe("tab=projects");
        harness.unmount();
    });

    test("asset detail uses cancellable scoped reads and an explicit retry without automatic retries", async () => {
        let query: any; let retried = 0;
        const requests: any[] = [];
        const harness = componentHarness("../src/pages/admin/assets/components/asset-detail.tsx", "AssetDetail", {
            "@/hooks/use-copy-text": { useCopyText: () => () => undefined },
            "@tanstack/react-query": { useQuery: (value: any) => { query = value; return { error: new Error("暂时不可用"), refetch: () => { retried++; } }; } },
            "@/services/api/server-assets": { fetchServerAsset: (...args: any[]) => { requests.push(args); return Promise.resolve({ asset: {} }); } },
        });
        const rendered = harness.render({ id: "asset-a", userId: "admin-a", onClose() {} });
        expect(query.queryKey).toEqual(["admin-asset-detail", "admin-a", "asset-a"]);
        expect(query.retry).toBe(false); expect(query.refetchOnWindowFocus).toBe(false);
        const signal = new AbortController().signal; await query.queryFn({ signal });
        expect(requests).toEqual([["asset-a", signal]]);
        rendered.find(element => element.type === "Alert")!.props.action.props.onClick();
        expect(retried).toBe(1); harness.unmount();
    });

    test("team ignores late data after the account/group changes", async () => {
        let user = { id: "old-user", groupId: "old-group", groupRole: "leader", creditBalance: 100 };
        const pending = [deferred<any>(), deferred<any>()];
        let calls = 0;
        const harness = componentHarness("../src/pages/team/index.tsx", "default", {
            "@/lib/deployment-features": { deploymentFeatures: { creditsEnabled: true } },
            "@/stores/use-user-store": { useUserStore: Object.assign((selector: any) => selector({ user, hydrateSession: async () => undefined }), { getState: () => ({ user }) }) },
            "@/stores/use-module-store": { useModuleStore: (selector: any) => selector({ flags: { performance: false } }) },
            "./team-overview": { loadTeamOverview: () => pending[calls++].promise },
        });
        harness.render();
        user = { ...user, id: "new-user", groupId: "new-group" };
        harness.render();
        const data = (id: string) => ({ overview: { group: { name: id, memberCount: 1 }, summary: { taskCount: 1, successCount: 1 }, members: [{ id }] }, history: [{ id }], auditLogs: [], errors: [] });
        pending[1].resolve(data("new-task")); await settle();
        pending[0].resolve(data("old-task")); await settle();
        const tables = harness.render().filter((element) => element.type === "Table");
        expect(tables).toHaveLength(3);
        expect(tables[0].props.dataSource).toEqual([{ id: "new-task" }]);
        expect(tables[1].props.dataSource).toEqual([{ id: "new-task" }]);
        harness.unmount();
    });

    test("same-tick result action submits once without financial controls and releases after completion", async () => {
        const pending = deferred<any>();
        let submitted = 0;
        const harness = componentHarness("../src/pages/team/index.tsx", "default", {
            "@/lib/deployment-features": { deploymentFeatures: { creditsEnabled: true } },
            "@/stores/use-user-store": { useUserStore: Object.assign((selector: any) => selector({ user: { id: "user", groupId: "group", groupRole: "leader", creditBalance: 100 } }), { getState: () => ({ user: { id: "user", groupId: "group" } }) }) },
            "@/stores/use-module-store": { useModuleStore: (selector: any) => selector({ flags: { performance: false } }) },
            "./team-overview": { loadTeamOverview: async () => ({ assets: [{ id: "asset", kind: "image", filename: "花型.png", resultStatus: "unused" }], auditLogs: [{ id: "money", action: "account.credits.adjust" }, { id: "asset-audit", action: "asset.adopted" }], errors: [] }) },
            "@/services/api/server-assets": { recordServerAssetEvent: () => { submitted++; return pending.promise; } },
        });
        harness.render(); await settle();
        let rendered = harness.render();
        expect(rendered.some(element => typeof element.props.onFinish === "function")).toBe(false);
        expect(rendered.some(element => typeof element.props.children === "string" && /积分|额度|累计成本|共享池/.test(element.props.children))).toBe(false);
        const tables = rendered.filter(element => element.type === "Table");
        expect(tables.every(table => table.props.columns.every((column: any) => !["credits", "rmbCost", "creditBalance", "monthlyCreditLimit"].includes(column.dataIndex)))).toBe(true);
        expect(tables.at(-1)!.props.dataSource).toEqual([{ id: "asset-audit", action: "asset.adopted" }]);
        const action = () => harness.render().find(element => element.props.children === "确认采用")!;
        const submit = action().props.onClick;
        submit(); submit();
        expect(submitted).toBe(1);
        expect(action().props.disabled).toBe(true);
        pending.resolve({}); await settle();
        expect(action().props.disabled).toBe(false);
        harness.unmount();
    });

    test("disabled credits hide the direct team URL without loading credit endpoints", async () => {
        let loaded = 0;
        const harness = componentHarness("../src/pages/team/index.tsx", "default", {
            "@/lib/deployment-features": { deploymentFeatures: { creditsEnabled: false } },
            "@/stores/use-user-store": { useUserStore: (selector: any) => selector({ user: { id: "user", groupId: "group", groupRole: "leader" } }) },
            "@/stores/use-module-store": { useModuleStore: (selector: any) => selector({ flags: {} }) },
            "./team-overview": { loadTeamOverview: async () => { loaded++; return {}; } },
        });
        const blocked = harness.render();
        expect(blocked.some(element => element.props.role === "alert")).toBe(true);
        expect(blocked.some(element => element.props.children === "当前未启用小组功能。")).toBe(true);
        expect(blocked.some(element => element.props.to === "/")).toBe(true);
        await settle();
        expect(loaded).toBe(0);
        harness.unmount();
    });

    for (const switchedAccount of [false, true]) test(`team export remains audited and deduplicated${switchedAccount ? " without a stale-account download" : " with only nonfinancial columns"}`, async () => {
        let user = { id: "user-a", groupId: "group-a", groupRole: "leader" };
        const pending = deferred<Blob>();
        const downloads: Blob[] = [];
        let exported = 0, clicked = 0, revoked = 0;
        const link = { href: "", download: "", click: () => { clicked++; } };
        globalThis.document = { createElement: () => link } as unknown as Document;
        globalThis.window = { setTimeout: (callback: () => void) => { callback(); return 1; } } as unknown as Window & typeof globalThis;
        URL.createObjectURL = ((blob: Blob) => { downloads.push(blob); return "blob:team-export"; }) as typeof URL.createObjectURL;
        URL.revokeObjectURL = () => { revoked++; };
        const harness = componentHarness("../src/pages/team/index.tsx", "default", {
            "@/lib/deployment-features": { deploymentFeatures: { creditsEnabled: true } },
            "@/stores/use-user-store": { useUserStore: Object.assign((selector: any) => selector({ user }), { getState: () => ({ user }) }) },
            "@/stores/use-module-store": { useModuleStore: (selector: any) => selector({ flags: { performance: false } }) },
            "./team-overview": { loadTeamOverview: async () => ({ history: [{ id: "history-a" }], errors: [] }), nonFinancialTeamCsv },
            "@/services/api/groups": { exportTeamHistory: () => { exported++; return pending.promise; } },
        });
        harness.render(); await settle();
        const exportButton = () => harness.render().find(element => element.props.children === "导出本组报表")!;
        const download = exportButton().props.onClick;
        download(); download();
        expect(exported).toBe(1);
        expect(exportButton().props.disabled).toBe(true);
        if (switchedAccount) { user = { ...user, id: "user-b", groupId: "group-b" }; harness.render(); }
        pending.resolve(new Blob(['时间,设计师,功能板块,模型,完整提示词,积分,人民币成本,状态,失败原因\r\n2026,小张,image,测试模型,"图案,换行\n保持",12,0.53,success,']));
        await settle();
        expect(clicked).toBe(switchedAccount ? 0 : 1);
        expect(revoked).toBe(switchedAccount ? 0 : 1);
        if (!switchedAccount) {
            expect(await downloads[0].text()).toBe('"时间","设计师","功能板块","模型","完整提示词","状态","失败原因"\r\n"2026","小张","image","测试模型","图案,换行\n保持","success",""');
            expect(link.download).toBe("本组-历史报表.csv");
            expect(exportButton().props.disabled).toBe(false);
        }
        harness.unmount();
    });

    test("task cursor queries are account-scoped and skip hidden documents and inactive tabs", async () => {
        globalThis.document = { hidden: false } as Document;
        const options: any[] = [];
        const requested: unknown[] = [];
        const harness = componentHarness("../src/pages/admin/components/task-history-panels.tsx", "TaskManagementPanel", {
            "@/stores/use-user-store": { useUserStore: (selector: any) => selector({ user: { id: "admin-a" } }) },
            "@/components/infinite-load-more": { InfiniteLoadMore: "InfiniteLoadMore" },
            "./task-reconciliation-panel": { TaskReconciliationPanel: "TaskReconciliationPanel" },
            "@tanstack/react-query": { useInfiniteQuery: (value: any) => { options.push(value); return { data: { pages: [{ tasks: [], batches: [] }] }, isPending: false, isFetching: false, dataUpdatedAt: 0, refetch() {} }; } },
            "@/services/api/task-history": { listAdminTasks: async (query: unknown) => { requested.push(query); return { tasks: [], nextCursor: null }; }, listAdminBatches: async () => ({ batches: [], nextCursor: null }) },
        });
        const rendered = harness.render({ active: true });
        const queuedAtColumn = rendered.filter(element => element.type === "Table")[1].props.columns.find((column: any) => column.dataIndex === "queuedAt");
        expect(queuedAtColumn.title).toContain("北京时间");
        expect(queuedAtColumn.render("2026-10-29T17:02:03Z")).toBe("2026-10-30 01:02:03");
        expect(options[0].queryKey).toEqual(["admin-tasks", "admin-a"]);
        expect(options[1].queryKey).toEqual(["admin-batches", "admin-a"]);
        expect(options[0].enabled).toBe(true);
        expect(options[0].refetchInterval()).toBe(10_000);
        expect(options[0].retry).toBe(false);
        expect(options[0].refetchInterval({ state: { status: "error" } })).toBe(false);
        (globalThis.document as any).hidden = true;
        expect(options[0].refetchInterval()).toBe(false);
        await options[0].queryFn({ pageParam: "next-page-cursor" });
        expect(requested).toEqual([{ cursor: "next-page-cursor", limit: 60 }]);
        expect(options[0].getNextPageParam({ nextCursor: "more" })).toBe("more");
        expect(options[0].getNextPageParam({ nextCursor: null })).toBeUndefined();
        harness.render({ active: false });
        expect(options[2].enabled).toBe(false);
        expect(options[3].enabled).toBe(false);
        harness.unmount();
    });

    test("consumption history renders Beijing time while retaining the original timestamp", async () => {
        const record = { id: "history-a", createdAt: "2026-10-29T17:02:03Z", rmbCost: 0.05368 };
        const harness = componentHarness("../src/pages/admin/components/task-history-panels.tsx", "HistoryManagementPanel", {
            "@/stores/use-user-store": { useUserStore: (selector: any) => selector({ user: { id: "admin-a" } }) },
            "@/components/infinite-load-more": { InfiniteLoadMore: "InfiniteLoadMore" },
            "./task-reconciliation-panel": { TaskReconciliationPanel: "TaskReconciliationPanel" },
            "@/hooks/use-workbench-field": { useWorkbenchField: (_key: string, initial: unknown) => [initial, () => undefined] },
            "@tanstack/react-query": { useInfiniteQuery: () => ({ data: { pages: [{ history: [record], total: 1 }] }, isPending: false, isFetching: false }) },
            "@/services/api/task-history": { listAdminHistoryOptions: async () => ({ users: [], models: [], operations: [] }) },
        });
        try {
            const table = harness.render().find(element => element.type === "Table")!;
            const column = table.props.columns.find((item: any) => item.dataIndex === "createdAt");
            expect(column.title).toContain("北京时间");
            expect(column.render(table.props.dataSource[0].createdAt)).toBe("2026-10-30 01:02:03");
            expect(record.createdAt).toBe("2026-10-29T17:02:03Z");
            await settle();
        } finally { harness.unmount(); }
    });
});
