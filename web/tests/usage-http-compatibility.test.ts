import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { create } from "zustand";
import * as usageContract from "../../shared/usage-analytics";
import { usageEventsSchema } from "../../server/src/usage-analytics";

// Run the actual browser UUID build, not Node's crypto implementation.
const uuidBuild = await Bun.build({ entrypoints: [fileURLToPath(new URL("../node_modules/uuid/dist/v4.js", import.meta.url))], target: "browser", format: "cjs", write: false });
if (!uuidBuild.success) throw new Error("Browser UUID fixture build failed");
const uuidCode = await uuidBuild.outputs[0].text();
const httpCrypto = { getRandomValues: crypto.getRandomValues.bind(crypto) };
function browserUuid(source: object) {
    const module = { exports: {} as any };
    new Function("crypto", "module", "exports", uuidCode)(source, module, module.exports);
    return module.exports.default;
}
function load(path: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}) {
    const url = new URL(path, import.meta.url), requireModule = createRequire(url);
    const code = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const module = { exports: {} as any };
    new Function("require", "module", "exports", ...Object.keys(globals), code)(
        (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireModule(name),
        module, module.exports, ...Object.values(globals),
    );
    return module.exports;
}
function fixture(source: object = httpCrypto, stored: unknown = null) {
    const sent: any[] = [], warnings: string[] = [];
    const uuid = { v4: browserUuid(source) };
    const clientUuid = load("../src/lib/client-uuid.ts", { uuid }, { globalThis: { crypto: source } });
    const { UsageSession } = load("../src/lib/usage-session.ts", { "./client-uuid": clientUuid, "../../../shared/usage-analytics": usageContract }, { crypto: source });
    const state = { status: "authenticated", user: { id: "http-employee", status: "active" } };
    const useUserStore = Object.assign((select: Function) => select(state), { getState: () => state, subscribe: () => undefined });
    const store = load("../src/stores/use-usage-store.ts", {
        "@/lib/client-uuid": clientUuid, zustand: { create },
        localforage: { createInstance: () => ({ ready: async () => undefined, getItem: async () => stored, setItem: async () => undefined }) },
        "@/lib/storage-access": { createStorageAccess: () => ({ run: (operation: Function) => operation() }) },
        "@/lib/usage-session": { UsageSession },
        "@/services/api/usage-client": { postUsageEvents: async (events: any[]) => { sent.push(...events); return { accepted: events.length, duplicates: 0 }; }, getMyUsage: async () => ({ boards: [], controls: [] }) },
        "@/stores/use-user-store": { useUserStore },
        "@/lib/deployment-features": { deploymentFeatures: { authenticationEnabled: true, oaLoginEnabled: false } },
    }, { crypto: source, console: { warn: (message: string) => warnings.push(message) } });
    const effects: (() => void | (() => void))[] = [], cleanups: (() => void)[] = [];
    const document = new EventTarget(), window = new EventTarget();
    const moduleState = { flags: {}, status: "ready" }, businessState = { tools: [], models: [] };
    const hook = load("../src/hooks/use-usage-tracking.ts", {
        react: { useEffect: (effect: () => void | (() => void)) => effects.push(effect) },
        "react-router-dom": { useLocation: () => ({ pathname: "/", search: "", key: "http-home" }) },
        "@/lib/deployment-features": { deploymentFeatures: { authenticationEnabled: true } },
        "@/lib/usage-event-policy": {},
        "@/lib/usage-navigation": { usageBoardForLocation: () => "home", usageBoardAvailable: () => true },
        "@/stores/use-user-store": { useUserStore },
        "@/stores/use-module-store": { useModuleStore: Object.assign((select: Function) => select(moduleState), { getState: () => moduleState }) },
        "@/stores/use-business-config-store": { useBusinessConfigStore: Object.assign((select: Function) => select(businessState), { getState: () => businessState }) },
        "@/stores/use-usage-store": store,
    }, { crypto: source, document, window });
    return {
        sent, warnings, store,
        mount() { hook.useUsageTracking(); for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); } },
        openModel() { const event = new Event("business-model-usage"); Object.defineProperty(event, "detail", { value: { action: "open" } }); window.dispatchEvent(event); },
        async flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); await store.flushUsage(); },
        dispose() { for (const cleanup of cleanups) cleanup(); store.setUsageOwner(null, false); },
    };
}

describe("HTTP usage tracking without crypto.randomUUID", () => {
    test("authenticated page and model interactions send server-valid UUID events without crashing", async () => {
        const f = fixture();
        try {
            expect(() => f.mount()).not.toThrow();
            expect(() => f.openModel()).not.toThrow();
            await f.flush();
            expect(f.sent.map(event => event.action)).toEqual(["visit", "open"]);
            expect(usageEventsSchema.safeParse({ events: f.sent }).success).toBe(true);
            expect(f.sent[0].eventId).not.toBe(f.sent[1].eventId);
        } finally { f.dispose(); }
    });
    test("unavailable random generation never escapes into page effects or interaction handlers", async () => {
        const f = fixture({});
        try {
            expect(() => f.mount()).not.toThrow();
            expect(() => f.openModel()).not.toThrow();
            await f.flush();
            expect(f.sent).toEqual([]);
            expect(f.warnings.length).toBeGreaterThan(0);
        } finally { f.dispose(); }
    });
    test("overflow reports a valid gap instead of endlessly retrying a missing native UUID function", async () => {
        const f = fixture(httpCrypto, { version: 1, counts: {}, pending: [], dropped: { home: 3 } });
        try {
            f.store.setUsageOwner("http-employee", true);
            await f.flush();
            expect(f.sent).toHaveLength(1);
            expect(f.sent[0]).toMatchObject({ action: "gap", parameters: { droppedEventCount: 3 } });
            expect(usageEventsSchema.safeParse({ events: f.sent }).success).toBe(true);
        } finally { f.dispose(); }
    });
});
