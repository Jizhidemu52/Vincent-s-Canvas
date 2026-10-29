import { i18nHarness } from "./helpers/i18n-harness";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { useDesignLibraryShare } from "@/pages/design-library/use-design-library-share";
import type { DesignLibraryShareSource } from "@/pages/design-library/share-draft";

const code = ts.transpileModule(readFileSync(new URL("../src/pages/design-library/use-design-library-share.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
}).outputText;
const source: DesignLibraryShareSource = { ownerId: "owner-a", title: "原设计" };

function harness(options: { oa?: boolean; enabled?: boolean; role?: string; fail?: boolean } = {}) {
    const state = { status: "authenticated", user: { id: "owner-a", role: options.role || "designer", status: "active" } };
    const listeners = new Set<(state: typeof state) => void>();
    const values: any[] = [], cleanups: Array<() => void> = [], notices: string[] = [], navigations: any[] = [], requests: AbortSignal[] = [];
    const entered = Promise.withResolvers<void>(), response = Promise.withResolvers<void>();
    let cursor = 0, mounted = false;
    const dependencies: Record<string, unknown> = {
        "@/lib/i18n": i18nHarness,
        react: {
            useState: (initial: unknown) => { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], (next: unknown) => { values[index] = next; }]; },
            useRef: (initial: unknown) => { const index = cursor++; return values[index] ||= { current: initial }; },
            useEffect: (effect: () => () => void) => { if (!mounted) cleanups.push(effect()); },
        },
        antd: { App: { useApp: () => ({ message: { info: (value: string) => notices.push(value), error: (value: string) => notices.push(value) } }) } },
        "react-router-dom": { useNavigate: () => (...args: unknown[]) => navigations.push(args) },
        "@/lib/deployment-features": { deploymentFeatures: { oaLoginEnabled: options.oa ?? true } },
        "@/stores/use-module-store": { useModuleEnabled: () => options.enabled ?? true },
        "@/stores/use-user-store": { useUserStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
            getState: () => state, subscribe: (listener: (value: typeof state) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
        }) },
        "./prepare-share": { prepareDesignLibraryShareDraft: async (_source: unknown, signal: AbortSignal) => {
            requests.push(signal); entered.resolve(); await response.promise;
            if (options.fail) throw new Error("temporary failure");
            signal.throwIfAborted(); return { savedPrivateCopy: false, draft: { ownerId: "owner-a", title: "原设计" } };
        } },
    };
    const module = { exports: {} as { useDesignLibraryShare: typeof useDesignLibraryShare } };
    new Function("require", "module", "exports", code)((name: string) => {
        if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected dependency: ${name}`);
        return dependencies[name];
    }, module, module.exports);
    const render = () => { cursor = 0; const value = module.exports.useDesignLibraryShare(); mounted = true; return value; };
    return { action: render(), render, requests, navigations, notices, entered: entered.promise, release: () => response.resolve(),
        listeners: () => listeners.size, unmount: () => cleanups.forEach(cleanup => cleanup()),
        owner: (id: string) => { state.user = { ...state.user, id }; listeners.forEach(listener => listener(state)); },
    };
}

test("duplicate share clicks prepare once and only navigate to an unsubmitted draft", async () => {
    const h = harness(); const first = h.action.share(source), duplicate = h.action.share(source);
    await h.entered; expect(h.requests).toHaveLength(1); expect(h.navigations).toEqual([]);
    h.release(); await first; await duplicate;
    expect(h.navigations).toEqual([["/design-library?publish=1", { state: { designLibraryDraft: { ownerId: "owner-a", title: "原设计" } } }]]);
    expect(h.listeners()).toBe(0); expect(h.render().busy).toBe(false);
});

test.each(["owner", "owner-return", "unmount"])("%s changes cancel a delayed draft without navigation or late errors", async change => {
    const h = harness({ fail: true }), pending = h.action.share(source); await h.entered;
    if (change === "unmount") h.unmount(); else { h.owner("owner-b"); if (change === "owner-return") h.owner("owner-a"); }
    expect(h.requests[0].aborted).toBe(true); h.release(); await pending;
    expect(h.navigations).toEqual([]); expect(h.notices).toEqual([]); expect(h.listeners()).toBe(0);
});

test.each([{ oa: false }, { enabled: false }, { role: "super_admin" }, { role: "department_admin" }])("ineligible library contexts do not prepare a draft (%j)", async options => {
    const h = harness(options); expect(h.action.canShare).toBe(false); await h.action.share(source);
    expect(h.requests).toEqual([]); expect(h.navigations).toEqual([]); expect(h.listeners()).toBe(0);
});

test("a current failure is visible and releases the duplicate-action lock", async () => {
    const h = harness({ fail: true }), first = h.action.share(source); await h.entered; h.release(); await first;
    expect(h.notices).toEqual(["temporary failure"]); expect(h.render().busy).toBe(false);
    await h.render().share(source); expect(h.requests).toHaveLength(2); expect(h.listeners()).toBe(0);
});
