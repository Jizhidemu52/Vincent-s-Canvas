import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function harness() {
    const states: unknown[] = [], refs: Array<{ current: unknown }> = [], memos: Array<{ deps: unknown[]; value: unknown }> = [], effects: Array<{ deps: unknown[]; cleanup?: () => void }> = [];
    const pending: Array<() => void> = [];
    const saved = new Map<string, unknown>();
    let stateIndex = 0, refIndex = 0, memoIndex = 0, effectIndex = 0, owner = "employee-a", status = "authenticated", firstRead = true, failWrites = false;
    const read = Promise.withResolvers<unknown>();
    void read.promise.then(() => { firstRead = false; });
    const warnings: unknown[] = [];
    const message = { warning: (value: unknown) => warnings.push(value) };
    const module = { exports: {} as { useGenerationDraft: Function } };
    const code = ts.transpileModule(readFileSync(new URL("../src/hooks/use-generation-draft.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const react = {
        useState(initial: unknown) { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], (next: unknown) => { states[index] = typeof next === "function" ? next(states[index]) : next; }]; },
        useRef(initial: unknown) { return refs[refIndex++] ||= { current: initial }; },
        useCallback(callback: Function) { return callback; },
        useMemo(factory: Function, deps: unknown[]) { const index = memoIndex++; if (!memos[index] || deps.some((dep, i) => dep !== memos[index]!.deps[i])) memos[index] = { deps, value: factory() }; return memos[index]!.value; },
        useEffect(effect: () => (() => void) | void, deps: unknown[]) { const index = effectIndex++; if (effects[index] && deps.every((dep, i) => dep === effects[index]!.deps[i])) return; pending.push(() => { effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: effect() || undefined }; }); },
    };
    const dependencies = {
        react,
        antd: { App: { useApp: () => ({ message }) } },
        "@/lib/i18n": { uiText: (value: string) => value },
        "@/stores/use-user-store": { useUserStore: (select: Function) => select({ user: { id: owner }, status }) },
        "@/lib/workspace-storage": { createWorkspaceStorage: () => {
            const captured = status === "authenticated" ? owner : null;
            const isCurrent = () => owner === captured && status === "authenticated";
            return {
                getItem: (key: string) => isCurrent() ? firstRead ? read.promise : Promise.resolve(saved.get(`${captured}:${key}`) ?? null) : Promise.reject(new Error("Expired identity")),
                isCurrent,
                setItem: async (key: string, value: unknown) => {
                    if (!isCurrent() || failWrites) throw new Error("Storage unavailable");
                    saved.set(`${captured}:${key}`, value);
                },
            };
        } },
    };
    new Function("require", "module", "exports", code)((name: keyof typeof dependencies) => dependencies[name], module, module.exports);
    const render = (key = "image:prompt", initial: unknown = "", hydrate?: Function) => {
        stateIndex = refIndex = memoIndex = effectIndex = 0;
        const result = module.exports.useGenerationDraft(key, initial, hydrate);
        pending.splice(0).forEach(effect => effect());
        return result;
    };
    return { render, read, saved, warnings, switchOwner: () => { owner = "employee-b"; }, expire: () => { status = "expired"; }, resume: () => { status = "authenticated"; }, failWrites: () => { failWrites = true; }, unmount: () => effects.forEach(effect => effect.cleanup?.()) };
}

test("a delayed durable read cannot replace a newly edited generation draft", async () => {
    const app = harness();
    const initial = app.render();
    initial[1]("new input");
    app.read.resolve("old saved input"); await settle();
    expect(app.render()[0]).toBe("new input");
    await settle();
    expect(app.saved.get("employee-a:image:prompt")).toBe("new input");
});

test("draft writes from an old employee are discarded after identity changes", async () => {
    const app = harness();
    const initial = app.render();
    app.read.resolve(null); await settle(); app.render();
    initial[1]("private input"); app.render(); app.switchOwner(); await settle();
    expect(app.saved.size).toBe(0);
});

test("references restore original storage identities through media hydration", async () => {
    const app = harness();
    const hydrate = async (items: Array<{ storageKey: string }>) => items.map(item => ({ ...item, dataUrl: `blob:restored:${item.storageKey}` }));
    app.render("angle-control:references", [], hydrate);
    app.read.resolve([{ id: "ref", storageKey: "original-bytes" }]); await settle();
    const restored = app.render("angle-control:references", [], hydrate)[0];
    expect(restored).toEqual([{ id: "ref", storageKey: "original-bytes", dataUrl: "blob:restored:original-bytes" }]);
    expect(app.saved.size).toBe(0);
});

test("same-owner reauthentication persists the latest draft skipped during expiry", async () => {
    const app = harness(); const first = app.render();
    app.read.resolve("old saved input"); await settle(); app.render();
    first[1]("new input"); app.render(); app.expire(); app.render(); await settle();
    expect(app.saved.size).toBe(0);
    app.resume(); app.render(); await settle(); app.render(); await settle();
    expect(app.render()[0]).toBe("new input");
    expect(app.saved.get("employee-a:image:prompt")).toBe("new input");
});

test("a new owner never receives the previous owner's unsaved value", async () => {
    const app = harness(); const first = app.render();
    app.read.resolve(null); await settle(); app.render();
    first[1]("private a"); app.render(); app.expire(); app.render(); await settle();
    app.switchOwner(); app.resume(); app.render(); await settle(); app.render(); await settle();
    expect(app.saved.has("employee-b:image:prompt")).toBe(false);
    expect(app.render()[0]).toBe("");
});

test("changing the draft key restores that field without copying the previous field's edits", async () => {
    const app = harness(); const first = app.render();
    app.read.resolve(null); await settle(); app.render();
    first[1]("image draft"); app.render(); await settle();
    app.saved.set("employee-a:angle-control:prompt", "angle draft");
    expect(app.render("angle-control:prompt")[0]).toBe("");
    await settle();
    expect(app.render("angle-control:prompt")[0]).toBe("angle draft");
    expect(app.saved.get("employee-a:image:prompt")).toBe("image draft");
    expect(app.saved.get("employee-a:angle-control:prompt")).toBe("angle draft");
});

test("a field mounted during expiry recovers storage without replacing newer input", async () => {
    const app = harness(); app.expire();
    const first = app.render();
    expect(first[2]).toBe(false);
    first[1]("input while locked"); app.render();
    app.read.resolve("older input"); await settle();
    app.resume(); app.render(); await settle(); app.render(); await settle();
    expect(app.render()[0]).toBe("input while locked");
    expect(app.saved.get("employee-a:image:prompt")).toBe("input while locked");
    expect(app.warnings).toEqual([]);
});

test("unmount preserves queued same-owner writes but blocks writes after an owner change", async () => {
    for (const changeOwner of [false, true]) {
        const app = harness(); const first = app.render();
        app.read.resolve(null); await settle(); app.render();
        first[1]("latest"); app.render(); app.unmount();
        if (changeOwner) app.switchOwner();
        await settle();
        expect(app.saved.get("employee-a:image:prompt")).toBe(changeOwner ? undefined : "latest");
        expect(app.warnings).toEqual([]);
    }
});

test("a failed queued write after unmount does not display feedback on another page", async () => {
    const app = harness(); const first = app.render();
    app.read.resolve(null); await settle(); app.render();
    app.failWrites(); first[1]("latest"); app.render(); app.unmount(); await settle();
    expect(app.saved.size).toBe(0);
    expect(app.warnings).toEqual([]);
});
