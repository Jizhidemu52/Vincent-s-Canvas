import { expect, test } from "bun:test";
import { i18nHarness } from "./helpers/i18n-harness";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import ts from "typescript";
import { PromptCompilationUncertainError } from "../src/services/api/prompt-compilations";

const requireModule = createRequire(new URL("../src/components/prompt-optimize-button.tsx", import.meta.url));
const code = ts.transpileModule(readFileSync(new URL("../src/components/prompt-optimize-button.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const compilation = { id: "compilation-id", requestId: "compile-request", status: "success", prompt: "Final optimized prompt", optimized: true, summaryZh: "已优化" };

function harness(compile: () => Promise<unknown>, query: (id: string) => Promise<unknown> = async () => compilation) {
    const state: any[] = [];
    const applied: unknown[] = [], notices: string[] = [];
    let cursor = 0, ownerId = "employee-a";
    const dependencies: Record<string, unknown> = {
        "@/lib/i18n": i18nHarness,
        react: { ...React,
            useRef: (initial: unknown) => { const index = cursor++; return state[index] ||= { current: initial }; },
            useState: (initial: unknown) => { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], (value: unknown) => { state[index] = value; }]; },
        },
        antd: { App: { useApp: () => ({ message: { success: (text: string) => notices.push(text), warning: (text: string) => notices.push(text), error: (text: string) => notices.push(text) } }) }, Button: () => null },
        "@/services/api/image": { optimizeImagePrompt: compile },
        "@/services/api/prompt-compilations": { getPromptCompilation: query, completedPromptCompilation: (value: unknown) => value, PromptCompilationUncertainError },
        "@/lib/client-id": { createClientId: () => "compile-request" },
        "@/stores/use-user-store": { useUserStore: { getState: () => ({ user: { id: ownerId } }) } },
    };
    const module = { exports: {} as { PromptOptimizeButton: (props: any) => ReactElement<any> } };
    new Function("require", "module", "exports", code)((name: string) => dependencies[name] || requireModule(name), module, module.exports);
    return {
        render: (prompt = "Change blue", references: any[] = []) => {
            cursor = 0;
            return module.exports.PromptOptimizeButton({ config: { model: "image-model" }, prompt, references, onApply: (...args: unknown[]) => applied.push(args) });
        },
        applied, notices, changeOwner: () => { ownerId = "employee-b"; },
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
    expect(view.applied).toEqual([[compilation.prompt, compilation, { scene: "free-optimize", userText: "Change blue", fields: {}, mode: "generate", referenceRoles: [], compilationId: compilation.id }]]);
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
