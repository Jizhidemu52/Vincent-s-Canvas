import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import ts from "typescript";
import { i18nHarness } from "./helpers/i18n-harness";
import { normalizePageUrl, referenceReturnPath } from "@/pages/reference-import/collect";
import { decodeReference } from "@/pages/reference-import/protocol";
import type { ReferenceScan } from "@/services/api/reference-import";

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

type CreditInput = { requestId: string; amount: number; reason?: string };
function team(options: { fail?: "once" | "always"; pending?: ReturnType<typeof deferred<void>>; refreshFail?: boolean } = {}) {
    const identity = userStore();
    const calls: Array<{ kind: string; ownerId: string; groupId: string; input: CreditInput }> = [];
    const committed = new Set<string>();
    let balance = 100, sequence = 0, loads = 0;
    const submit = async (kind: string, input: CreditInput) => {
        calls.push({ kind, ownerId: identity.user().id, groupId: identity.user().groupId, input: { ...input } });
        const duplicate = committed.has(input.requestId);
        if (!duplicate) { committed.add(input.requestId); if (kind === "contribution") balance -= input.amount; }
        if (options.pending) await options.pending.promise;
        if (options.fail === "always" || (options.fail === "once" && calls.length === 1)) throw new TypeError("Response lost after mock commit");
        return { duplicate };
    };
    const h = component("pages/team/index.tsx", {
        "@/lib/deployment-features": { deploymentFeatures: { creditsEnabled: true } },
        "@/lib/client-id": { createClientId: () => `local-id-${++sequence}` },
        "@/stores/use-user-store": { useUserStore: identity.store },
        "@/stores/use-module-store": { useModuleStore: (select: Function) => select({ flags: { performance: false } }) },
        "./team-overview": { loadTeamOverview: async () => {
            loads++;
            if (options.refreshFail && loads > 1) throw new Error("Overview refresh unavailable");
            return { myCredits: { policy: { perRequestLimit: 100 }, wallet: {}, requests: [] }, errors: [] };
        } },
        "@/services/api/group-credits": {
            submitGroupCreditRequest: (input: CreditInput) => submit("request", input),
            contributeGroupCredits: (input: CreditInput) => submit("contribution", input),
        },
    });
    const form = (kind: "request" | "contribution") => h.render().filter(node => typeof node.props.onFinish === "function")[kind === "request" ? 0 : 1]!;
    return { ...h, ...identity, calls, committed, balance: () => balance, loads: () => loads, form,
        submit: (kind: "request" | "contribution", values: { amount: number; reason?: string }) => form(kind).props.onFinish(values),
        open: (kind: "request" | "contribution") => h.render().find(node => node.props.children === (kind === "request" ? "申请小组额度" : "归还个人额度"))!.props.onClick(),
        cancel: (kind: "request" | "contribution") => h.render().filter(node => node.type === "Modal")[kind === "request" ? 0 : 1]!.props.onCancel(),
    };
}

describe("S-01 credit intent idempotency in the real Team component", () => {
    for (const kind of ["request", "contribution"] as const) {
        test(`${kind}: acknowledgement loss retries the same requestId and does not commit twice`, async () => {
            const h = team({ fail: "once" }); h.render(); await settle();
            const values = { amount: 10, ...(kind === "request" ? { reason: "mock design request" } : {}) };
            await h.submit(kind, values); await h.submit(kind, values);
            expect(h.calls).toHaveLength(2);
            expect(h.calls[1].input.requestId).toBe(h.calls[0].input.requestId);
            expect(h.committed.size).toBe(1);
            expect(h.balance()).toBe(kind === "contribution" ? 90 : 100);
            h.unmount();
        });
    }

    test("cancelling and reopening an uncertain contribution preserves its intent", async () => {
        const h = team({ fail: "once" }); h.render(); await settle(); h.open("contribution");
        await h.submit("contribution", { amount: 10 });
        h.cancel("contribution"); h.open("contribution");
        await h.submit("contribution", { amount: 10 });
        expect(h.calls[1].input.requestId).toBe(h.calls[0].input.requestId);
        expect(h.balance()).toBe(90); h.unmount();
    });

    test("amount/reason and operation type changes cannot reuse a different intent's id", async () => {
        const h = team({ fail: "always" }); h.render(); await settle();
        await h.submit("request", { amount: 10, reason: "reason-a" });
        await h.submit("request", { amount: 20, reason: "reason-a" });
        await h.submit("request", { amount: 20, reason: "reason-b" });
        await h.submit("request", { amount: 20, reason: "reason-b" });
        await h.submit("contribution", { amount: 20 });
        expect(new Set(h.calls.slice(0, 3).map(call => call.input.requestId)).size).toBe(3);
        expect(h.calls[3].input.requestId).toBe(h.calls[2].input.requestId);
        expect(h.calls[4].input.requestId).not.toBe(h.calls[3].input.requestId);
        h.unmount();
    });

    test("account/group changes isolate ids and revoke stale form callbacks including A-B-A", async () => {
        const h = team({ fail: "always" }); h.render(); await settle();
        const staleSubmit = h.form("contribution").props.onFinish;
        await staleSubmit({ amount: 10 });
        h.setUser({ id: "owner-b" }); h.render(); await settle();
        await staleSubmit({ amount: 10 });
        expect(h.calls).toHaveLength(1);
        await h.submit("contribution", { amount: 10 });
        h.setUser({ id: "owner-a", groupId: "group-b" }); h.render(); await settle();
        await h.submit("contribution", { amount: 10 });
        h.setUser({ groupId: "group-a" }); h.render(); await settle();
        await staleSubmit({ amount: 10 });
        expect(h.calls).toHaveLength(3);
        await h.submit("contribution", { amount: 10 });
        expect(new Set(h.calls.map(call => call.input.requestId)).size).toBe(4);
        expect(h.calls.map(call => [call.ownerId, call.groupId])).toEqual([["owner-a", "group-a"], ["owner-b", "group-a"], ["owner-a", "group-b"], ["owner-a", "group-a"]]);
        h.unmount();
    });

    test("POST success followed by session refresh failure is not a failed contribution or a new debit", async () => {
        const h = team(); h.setHydrate(async () => { throw new Error("session refresh unavailable"); });
        h.render(); await settle(); h.open("contribution");
        const submit = h.form("contribution").props.onFinish;
        await submit({ amount: 10 });
        expect(h.messages.success).toHaveLength(1);
        expect(h.messages.error).toEqual([]);
        expect(h.render().filter(node => node.type === "Modal")[1]!.props.open).toBe(false);
        await submit({ amount: 10 });
        expect(h.calls).toHaveLength(1);
        expect(h.balance()).toBe(90);
        h.open("contribution"); await h.submit("contribution", { amount: 10 });
        expect(h.calls).toHaveLength(2);
        expect(h.calls[1].input.requestId).not.toBe(h.calls[0].input.requestId);
        expect(h.balance()).toBe(80); h.unmount();
    });

    test("a successful application is not submitted again when overview refresh fails", async () => {
        const h = team({ refreshFail: true }); h.render(); await settle();
        const values = { amount: 10, reason: "mock design request" };
        await h.submit("request", values); await h.submit("request", values);
        expect(h.calls).toHaveLength(1);
        expect(h.messages.error).toEqual([]);
        expect(h.render().some(node => node.type === "Alert" && node.props.description?.includes("Overview refresh"))).toBe(true);
        h.unmount();
    });

    test("late acknowledgement after an account switch cannot close/reset the new account's form", async () => {
        const pending = deferred<void>();
        const h = team({ pending }); h.render(); await settle(); h.open("contribution");
        const old = h.submit("contribution", { amount: 10 });
        h.setUser({ id: "owner-b" }); h.render(); await settle();
        pending.resolve(); await old;
        expect(h.messages.success).toEqual([]);
        expect(h.messages.error).toEqual([]);
        expect(h.loads()).toBe(2);
        h.unmount();
    });
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
