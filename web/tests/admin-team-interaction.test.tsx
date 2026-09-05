import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import ts from "typescript";

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
afterEach(() => { globalThis.window = originalWindow; globalThis.document = originalDocument; });

describe("admin/team interaction guards", () => {
    test("project supervision retains successful data when the independent assets read fails", async () => {
        const harness = componentHarness("../src/pages/admin/components/admin-assets-panel.tsx", "AdminAssetsPanel", {
            "@/services/api/server-assets": { listAdminServerAssets: async () => { throw new Error("素材暂不可用"); }, listAdminServerProjects: async () => ({ projects: [{ id: "project" }] }) },
        });
        harness.render(); await settle();
        const rendered = harness.render();
        const tables = rendered.filter((element) => element.type === "Table");
        expect(tables[0].props.dataSource).toEqual([{ id: "project" }]);
        expect(tables[0].props.loading).toBe(false);
        expect(tables.every((element) => element.props.scroll.x > 0)).toBe(true);
        expect(rendered.find((element) => element.type === "Alert")!.props.description).toContain("素材暂不可用");
        harness.unmount();
    });

    test("team ignores late data after the account/group changes", async () => {
        let user = { id: "old-user", groupId: "old-group", groupRole: "member", creditBalance: 100 };
        const pending = [deferred<any>(), deferred<any>()];
        let calls = 0;
        const harness = componentHarness("../src/pages/team/index.tsx", "default", {
            "@/stores/use-user-store": { useUserStore: (selector: any) => selector({ user, hydrateSession: async () => undefined }) },
            "@/stores/use-module-store": { useModuleStore: (selector: any) => selector({ flags: { performance: false } }) },
            "./team-overview": { loadTeamOverview: () => pending[calls++].promise },
        });
        harness.render();
        user = { ...user, id: "new-user", groupId: "new-group" };
        harness.render();
        const credits = (id: string) => ({ myCredits: { policy: {}, wallet: {}, requests: [{ id }] }, errors: [] });
        pending[1].resolve(credits("new-request")); await settle();
        pending[0].resolve(credits("old-request")); await settle();
        const tables = harness.render().filter((element) => element.type === "Table");
        expect(tables).toHaveLength(1);
        expect(tables[0].props.dataSource).toEqual([{ id: "new-request" }]);
        harness.unmount();
    });

    test("same-tick double submit sends one credit request and releases after completion", async () => {
        const pending = deferred<any>();
        let submitted = 0;
        const harness = componentHarness("../src/pages/team/index.tsx", "default", {
            "@/stores/use-user-store": { useUserStore: (selector: any) => selector({ user: { id: "user", groupId: "group", groupRole: "member", creditBalance: 100 }, hydrateSession: async () => undefined }) },
            "@/stores/use-module-store": { useModuleStore: (selector: any) => selector({ flags: { performance: false } }) },
            "./team-overview": { loadTeamOverview: async () => ({ myCredits: { policy: {}, wallet: {}, requests: [] }, errors: [] }) },
            "@/services/api/group-credits": { submitGroupCreditRequest: () => { submitted++; return pending.promise; } },
        });
        harness.render(); await settle();
        const submit = harness.render().find((element) => typeof element.props.onFinish === "function")!.props.onFinish;
        const first = submit({ amount: 10, reason: "测试申请" });
        await submit({ amount: 10, reason: "测试申请" });
        expect(submitted).toBe(1);
        expect(harness.render().find((element) => typeof element.props.onFinish === "function")!.props.disabled).toBe(true);
        pending.resolve({}); await first;
        expect(harness.render().find((element) => typeof element.props.onFinish === "function")!.props.disabled).toBe(false);
        harness.unmount();
    });

    test("task polling skips hidden documents, overlaps, and inactive tabs", async () => {
        const timers = new Map<number, () => void>();
        globalThis.window = { setInterval(callback: () => void) { timers.set(1, callback); return 1; }, clearInterval(id: number) { timers.delete(id); } } as unknown as Window & typeof globalThis;
        globalThis.document = { hidden: false } as Document;
        const pending = deferred<any>();
        let reads = 0;
        const harness = componentHarness("../src/pages/admin/components/task-history-panels.tsx", "TaskManagementPanel", {
            "@/services/api/task-history": { listAdminTasks: () => { reads++; return pending.promise; }, listAdminBatches: async () => ({ batches: [] }) },
        });
        harness.render({ active: true });
        timers.get(1)!(); timers.get(1)!();
        expect(reads).toBe(1);
        pending.resolve({ tasks: [] }); await settle();
        (globalThis.document as any).hidden = true;
        timers.get(1)!(); expect(reads).toBe(1);
        (globalThis.document as any).hidden = false;
        timers.get(1)!(); await settle(); expect(reads).toBe(2);
        harness.render({ active: false });
        expect(timers.size).toBe(0);
        harness.unmount();
    });
});
