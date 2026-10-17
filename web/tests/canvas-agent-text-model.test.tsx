import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ts from "typescript";

import { CanvasNodePromptPanel } from "@/components/canvas/canvas-node-prompt-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { useToolConfig } from "@/hooks/use-tool-config";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { defaultConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useModuleStore } from "@/stores/use-module-store";
import { moduleKeys } from "@/services/api/modules";
import { CanvasNodeType } from "@/types/canvas";

const sourceUrl = new URL("../src/components/canvas/canvas-assistant-panel.tsx", import.meta.url);
const source = readFileSync(sourceUrl, "utf8");
const ast = ts.createSourceFile("canvas-assistant-panel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const requireModule = createRequire(sourceUrl);
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const module = { exports: {} as any };
new Function("require", "module", "exports", code + "\nexports.setup = OnlineAgentSetupView;")(
    (name: string) => name === "react" ? { ...React, useMemo: (factory: () => unknown) => factory() } : requireModule(name),
    module,
    module.exports,
);

const models = [
    { id: "astra", modelId: "gpt-6-astra", name: "GPT-6 Astra", capabilities: ["chat", "vision", "tools"], creditCost: 0, rmbCost: 0 },
    { id: "fable", modelId: "claude-fable-5-1", name: "Claude Fable 5.1", capabilities: ["chat", "vision", "tools"], creditCost: 0, rmbCost: 0 },
    { id: "image", modelId: "gpt-image-2", name: "Image only", capabilities: ["generate"], creditCost: 0, rmbCost: 0 },
];

function withModels<T>(status: "ready" | "loading" | "error", run: () => T, modelConfigId = "fable"): T {
    const state = useBusinessConfigStore.getInitialState();
    const saved = { ...state };
    const config = useConfigStore.getInitialState();
    const savedConfig = { ...config };
    const modules = useModuleStore.getInitialState();
    const savedModules = { ...modules };
    Object.assign(state, { models, status, tools: [
        { toolKey: "gpt-chat", modelConfigId, enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 },
        { toolKey: "canvas-chat", modelConfigId: "astra", enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 },
    ] });
    Object.assign(config, { config: { ...defaultConfig, textModel: "saved-personal-model" } });
    Object.assign(modules, { status: "ready", flags: Object.fromEntries(moduleKeys.map(key => [key, true])) });
    try { return run(); } finally { Object.assign(state, saved); Object.assign(config, savedConfig); Object.assign(modules, savedModules); }
}

function findNode(predicate: (node: ts.Node) => boolean, root: ts.Node = ast): ts.Node | undefined {
    if (predicate(root)) return root;
    return ts.forEachChild(root, (node) => findNode(predicate, node));
}

function invokeExpression(expression: ts.Node, bindings: Record<string, unknown>, ...args: unknown[]) {
    const callback = new Function(...Object.keys(bindings), `return (${expression.getText(ast)});`)(...Object.values(bindings));
    return callback(...args);
}

test("website Agent has no LLM picker or replacement model-name badge", () => {
    expect(source).not.toContain("AgentTextModelPicker");
    expect(source).not.toContain('data-testid="canvas-agent-text-model"');
    const markup = withModels("ready", () => renderToStaticMarkup(module.exports.setup({ theme: canvasThemes.light })));
    expect(markup).not.toContain('data-usage-control="model"');
    for (const model of models) expect(markup).not.toContain(model.name);
});

test("effective config and node config follow the unified model without mutating personal choices", () => {
    const saved = { ...defaultConfig, model: "old-node-model", textModel: "old-personal-model" };
    let effective = defaultConfig;
    let bound = defaultConfig;
    function ReadConfig() { effective = useEffectiveConfig(); bound = useToolConfig(saved, "canvas-chat"); return null; }
    for (const model of models.slice(0, 2)) withModels("ready", () => {
        renderToStaticMarkup(<ReadConfig />);
        expect(effective.textModel).toBe(model.modelId);
        expect(bound).toMatchObject({ model: model.modelId, textModel: model.modelId });
        expect(useConfigStore.getInitialState().config.textModel).toBe("saved-personal-model");
    }, model.id);
    expect(saved).toMatchObject({ model: "old-node-model", textModel: "old-personal-model" });
    for (const status of ["loading", "error"] as const) withModels(status, () => {
        renderToStaticMarkup(<ReadConfig />);
        expect(effective.textModel).toBe("");
        expect(bound).toMatchObject({ model: "", textModel: "", imageModel: saved.imageModel, videoModel: saved.videoModel });
    });
    withModels("ready", () => { renderToStaticMarkup(<ReadConfig />); expect(bound.textModel).toBe(""); }, "removed");
});

test("text-node composer hides model names and remains usable with an old saved node model", () => {
    const node = { id: "text-node", type: CanvasNodeType.Text, title: "文字", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { model: "old-node-model", prompt: "写一段介绍" } };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const render = () => renderToStaticMarkup(<QueryClientProvider client={client}><CanvasNodePromptPanel node={node} isRunning={false} onPromptChange={() => undefined} onConfigChange={() => undefined} onGenerate={() => undefined} onStop={() => undefined} /></QueryClientProvider>);
    const markup = withModels("ready", render);
    expect(markup).not.toContain('data-usage-control="model"');
    for (const model of models) expect(markup).not.toContain(model.name);
    const generate = (html: string) => html.match(/<button\b[^>]*aria-label="生成"[^>]*>/)?.[0] || "";
    expect(generate(markup)).not.toBe("");
    expect(generate(markup)).not.toContain('disabled=""');
    expect(generate(withModels("loading", render))).toContain('disabled=""');
    expect(generate(withModels("ready", render, "removed"))).toContain('disabled=""');
});

test("connection configuration opens the actual website Agent setup view", () => {
    const menu = findNode((node) => ts.isObjectLiteralExpression(node) && node.properties.some((property) => ts.isPropertyAssignment(property) && property.name.getText(ast) === "key" && property.initializer.getText(ast) === '"config"')) as ts.ObjectLiteralExpression;
    const handler = menu.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(ast) === "onClick") as ts.PropertyAssignment;
    const modes: string[] = [];
    const views: string[] = [];
    const obsoleteDialogs: unknown[] = [];
    invokeExpression(handler.initializer, { onAgentModeChange: (mode: string) => modes.push(mode), setView: (view: string) => views.push(view), openConfigDialog: (value: unknown) => obsoleteDialogs.push(value) });
    expect(modes).toEqual(["online"]);
    expect(views).toEqual(["setup"]);
    expect(obsoleteDialogs).toEqual([]);
});

test("Agent setup links to real backend management and never asks for a new API key", () => {
    const markup = withModels("ready", () => renderToStaticMarkup(module.exports.setup({ theme: canvasThemes.light })));
    expect(markup).toContain('href="/admin?tab=api"');
    expect(markup).not.toContain("GPT-6 Astra");
    expect(markup).toContain("后台模型配置");
    expect(markup).not.toContain('type="password"');
});
