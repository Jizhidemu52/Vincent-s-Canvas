import { expect, test } from "bun:test";
import { i18nHarness } from "./helpers/i18n-harness";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import ts from "typescript";
import { completedPromptCompilation, PromptCompilationUncertainError } from "../src/services/api/prompt-compilations";

const requireModule = createRequire(new URL("../src/components/prompt-optimize-button.tsx", import.meta.url));
const code = ts.transpileModule(readFileSync(new URL("../src/components/prompt-optimize-button.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const compilation = { id: "compilation-id", requestId: "compile-request", status: "success", prompt: "Final optimized prompt", optimized: true, summaryZh: "已优化" };

function harness(compile: (...args: any[]) => Promise<unknown>, query: (id: string) => Promise<unknown> = async () => compilation) {
    const state: any[] = [];
    const applied: unknown[] = [], notices: string[] = [];
    const cleanups: Array<() => void> = [];
    let cursor = 0, ownerId = "employee-a";
    let rendered: ReactElement<any>;
    const userStore = Object.assign((select: (state: any) => unknown) => select({ user: { id: ownerId } }), { getState: () => ({ user: { id: ownerId } }) });
    const dependencies: Record<string, unknown> = {
        "@/lib/i18n": i18nHarness,
        react: { ...React,
            useRef: (initial: unknown) => { const index = cursor++; return state[index] ||= { current: initial }; },
            useState: (initial: unknown) => { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], (value: unknown) => { state[index] = value; }]; },
            useEffect: (callback: () => void | (() => void)) => { const index = cursor++; if (!(index in state)) { state[index] = true; const cleanup = callback(); if (cleanup) cleanups.push(cleanup); } },
        },
        antd: { App: { useApp: () => ({ message: { success: (text: string) => notices.push(text), warning: (text: string) => notices.push(text), error: (text: string) => notices.push(text) } }) }, Button: () => null, Modal: () => null },
        "@/services/api/image": { optimizeImagePrompt: compile },
        "@/services/api/prompt-compilations": { getPromptCompilation: query, completedPromptCompilation, PromptCompilationUncertainError },
        "@/lib/client-id": { createClientId: () => "compile-request" },
        "@/stores/use-user-store": { useUserStore: userStore },
    };
    const module = { exports: {} as { PromptOptimizeButton: (props: any) => ReactElement<any> } };
    new Function("require", "module", "exports", code)((name: string) => dependencies[name] || requireModule(name), module, module.exports);
    return {
        render: (prompt = "Change blue", references: any[] = [], scopeKey = "", overrides: Record<string, unknown> = {}) => {
            cursor = 0;
            rendered = module.exports.PromptOptimizeButton({ config: { model: "image-model" }, operationType: "image_generation", prompt, references, scopeKey, onApply: (...args: unknown[]) => applied.push(args), ...overrides });
            return rendered.props.children[0];
        },
        preview: () => rendered.props.children[1],
        apply: () => rendered.props.children[1].props.footer.props.children[1].props.onClick(),
        cancel: () => rendered.props.children[1].props.onCancel(),
        applied, notices, changeOwner: () => { ownerId = "employee-b"; }, unmount: () => { cleanups.forEach(cleanup => cleanup()); },
    };
}

test("manual optimization only runs after a click and retains the compilation for generation", async () => {
    let calls = 0;
    const view = harness(async () => { calls++; return compilation; });
    const button = view.render();
    expect(calls).toBe(0);
    button.props.onClick();
    await tick();
    expect(calls).toBe(1);
    expect(view.applied).toEqual([]);
    view.render();
    expect(view.preview().props.open).toBe(true);
    view.apply();
    view.apply();
    expect(view.applied).toEqual([[compilation.prompt, compilation, { scene: "free-optimize", userText: "Change blue", fields: {}, mode: "generate", referenceRoles: [], compilationId: compilation.id }]]);
});

test.each([['image_generation', 'generate'], ['inpaint', 'edit']] as const)("the clicked button uses explicit %s even with the same references", async (operationType, mode) => {
    const calls: any[][] = [];
    const references = [{ id: "ref", name: "主图", dataUrl: "image-a", role: "只参考此图的颜色。" }];
    const view = harness(async (...args) => { calls.push(args); return compilation; });
    view.render("Change blue", references, "", { operationType, toolKey: operationType === "image_generation" ? "image" : "image-edit" }).props.onClick();
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({ mode, referenceRoles: ["只参考此图的颜色。"] });
    expect(calls[0]![3]).toMatchObject({ operationType });
    view.render("Change blue", references, "", { operationType, toolKey: operationType === "image_generation" ? "image" : "image-edit" }); view.apply();
    expect((view.applied[0] as any[])[2]).toMatchObject({ mode, compilationId: compilation.id });
});

test("upscaling explains plain-prompt usage and cannot post unsupported compilation", async () => {
    let calls = 0;
    const view = harness(async () => { calls++; return compilation; });
    const button = view.render("Enhance details", [], "", { operationType: "upscale", toolKey: "detail-enhance" });
    expect(button.props.disabled).toBe(true);
    expect(button.props.children).toBe("此操作不支持一键优化");
    expect(button.props.title).toContain("可直接填写要求后生成");
    button.props.onClick(); await tick();
    expect(calls).toBe(0);
});

test.each([
    { config: { model: "another-model" } },
    { operationType: "inpaint" },
    { toolKey: "creative-text-to-style" },
    { scene: "text-to-style" },
])("late optimization cannot reuse a changed model, operation, tool or recipe: %j", async changes => {
    let finish!: (value: unknown) => void;
    const view = harness(() => new Promise(resolve => { finish = resolve; }));
    view.render().props.onClick();
    view.render("Change blue", [], "", changes);
    finish(compilation); await tick();
    expect(view.applied).toHaveLength(0);
    expect(view.notices[0]).toContain("未覆盖当前内容");
});

test("mandatory creative scenes remain explicit instead of becoming free optimization", async () => {
    const calls: any[][] = [];
    const view = harness(async (...args) => { calls.push(args); return compilation; });
    view.render("A blue dress", [], "", { scene: "text-to-style", toolKey: "creative-text-to-style" }).props.onClick(); await tick();
    expect(calls[0]![1]).toMatchObject({ scene: "text-to-style", mode: "generate" });
});

test("an uncertain optimization only queries the original request on the next click", async () => {
    let posts = 0;
    const queried: string[] = [];
    const view = harness(async () => { posts++; throw new PromptCompilationUncertainError("compile-request"); }, async id => { queried.push(id); return compilation; });
    view.render().props.onClick(); await tick();
    const pending = view.render();
    expect(pending.props.children).toBe("查询原优化请求");
    pending.props.onClick(); await tick();
    expect(posts).toBe(1);
    expect(queried).toEqual(["compile-request"]);
    expect(view.applied).toHaveLength(0);
    view.render(); view.apply();
    expect(view.applied).toHaveLength(1);
});

test("late optimization cannot overwrite changed prompt or reference order", async () => {
    let finish!: (value: unknown) => void;
    const view = harness(() => new Promise(resolve => { finish = resolve; }));
    const references = [{ id: "first", name: "主图", dataUrl: "image-a" }, { id: "second", name: "花型", dataUrl: "image-b" }];
    view.render("Change blue", references).props.onClick();
    view.render("Change red", references.toReversed());
    finish(compilation); await tick();
    expect(view.applied).toHaveLength(0);
    expect(view.notices[0]).toContain("未覆盖当前内容");
});

test("an account switch never applies another employee's completed optimization", async () => {
    let finish!: (value: unknown) => void;
    const view = harness(() => new Promise(resolve => { finish = resolve; }));
    view.render().props.onClick();
    view.changeOwner(); finish(compilation); await tick();
    expect(view.applied).toHaveLength(0);
});

test("identical cloned node inputs do not allow an optimization to overwrite another node scope", async () => {
    let finish!: (value: unknown) => void;
    const view = harness(() => new Promise(resolve => { finish = resolve; }));
    const references = [{ id: "shared-reference", name: "原图", dataUrl: "image-a", storageKey: "image:source" }];
    view.render("Same input", references, "project:node-a").props.onClick();
    view.render("Same input", references, "project:node-b");
    finish(compilation); await tick();
    expect(view.applied).toHaveLength(0);
    expect(view.notices[0]).toContain("未覆盖当前内容");
});

test("querying an uncertain optimization after a node switch keeps the original request but does not apply it", async () => {
    let posts = 0;
    const queried: string[] = [];
    const view = harness(async () => { posts++; throw new PromptCompilationUncertainError("compile-request"); }, async id => { queried.push(id); return compilation; });
    view.render("Same input", [], "project:node-a").props.onClick(); await tick();
    const pending = view.render("Same input", [], "project:node-b");
    expect(pending.props.children).toBe("查询原优化请求");
    pending.props.onClick(); await tick();
    expect(posts).toBe(1);
    expect(queried).toEqual(["compile-request"]);
    expect(view.applied).toHaveLength(0);
});

test("a failed original-request lookup remains query-only on later clicks", async () => {
    let posts = 0, queries = 0;
    const view = harness(async () => { posts++; throw new PromptCompilationUncertainError("compile-request"); }, async () => {
        if (++queries === 1) throw new TypeError("connection lost during lookup");
        return compilation;
    });
    view.render().props.onClick(); await tick();
    view.render().props.onClick(); await tick();
    const retry = view.render();
    expect(retry.props.children).toBe("查询原优化请求");
    retry.props.onClick(); await tick();
    expect(posts).toBe(1);
    expect(queries).toBe(2);
    view.render(); view.apply();
    expect(view.applied).toHaveLength(1);
});

test("canceling the comparison leaves the original prompt unchanged", async () => {
    const view = harness(async () => compilation);
    view.render().props.onClick(); await tick();
    view.render(); view.cancel(); view.apply();
    expect(view.applied).toEqual([]);
    view.render(); expect(view.preview().props.open).toBe(false);
});

test.each([
    { prompt: "Changed prompt" },
    { config: { model: "other" } },
    { config: { model: "image-model", quality: "high" } },
    { references: [{ id: "ref", name: "first", dataUrl: "image-a", role: "只参考此图的材质。" }] },
    { references: [{ id: "replacement", name: "first", dataUrl: "image-b", role: "只参考此图的颜色。" }] },
])("a completed preview cannot apply after its inputs change, even if they change back: %j", async changes => {
    const references = [{ id: "ref", name: "first", dataUrl: "image-a", role: "只参考此图的颜色。" }];
    const view = harness(async () => compilation);
    view.render("Change blue", references).props.onClick(); await tick();
    view.render("Change blue", references, "", changes);
    expect(view.preview().props.footer.props.children[1].props.disabled).toBe(true);
    view.apply();
    view.render("Change blue", references); view.apply();
    expect(view.applied).toEqual([]);
});

test("account changes after the preview is ready cannot apply it", async () => {
    const view = harness(async () => compilation);
    view.render().props.onClick(); await tick(); view.render();
    view.changeOwner(); view.apply();
    expect(view.applied).toEqual([]);
});

test("clarification questions are shown and cannot be applied as a generation prompt", async () => {
    const view = harness(async () => ({ ...compilation, questions: ["哪一块需要改色？"] }));
    view.render().props.onClick(); await tick(); view.render();
    expect(view.preview().props.footer.props.children[1].props.disabled).toBe(true);
    expect(JSON.stringify(view.preview())).toContain("哪一块需要改色？");
    view.apply(); expect(view.applied).toEqual([]);
});

test("unmounted optimizers cannot apply late results or clear another workspace's busy state", async () => {
    let finish!: (value: unknown) => void;
    const busy: boolean[] = [];
    const view = harness(() => new Promise(resolve => { finish = resolve; }));
    view.render("Change blue", [], "project-a", { onBusyChange: (value: boolean) => busy.push(value) }).props.onClick();
    view.unmount();
    const busyAfterUnmount = [...busy];
    finish(compilation); await tick();
    expect(view.applied).toEqual([]);
    expect(view.notices).toEqual([]);
    expect(busy).toEqual(busyAfterUnmount);
});

test("a changed URL-only reference prevents a late compilation from replacing the current input", async () => {
    let finish!: (value: unknown) => void;
    const view = harness(() => new Promise(resolve => { finish = resolve; }));
    const reference = { id: "source", name: "原图", dataUrl: "", url: "/api/assets/original/content" };
    view.render("Change blue", [reference]).props.onClick();
    view.render("Change blue", [{ ...reference, url: "/api/assets/replacement/content" }]);
    finish(compilation); await tick();
    expect(view.applied).toEqual([]);
    expect(view.notices[0]).toContain("未覆盖当前内容");
});

test("carryover fields are frozen and changed requirements cannot receive a stale compilation", async () => {
    let finish!: (value: unknown) => void;
    let submitted: any;
    const view = harness(async (_config, input) => { submitted = input; return new Promise(resolve => { finish = resolve; }); });
    const fields = { carryoverRequirements: ["保留六颗纽扣"] };
    view.render("Change blue", [], "design-token", { fields }).props.onClick();
    fields.carryoverRequirements[0] = "改成四颗纽扣";
    view.render("Change blue", [], "design-token", { fields });
    expect(submitted.fields.carryoverRequirements).toEqual(["保留六颗纽扣"]);
    finish(compilation); await tick();
    expect(view.applied).toEqual([]);
    expect(view.notices[0]).toContain("未覆盖当前内容");
});
