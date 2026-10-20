import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import ts from "typescript";

import { adjustAccountCredits, setAccountCredits } from "../src/services/api/admin-accounts";
import { getCreditPolicy, saveCreditPolicy } from "../src/services/api/credit-policy";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function elements(node: unknown): ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement(node)) return [];
    const element = node as ReactElement<any>;
    return [element, ...elements(element.props.children), ...elements(element.props.items?.map((item: any) => item.children))];
}

function harness(path: string, exportName: string, dependencies: Record<string, unknown>) {
    const url = new URL(path, import.meta.url);
    const requireModule = createRequire(url);
    const code = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const state: any[] = [];
    const effects: Array<{ deps: unknown[]; cleanup?: () => void }> = [];
    const queue: Array<() => void> = [];
    const forms: any[] = [];
    const notices: string[] = [];
    let cursor = 0;
    const equal = (first: unknown[], second?: unknown[]) => Boolean(second && first.length === second.length && first.every((value, index) => Object.is(value, second[index])));
    const Form = Object.assign(function MockForm() {}, {
        Item: "FormItem",
        useWatch: (name: string, form: any) => form.getFieldValue(name),
        useForm() {
            const index = cursor++;
            if (!state[index]) {
                const form = { fields: {} as Record<string, any>, getFieldValue(name: string) { return this.fields[name]; }, setFieldValue(name: string, value: unknown) { this.fields[name] = value; }, setFieldsValue(values: Record<string, unknown>) { Object.assign(this.fields, values); }, resetFields() { this.fields = {}; } };
                state[index] = form; forms.push(form);
            }
            return [state[index]];
        },
    });
    const mocks: Record<string, any> = {
        react: { ...React,
            lazy: () => "LazyPanel",
            useState(initial: any) { const index = cursor++; if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial; return [state[index], (next: any) => { state[index] = typeof next === "function" ? next(state[index]) : next; }]; },
            useRef(initial: unknown) { const index = cursor++; return state[index] ||= { current: initial }; },
            useEffect(effect: () => (() => void) | undefined, deps: unknown[]) { const index = cursor++; if (!equal(deps, effects[index]?.deps)) queue.push(() => { effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: effect() }; }); },
        },
        antd: new Proxy({ Form, App: { useApp: () => ({ message: { success: (text: string) => notices.push(text), error: (text: string) => notices.push(text) } }) }, Input: { Password: "Password" }, Typography: { Paragraph: "Paragraph" } }, { get: (target, key) => key in target ? target[key as keyof typeof target] : String(key) }),
        "lucide-react": new Proxy({}, { get: (_, key) => String(key) }),
        "file-saver": { saveAs() {} }, papaparse: {},
        "react-router-dom": { Link: "Link", Navigate: "Navigate", useNavigate: () => () => {}, useSearchParams: () => [new URLSearchParams(), () => {}] },
        "@/services/api/auth": { getAuthMethods: async () => ({ password: true, wecom: false, wecomLoginUrl: null }) },
        ...dependencies,
    };
    const module = { exports: {} as any };
    new Function("require", "module", "exports", code)((name: string) => Object.hasOwn(mocks, name) ? mocks[name] : requireModule(name), module, module.exports);
    const render = () => { cursor = 0; const tree = elements(module.exports[exportName]()); for (const effect of queue.splice(0)) effect(); return tree; };
    return {
        forms, notices, render,
        async settle() { let tree = render(); for (let index = 0; index < 12; index++) { await Promise.resolve(); tree = render(); } return tree; },
        dispose() { effects.forEach(effect => effect.cleanup?.()); },
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

describe("account credit contracts", () => {
    test("new disabled accounts keep the selected state and usage comes from settled ledger totals", async () => {
        const created: any[] = [];
        const panel = harness("../src/pages/admin/index.tsx", "default", {
            "@/stores/use-user-store": { isAdminRole: () => true, useUserStore: (select: Function) => select({ user: { id: "admin", role: "super_admin" } }) },
            "@/stores/use-module-store": { useModuleStore: (select: Function) => select({ flags: { performance: false } }) },
            "@/lib/deployment-features": { deploymentFeatures: { authenticationEnabled: true, oaLoginEnabled: false } },
            "./admin-overview": { loadAdminOverview: async () => ({ accounts: [{ id: "person", role: "designer", displayName: "设计师", creditLimit: 100, creditBalance: 0, monthlyCreditLimit: 100 }], totalUsedCredits: 0, departments: [], auditLogs: [], errors: [] }), resolveAdminTab: () => "accounts" },
            "@/services/api/admin-accounts": { createAccount: async (input: any) => { created.push(input); return { user: input }; } },
        });
        try {
            const tree = await panel.settle();
            const accountForm = tree.find(element => element.props.name === "admin-account" && element.props.onFinish)!;
            await accountForm.props.onFinish({ loginName: "disabled-person", name: "待启用账号", password: "Test-Only-Password123!", role: "designer", status: "disabled", quotaRemaining: 0, monthlyCreditLimit: 0 });
            expect(created[0].status).toBe("disabled");
            expect(tree.find(element => element.props.label === "累计已用积分")?.props.value).toBe("0");
            const usageTab = tree.find(element => element.type === "Tabs")?.props.items.find((item: any) => item.key === "usage-analysis");
            expect(usageTab?.children.type).toBe("LazyPanel");
        } finally { panel.dispose(); }
    });

    test("exact setting sends an absolute PUT, while additions retain independent idempotent POST requests", async () => {
        const calls: Array<{ path: string; init?: RequestInit }> = [];
        globalThis.fetch = (async (path: RequestInfo | URL, init?: RequestInit) => { calls.push({ path: String(path), init }); return Response.json({ user: { id: "person" } }); }) as typeof fetch;
        await setAccountCredits("person", 0, "设置余额");
        await adjustAccountCredits("person", 100, "项目追加");
        expect(calls.map(call => call.path)).toEqual(Array(2).fill("/api/admin/accounts/person/credits"));
        expect(calls.map(call => call.init?.method)).toEqual(["PUT", "POST"]);
        const first = JSON.parse(String(calls[0]!.init?.body));
        const second = JSON.parse(String(calls[1]!.init?.body));
        expect(first).toMatchObject({ balance: 0, reason: "设置余额" });
        expect(first.amount).toBeUndefined();
        expect(second).toMatchObject({ amount: 100, reason: "项目追加", scope: "temporary" });
        expect(typeof first.requestId).toBe("string");
        expect(first.requestId).not.toBe(second.requestId);
        expect(calls.every(call => call.init?.credentials === "include")).toBe(true);
    });

    test("account edit sends the desired balance, not a delta computed from stale displayed data", async () => {
        const person = { id: "person", username: "person", displayName: "设计师", role: "designer", status: "active", creditBalance: 500, creditLimit: 500, monthlyCreditLimit: 0 };
        let serverBalance = 480;
        const sets: number[] = [];
        const panel = harness("../src/pages/admin/index.tsx", "default", {
            "@/stores/use-user-store": { isAdminRole: () => true, useUserStore: (select: Function) => select({ user: { id: "admin", role: "super_admin" }, hydrateSession: async () => {} }) },
            "@/stores/use-module-store": { useModuleStore: (select: Function) => select({ flags: { performance: false } }) },
            "@/lib/deployment-features": { deploymentFeatures: { oaLoginEnabled: false } },
            "./admin-overview": { loadAdminOverview: async () => ({ accounts: [person, { ...person, id: "second", monthlyCreditLimit: 300 }], departments: [], auditLogs: [], errors: [] }), resolveAdminTab: () => "accounts" },
            "@/services/api/admin-accounts": {
                updateAccount: async () => ({ user: person }),
                setAccountCredits: async (_id: string, balance: number) => { sets.push(balance); serverBalance = balance; return { user: { ...person, creditBalance: balance } }; },
                adjustAccountCredits: async () => { throw new Error("exact setting must not use a relative adjustment"); },
            },
        });
        try {
            let tree = await panel.settle();
            expect(tree.find(element => element.props.label === "累计已用积分")?.props.value).toBe("—");
            expect(tree.filter(element => element.props.form && element.props.onFinish).map(element => element.props.name)).toEqual(["admin-account", "admin-credit-adjustment", "admin-monthly-credit"]);
            const department = tree.find(element => element.type === "FormItem" && element.props.name === "departmentId")!;
            expect(department.props.rules[0]({ getFieldValue: () => "designer" }).required).toBe(false);
            expect(department.props.rules[0]({ getFieldValue: () => "department_admin" }).required).toBe(true);
            const monthlyForm = tree.find(element => element.props.form === panel.forms[1] && element.props.onFinish)!;
            expect(monthlyForm.props.initialValues.monthlyCreditLimit).toBe(0);
            const monthlySelect = elements(monthlyForm).find(element => element.type === "Select")!;
            monthlySelect.props.onChange("second"); expect(panel.forms[1].fields.monthlyCreditLimit).toBe(300);
            monthlySelect.props.onChange("person"); expect(panel.forms[1].fields.monthlyCreditLimit).toBe(0);
            const table = tree.find(element => element.type === "Table" && element.props.dataSource[0]?.id === "person")!;
            const edit = table.props.columns.find((column: any) => column.title === "操作").render(null, person);
            edit.props.onClick(); tree = panel.render();
            const accountForm = tree.find(element => element.props.form === panel.forms[2] && element.props.onFinish)!;
            await accountForm.props.onFinish({ ...panel.forms[2].fields, name: person.displayName, quotaRemaining: 1000 });
            expect(sets).toEqual([1000]);
            expect(serverBalance).toBe(1000);
        } finally { panel.dispose(); }
    });
});

describe("credit policy API", () => {
    test("reads and saves a boolean at the dedicated administrator endpoint", async () => {
        const calls: Array<{ path: string; init?: RequestInit }> = [];
        globalThis.fetch = (async (path: RequestInfo | URL, init?: RequestInit) => { calls.push({ path: String(path), init }); return Response.json({ creditsEnabled: false, updatedAt: null }); }) as typeof fetch;
        await getCreditPolicy(); await saveCreditPolicy(false);
        expect(calls.map(call => call.path)).toEqual(Array(2).fill("/api/admin/credit-policy"));
        expect(calls[1]!.init?.method).toBe("PATCH");
        expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ creditsEnabled: false });
        expect(calls.every(call => call.init?.credentials === "include" && call.init.cache === "no-store")).toBe(true);
    });

    test("missing or malformed server state is not treated as disabled", async () => {
        for (const value of [{}, { creditsEnabled: "false", updatedAt: null }, { creditsEnabled: false }]) {
            globalThis.fetch = (async () => Response.json(value)) as typeof fetch;
            await expect(getCreditPolicy()).rejects.toThrow("无法确认当前状态");
        }
    });
});

describe("credit policy panel", () => {
    function policyHarness(options: { role?: string; load?: () => Promise<any>; save?: (enabled: boolean) => Promise<any>; sync?: () => Promise<boolean> } = {}) {
        const writes: boolean[] = [];
        let syncs = 0;
        const panel = harness("../src/pages/admin/components/credit-policy-panel.tsx", "CreditPolicyPanel", {
            "@/stores/use-user-store": { isAdminRole: (role: string) => ["super_admin", "department_admin"].includes(role), useUserStore: (select: Function) => select({ user: { id: "operator", role: options.role || "super_admin" } }) },
            "@/services/api/credit-policy": { getCreditPolicy: () => options.load?.() || Promise.resolve({ creditsEnabled: false, updatedAt: null }), saveCreditPolicy: async (enabled: boolean) => { writes.push(enabled); return options.save ? options.save(enabled) : { creditsEnabled: enabled, updatedAt: "now" }; } },
            "@/lib/deployment-features": { loadDeploymentFeatures: async () => { syncs++; return options.sync ? options.sync() : true; } },
        });
        return { ...panel, writes, syncs: () => syncs };
    }

    test("failed load shows unknown state and no editable default-off switch", async () => {
        const panel = policyHarness({ load: async () => { throw new Error("服务暂不可用"); } });
        try {
            const tree = await panel.settle();
            expect(tree.some(element => element.type === "Switch")).toBe(false);
            expect(tree.find(element => element.type === "Alert")!.props.title).toBe("当前计费状态未确认");
        } finally { panel.dispose(); }
    });

    test("only a confirmed save changes the switch and synchronizes deployment flags once", async () => {
        const pending = deferred<any>();
        const panel = policyHarness({ save: () => pending.promise });
        try {
            const tree = await panel.settle();
            const toggle = tree.find(element => element.type === "Switch")!;
            toggle.props.onChange(true); toggle.props.onChange(true);
            expect(panel.writes).toEqual([true]);
            const waiting = panel.render().find(element => element.type === "Switch")!;
            expect(waiting.props.checked).toBe(false); expect(waiting.props.disabled).toBe(true);
            expect(panel.syncs()).toBe(0);
            pending.resolve({ creditsEnabled: true, updatedAt: "now" });
            const saved = await panel.settle();
            expect(saved.find(element => element.type === "Switch")!.props.checked).toBe(true);
            expect(panel.syncs()).toBe(1);
        } finally { panel.dispose(); }
    });

    test("department admins can read but cannot write, even by invoking the callback", async () => {
        const panel = policyHarness({ role: "department_admin" });
        try {
            const toggle = (await panel.settle()).find(element => element.type === "Switch")!;
            expect(toggle.props.disabled).toBe(true);
            toggle.props.onChange(true); await panel.settle();
            expect(panel.writes).toEqual([]);
        } finally { panel.dispose(); }
    });

    test("uncertain save requires rereading and never claims success or retries the mutation", async () => {
        const panel = policyHarness({ save: async () => { throw new Error("连接中断"); } });
        try {
            (await panel.settle()).find(element => element.type === "Switch")!.props.onChange(true);
            const failed = await panel.settle();
            expect(panel.writes).toEqual([true]); expect(panel.syncs()).toBe(0);
            expect(failed.some(element => element.type === "Switch")).toBe(false);
            expect(failed.find(element => element.type === "Alert")!.props.description).toContain("确认保存结果");
        } finally { panel.dispose(); }
    });
});
