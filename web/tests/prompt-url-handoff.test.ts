import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { shouldConfirmPromptReuse } from "../src/lib/generation-feedback";

type Confirm = { onOk: () => void; onCancel: () => void; destroyed: boolean };

/** Run the actual hook with per-instance React/router boundaries; no storage or network. */
function harness(query = "prompt=incoming&model=incoming-model", initialPrompt = "") {
    const source = readFileSync(new URL("../src/hooks/use-prompt-url-handoff.ts", import.meta.url), "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const refs: Array<{ current: any }> = [];
    const effects: Array<{ deps: unknown[]; cleanup?: () => void }> = [];
    const pending: Array<() => void> = [];
    let refIndex = 0, effectIndex = 0;
    const input = { ready: true, prompt: initialPrompt };
    const task = { urlInputKey: "incoming", active: true };
    let location = { key: "incoming", pathname: "/image", search: `?${query}`, hash: "#references", state: { source: "test" } };
    const confirmations: Confirm[] = [], applied: Array<[string, string]> = [], navigations: any[] = [];
    const modal = { confirm(options: Omit<Confirm, "destroyed">) {
        const confirmation = { ...options, destroyed: false };
        confirmations.push(confirmation);
        return { destroy: () => { confirmation.destroyed = true; } };
    } };
    const dependencies: Record<string, any> = {
        react: {
            useRef: (initial: any) => refs[refIndex++] ||= { current: initial },
            useEffect(callback: () => (() => void) | void, deps: unknown[]) {
                const index = effectIndex++, previous = effects[index];
                if (previous && deps.length === previous.deps.length && deps.every((item, i) => Object.is(item, previous.deps[i]))) return;
                pending.push(() => { previous?.cleanup?.(); effects[index] = { deps, cleanup: callback() || undefined }; });
            },
        },
        antd: { App: { useApp: () => ({ modal }) } },
        "react-router-dom": { useLocation: () => location, useNavigate: () => navigate },
        "@/components/workbench-tasks": { useWorkbenchTask: () => task },
        "@/lib/generation-feedback": { shouldConfirmPromptReuse },
        "@/lib/i18n": { uiText: (value: string) => value },
    };
    function navigate(to: unknown, options: unknown) { navigations.push({ to, options }); }
    const exports: any = {};
    new Function("require", "exports", code)((name: string) => {
        if (!(name in dependencies)) throw new Error(`Unexpected hook dependency ${name}`);
        return dependencies[name];
    }, exports);
    const render = () => {
        refIndex = effectIndex = 0;
        exports.usePromptUrlHandoff({ ...input, applyPrompt: (value: string) => { applied.push(["prompt", value]); input.prompt = value; }, applyModel: (value: string) => applied.push(["model", value]) });
        pending.splice(0).forEach(callback => callback());
    };
    return { input, task, applied, confirmations, navigations, render, ordinary: exports.isOrdinaryPromptUrl as (params: URLSearchParams) => boolean,
        navigateAway() { location = { ...location, key: "next", search: "?tool=image-edit" }; task.urlInputKey = "next"; },
        unmount() { effects.forEach(effect => effect.cleanup?.()); },
    };
}

test("ordinary URL classification excludes every separate handoff, including invalid tokens", () => {
    const app = harness();
    for (const query of ["prompt=hello", "model=model-a", "prompt=hello&tool=image-edit&keep=1"]) expect(app.ordinary(new URLSearchParams(query))).toBe(true);
    for (const query of ["", "prompt=&model=", ...["designToken", "placementToken", "sourceAssetId", "reuseToken"].map(key => `prompt=hello&${key}=invalid/value`)]) expect(app.ordinary(new URLSearchParams(query))).toBe(false);
});

test("target waits for complete draft readiness and fills only once even when hidden", () => {
    const app = harness("tool=image-edit&prompt=incoming&model=incoming-model&keep=first&keep=second");
    app.input.ready = false;
    app.task.active = false;
    app.render();
    expect(app.applied).toEqual([]);
    app.input.ready = true;
    app.render(); app.render();
    expect(app.applied).toEqual([["prompt", "incoming"], ["model", "incoming-model"]]);
    expect(app.navigations).toEqual([{ to: { pathname: "/image", search: "tool=image-edit&keep=first&keep=second", hash: "#references" }, options: { replace: true, state: { source: "test" } } }]);
    expect(app.confirmations).toEqual([]);
});

test("an occupied hidden target waits until visible, cancellation consumes without modifying it", () => {
    const app = harness(undefined, "existing draft");
    app.task.active = false;
    app.render();
    expect(app.confirmations).toEqual([]);
    app.task.active = true;
    app.render(); app.render();
    expect(app.confirmations).toHaveLength(1);
    expect(app.applied).toEqual([]);
    app.confirmations[0].onCancel();
    app.render();
    expect(app.input.prompt).toBe("existing draft");
    expect(app.applied).toEqual([]);
    expect(app.navigations).toHaveLength(1);
    expect(app.confirmations).toHaveLength(1);
});

test("confirmation changes only the requested prompt and model once", () => {
    const app = harness(undefined, "existing draft");
    app.render();
    app.confirmations[0].onOk(); app.confirmations[0].onOk(); app.render();
    expect(app.applied).toEqual([["prompt", "incoming"], ["model", "incoming-model"]]);
    expect(app.navigations).toHaveLength(1);
});

test("model-only input preserves the current prompt and does not invent prompt confirmation", () => {
    const app = harness("model=selected-model&keep=1", "existing draft");
    app.render();
    expect(app.input.prompt).toBe("existing draft");
    expect(app.applied).toEqual([["model", "selected-model"]]);
    expect(app.confirmations).toEqual([]);
    expect(app.navigations[0].to.search).toBe("keep=1");
});

for (const leave of ["navigation", "unmount"] as const) test(`stale confirmation after ${leave} cannot apply or clear another route`, () => {
    const app = harness(undefined, "existing draft");
    app.render();
    const old = app.confirmations[0];
    if (leave === "navigation") { app.navigateAway(); app.render(); } else app.unmount();
    expect(old.destroyed).toBe(true);
    old.onOk(); old.onCancel();
    expect(app.applied).toEqual([]);
    expect(app.navigations).toEqual([]);
});
