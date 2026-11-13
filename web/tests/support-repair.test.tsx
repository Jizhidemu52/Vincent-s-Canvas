import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import ts from "typescript";
import { i18nHarness } from "./helpers/i18n-harness";
import { displayHooksHarness } from "./helpers/display-hooks-harness";
import { normalizePageUrl, referenceReturnPath } from "@/pages/reference-import/collect";
import { decodeReference } from "@/pages/reference-import/protocol";
import type { ReferenceScan } from "@/services/api/reference-import";
import { contributeGroupCredits, submitGroupCreditRequest } from "@/services/api/group-credits";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function elements(value: unknown): ReactElement<any>[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!React.isValidElement(value)) return [];
    const element = value as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
async function settle() { for (let index = 0; index < 40; index++) await Promise.resolve(); }
type User = { id: string; groupId: string; groupRole: string; creditBalance: number };
function userStore(initial: Partial<User> = {}) {
    let user: User = { id: "owner-a", groupId: "group-a", groupRole: "member", creditBalance: 100, ...initial };
    const listeners: Array<(value: { user: User }) => void> = [];
    let hydrate = async () => {};
    const store = Object.assign((selector: Function) => selector({ user, status: "authenticated", hydrateSession: () => hydrate() }), {
        getState: () => ({ user, status: "authenticated" }),
        subscribe: (listener: typeof listeners[number]) => { listeners.push(listener); return () => {}; },
    });
    return { store, user: () => user, setUser: (changes: Partial<User>) => { user = { ...user, ...changes }; listeners.forEach(listener => listener({ user })); }, setHydrate: (value: typeof hydrate) => { hydrate = value; } };
}

// The real component bodies execute; only framework, browser, and business IO are mocked.
// No server, provider, session credential, real clipboard, or actual credit balance is used.
function component(path: string, mocks: Record<string, unknown>, browser: Record<string, unknown> = {}) {
    const url = new URL(`../src/${path}`, import.meta.url);
    const localRequire = createRequire(url);
    const code = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const values: any[] = [], effects: Array<{ deps: unknown[]; cleanup?: () => void }> = [], queue: Array<() => void> = [];
    const messages = { success: [] as string[], error: [] as string[], warning: [] as string[] };
    let cursor = 0;
    const equal = (a: unknown[], b?: unknown[]) => !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
    const form = { resetFields() {}, setFieldsValue() {} };
    const dependencies: Record<string, unknown> = {
        "@/lib/i18n": i18nHarness,
        "@/hooks/use-display-text": displayHooksHarness,
        react: { ...React,
            useState(initial: any) { const index = cursor++; if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial; return [values[index], (value: any) => { values[index] = typeof value === "function" ? value(values[index]) : value; }]; },
            useRef(initial: any) { const index = cursor++; return values[index] ||= { current: initial }; },
            useEffect(action: () => void | (() => void), deps: unknown[]) { const index = cursor++; if (!equal(deps, effects[index]?.deps)) queue.push(() => { effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: action() || undefined }; }); },
        },
        antd: new Proxy({
            App: { useApp: () => ({ message: Object.fromEntries(Object.keys(messages).map(key => [key, (text: string) => messages[key as keyof typeof messages].push(text)])), modal: { confirm() {} } }) },
            Form: Object.assign("Form", { useForm: () => [form], Item: "FormItem" }),
            Input: Object.assign("Input", { TextArea: "TextArea" }),
        }, { get: (target, key) => key in target ? target[key as keyof typeof target] : String(key) }),
        "react-router-dom": { Link: "Link" },
        "@/components/design-examples": { PracticeExampleRecord: "PracticeExampleRecord" },
        ...mocks,
    };
    const output = { exports: {} as any };
    new Function("require", "module", "exports", "window", "fetch", code)(
        (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : localRequire(name), output, output.exports, browser,
        () => { throw new Error("Support repair tests forbid external network"); },
    );
    return {
        messages,
        render() { cursor = 0; const result = elements(output.exports.default()); while (queue.length) queue.shift()!(); return result; },
        unmount() { effects.forEach(effect => effect.cleanup?.()); },
    };
}

function team(options: { enabled?: boolean; groupId?: string; role?: string } = {}) {
    const identity = userStore({ groupId: options.groupId ?? "group-a", groupRole: options.role ?? "member" });
    const calls: Array<{ path: string; method: string }> = [];
    const responses: Record<string, unknown> = {
        "/api/team": { group: { id: "group-a", name: "设计组", memberCount: 1 }, summary: { taskCount: 3, successCount: 2, credits: 900, rmbCost: 87 }, members: [{ id: "member", displayName: "设计师", username: "designer", role: "member", creditBalance: 100, monthlyCreditLimit: 300 }] },
        "/api/team/history": { history: [{ id: "history", prompt: "完整原提示词", status: "success", credits: 4, rmbCost: 0.4 }] },
        "/api/team/audit": { auditLogs: [{ id: "nonfinancial", action: "asset.adopted" }, { id: "financial", action: "group.credit_contributed" }] },
        "/api/assets/summary": { assets: [], total: 0 },
    };
    globalThis.fetch = (async (input, init) => {
        const path = String(input), method = init?.method || "GET";
        calls.push({ path, method });
        if (method !== "GET" || !(path in responses)) throw new Error(`Unexpected Team request: ${method} ${path}`);
        return Response.json(responses[path]);
    }) as typeof fetch;
    const h = component("pages/team/index.tsx", {
        "@/lib/deployment-features": { deploymentFeatures: { creditsEnabled: options.enabled ?? true } },
        "@/stores/use-user-store": { useUserStore: identity.store },
        "@/stores/use-module-store": { useModuleStore: (select: Function) => select({ flags: { performance: false } }) },
    });
    return { ...h, ...identity, calls };
}

describe("S-01 retired Team financial UI and retained API contracts", () => {
    for (const role of ["member", "leader"]) test(`${role}: the real Team and overview loader expose no financial action or endpoint`, async () => {
        const h = team({ role }); h.render(); await settle();
        const rendered = h.render();
        expect(rendered.some(node => typeof node.props.onFinish === "function" || node.type === "Modal")).toBe(false);
        expect(rendered.some(node => typeof node.props.children === "string" && /积分|额度|成本|共享池/.test(node.props.children))).toBe(false);
        const tables = rendered.filter(node => node.type === "Table");
        expect(tables.every(table => table.props.columns.every((column: any) => !["credits", "rmbCost", "creditBalance", "monthlyCreditLimit"].includes(column.dataIndex)))).toBe(true);
        if (role === "leader") {
            expect(h.calls.map(call => call.path).sort()).toEqual(["/api/assets/summary", "/api/team", "/api/team/audit", "/api/team/history"]);
            expect(tables.at(-1)!.props.dataSource).toEqual([{ id: "nonfinancial", action: "asset.adopted" }]);
            expect(tables[1].props.dataSource[0].prompt).toBe("完整原提示词");
        } else expect(h.calls).toEqual([]);
        rendered.find(node => node.props.children === "刷新")!.props.onClick(); await settle();
        expect(h.calls.every(call => call.method === "GET" && !call.path.includes("credits"))).toBe(true);
        expect(h.messages.error).toEqual([]);
        h.unmount();
    });

    for (const options of [{ enabled: false }, { groupId: "" }]) test(`original Team gate stays closed without financial or team reads: ${JSON.stringify(options)}`, async () => {
        const h = team({ role: "leader", ...options }); const rendered = h.render(); await settle();
        expect(rendered.some(node => node.props.role === "alert")).toBe(true);
        expect(rendered.some(node => node.props.children === "小组功能暂不可用")).toBe(true);
        expect(h.calls).toEqual([]);
        h.unmount();
    });

    test("account/group A-B-A and member/leader changes never reintroduce a financial form or request", async () => {
        const h = team(); h.render(); await settle();
        for (const identity of [{ id: "owner-b", groupRole: "leader" }, { id: "owner-a", groupId: "group-b" }, { groupId: "group-a", groupRole: "member" }]) {
            h.setUser(identity); h.render(); await settle();
            expect(h.render().some(node => typeof node.props.onFinish === "function" || node.type === "Modal")).toBe(false);
        }
        expect(h.calls).toHaveLength(8);
        expect(h.calls.every(call => call.method === "GET" && !call.path.includes("credits"))).toBe(true);
        expect(h.messages.error).toEqual([]);
        h.unmount();
    });

    // The UI is retired, not the API. These are transport-contract tests; the
    // unchanged server identity-rbac integration suite covers database idempotency.
    for (const kind of ["request", "contribution"] as const) {
        const path = `/api/group-credits/${kind === "request" ? "requests" : "contributions"}`;
        const input = { requestId: `explicit-${kind}-intent`, amount: 10, ...(kind === "request" ? { reason: "original reason" } : {}) };
        const send = () => kind === "request" ? submitGroupCreditRequest({ ...input, reason: input.reason! }) : contributeGroupCredits(input);
        for (const failure of ["acknowledgement-loss", "http-rejection"] as const) test(`${kind}: ${failure} does not auto-retry and an explicit retry keeps the exact requestId and payload`, async () => {
            const calls: Array<{ path: string; init?: RequestInit }> = [];
            globalThis.fetch = (async (url, init) => {
                calls.push({ path: String(url), init });
                if (calls.length === 1) {
                    if (failure === "acknowledgement-loss") throw new TypeError("Mock acknowledgement lost");
                    return Response.json({ message: "Mock rejected" }, { status: 409 });
                }
                return Response.json({ duplicate: true });
            }) as typeof fetch;
            await expect(send()).rejects.toThrow(failure === "acknowledgement-loss" ? "Mock acknowledgement lost" : "Mock rejected");
            await settle(); expect(calls).toHaveLength(1);
            await expect(send()).resolves.toEqual({ duplicate: true });
            expect(calls).toHaveLength(2);
            for (const call of calls) {
                expect(call.path).toBe(path);
                expect(call.init).toMatchObject({ method: "POST", credentials: "include", headers: { "content-type": "application/json" } });
                expect(JSON.parse(String(call.init!.body))).toEqual(input);
            }
        });
    }
});

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
function scanFor(id: string, pageUrl = `https://source-${id.toLowerCase()}.invalid/`): ReferenceScan {
    return { scanId: `scan-${id}`, pageUrl, pageTitle: id, candidates: [{ id: `candidate-${id}`, name: `${id}.png`, sourceImage: `${pageUrl}${id}.png` }], warnings: [], expiresAt: "2099-01-01T00:00:00Z" };
}
function reference(options: { scan?: (url: string, signal: AbortSignal) => Promise<ReferenceScan>; collect?: (input: any) => Promise<void> } = {}) {
    const identity = userStore();
    const scans: Array<{ url: string; signal: AbortSignal }> = [], reads: any[] = [], uploads: any[] = [];
    let sequence = 0;
    const h = component("pages/reference-import/index.tsx", {
        "@/stores/use-user-store": { useUserStore: identity.store },
        "@/lib/client-id": { createClientId: () => `draft-${++sequence}` },
        "@/services/api/auth": { getCurrentSession: async () => ({ user: identity.user() }) },
        "@/services/api/server-assets": { uploadServerAsset: async (...args: unknown[]) => { uploads.push(args); return {}; } },
        "./collect": { normalizePageUrl, referenceReturnPath, collectReferencePage: async (input: any) => { reads.push(input); await options.collect?.(input); } },
        "@/services/api/reference-import": { scanReferencePage: async (url: string, _owner: string, signal: AbortSignal) => { scans.push({ url, signal }); return options.scan ? options.scan(url, signal) : scanFor("A", url); } },
    }, {
        location: { hash: "", search: "", origin: "https://local.invalid" }, addEventListener() {}, removeEventListener() {},
        Image: class { src = ""; naturalWidth = 1; naturalHeight = 1; async decode() {} },
    });
    return { ...h, ...identity, scans, reads, uploads,
        changeUrl: (value: string) => h.render().find(node => node.props.id === "reference-page-url")!.props.onChange({ target: { value } }),
        startScan: () => h.render().find(node => node.type === "form")!.props.onSubmit({ preventDefault() {} }),
        reader: () => h.render().find(node => Array.isArray(node.props.children) && node.props.children[0] === "读取所选 "),
        candidates: () => h.render().find(node => node.props["aria-label"] === "网页候选图片"),
        cancel: () => h.render().find(node => node.props.children === "取消采集")!.props.onClick(),
        drafts: () => h.render().filter(node => node.props["data-testid"] === "reference-draft"),
    };
}

describe("S-02 scan identity and draft preservation in the real Reference page", () => {
    test("editing URL immediately invalidates old candidates and a retained old read callback", async () => {
        const h = reference(); h.render(); h.changeUrl("https://source-a.invalid/"); h.startScan(); await settle();
        const oldReader = h.reader()!.props.onClick;
        expect(h.candidates()).toBeDefined();
        h.changeUrl("https://source-b.invalid/");
        oldReader(); await settle();
        expect(h.candidates()).toBeUndefined();
        expect(h.reads).toEqual([]); h.unmount();
    });

    test("a replacement scan invalidates old candidates before it resolves, including same URL", async () => {
        let requests = 0; const next = deferred<ReferenceScan>();
        const h = reference({ scan: async () => ++requests === 1 ? scanFor("A") : next.promise });
        h.render(); h.changeUrl("https://source-a.invalid/"); h.startScan(); await settle();
        const oldReader = h.reader()!.props.onClick;
        h.startScan();
        expect(h.candidates()).toBeUndefined();
        h.cancel(); oldReader(); await settle();
        next.resolve(scanFor("old-late")); await settle();
        expect(h.candidates()).toBeUndefined(); expect(h.reads).toEqual([]); h.unmount();
    });

    test("failed replacement B cannot expose or read A's candidates", async () => {
        const h = reference({ scan: async url => { if (url.includes("source-b")) throw new Error("mock B failed"); return scanFor("A"); } });
        h.render(); h.changeUrl("https://source-a.invalid/"); h.startScan(); await settle();
        h.changeUrl("https://source-b.invalid/"); h.startScan(); await settle();
        expect(h.reader()).toBeUndefined();
        expect(h.candidates()).toBeUndefined();
        expect(h.reads).toEqual([]); h.unmount();
    });

    test("late A cannot overwrite B after cancel and a new scan", async () => {
        const a = deferred<ReferenceScan>(), b = deferred<ReferenceScan>();
        const h = reference({ scan: url => url.includes("source-a") ? a.promise : b.promise });
        h.render(); h.changeUrl("https://source-a.invalid/"); h.startScan();
        h.cancel(); h.changeUrl("https://source-b.invalid/"); h.startScan();
        b.resolve(scanFor("B")); await settle();
        a.resolve(scanFor("A")); await settle();
        h.reader()!.props.onClick(); await settle();
        expect(h.scans[0].signal.aborted).toBe(true);
        expect(h.reads).toHaveLength(1); expect(h.reads[0].scan.scanId).toBe("scan-B");
        expect(h.reads[0].url).toBe("https://source-b.invalid/"); h.unmount();
    });

    test("query-bearing input binds to its scan even when the service reports a sanitized redirect URL", async () => {
        const h = reference({ scan: async () => scanFor("A", "https://cdn.invalid/redirected") });
        h.render(); h.changeUrl(" https://source-a.invalid/?sort=new#section "); h.startScan(); await settle();
        h.reader()!.props.onClick(); await settle();
        expect(h.reads).toHaveLength(1);
        expect(h.reads[0].url).toBe("https://source-a.invalid/?sort=new");
        expect(h.reads[0].scanInputUrl).toBe("https://source-a.invalid/?sort=new");
        expect(h.reads[0].scan.pageUrl).toBe("https://cdn.invalid/redirected"); h.unmount();
    });

    for (const imported of [false, true]) test(`changing URL preserves ${imported ? "already imported" : "pending review"} drafts and never starts another scan over them`, async () => {
        const decoded = decodeReference({ id: "image-A", mime: "image/png", name: "A.png", base64: png, sourcePage: "https://source-a.invalid/", sourceImage: "https://source-a.invalid/A.png", pageTitle: "A" });
        const h = reference({ collect: async input => { input.onImage(decoded); } });
        h.render(); h.changeUrl("https://source-a.invalid/"); h.startScan(); await settle();
        h.reader()!.props.onClick(); await settle();
        if (imported) { h.render().find(node => node.props["data-testid"] === "reference-confirm")!.props.onClick(); await settle(); }
        const original = h.drafts()[0].props.children[0].props.src;
        h.changeUrl("https://source-b.invalid/"); h.startScan(); await settle();
        expect(h.drafts()).toHaveLength(1);
        expect(h.drafts()[0].props.children[0].props.src).toBe(original);
        expect(h.scans).toHaveLength(1);
        expect(h.uploads).toHaveLength(imported ? 1 : 0); h.unmount();
    });

    test("identity changes still cancel a scan and suppress its late result", async () => {
        const late = deferred<ReferenceScan>(); const h = reference({ scan: () => late.promise });
        h.render(); h.changeUrl("https://source-a.invalid/"); h.startScan();
        h.setUser({ id: "owner-b" });
        late.resolve(scanFor("A")); await settle();
        expect(h.scans[0].signal.aborted).toBe(true);
        expect(h.candidates()).toBeUndefined(); expect(h.drafts()).toEqual([]); h.unmount();
    });
});
