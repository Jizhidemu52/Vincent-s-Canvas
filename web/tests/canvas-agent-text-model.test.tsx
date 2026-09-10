import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

import { ModelPicker } from "@/components/model-picker";
import { canvasThemes } from "@/lib/canvas-theme";
import { getModelPickerOptions } from "@/lib/model-picker-options";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { defaultConfig } from "@/stores/use-config-store";

const sourceUrl = new URL("../src/components/canvas/canvas-assistant-panel.tsx", import.meta.url);
const source = readFileSync(sourceUrl, "utf8");
const ast = ts.createSourceFile("canvas-assistant-panel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const requireModule = createRequire(sourceUrl);
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const module = { exports: {} as any };
new Function("require", "module", "exports", code + "\nexports.picker = AgentTextModelPicker; exports.setup = OnlineAgentSetupView;")(
    (name: string) => name === "react" ? { ...React, useMemo: (factory: () => unknown) => factory() } : requireModule(name),
    module,
    module.exports,
);

const models = [
    { id: "astra", modelId: "gpt-6-astra", name: "GPT-6 Astra", capabilities: ["chat", "vision", "tools"], creditCost: 0, rmbCost: 0 },
    { id: "fable", modelId: "claude-fable-5-1", name: "Claude Fable 5.1", capabilities: ["chat", "vision", "tools"], creditCost: 0, rmbCost: 0 },
    { id: "image", modelId: "gpt-image-2", name: "Image only", capabilities: ["generate"], creditCost: 0, rmbCost: 0 },
];

function withModels<T>(status: "ready" | "loading" | "error", run: () => T): T {
    const state = useBusinessConfigStore.getInitialState();
    const saved = { ...state };
    Object.assign(state, { models, status });
    try { return run(); } finally { Object.assign(state, saved); }
}

function findNode(predicate: (node: ts.Node) => boolean, root: ts.Node = ast): ts.Node | undefined {
    if (predicate(root)) return root;
    return ts.forEachChild(root, (node) => findNode(predicate, node));
}

function invokeExpression(expression: ts.Node, bindings: Record<string, unknown>, ...args: unknown[]) {
    const callback = new Function(...Object.keys(bindings), `return (${expression.getText(ast)});`)(...Object.values(bindings));
    return callback(...args);
}

test("website Agent reuses server chat-capability models, including both newly configured models", () => {
    const picker = module.exports.picker({ config: defaultConfig, value: "gpt-6-astra", onChange: () => undefined }) as ReactElement<any>;
    expect(picker.type).toBe(ModelPicker);
    expect(picker.props).toMatchObject({ capability: "text", modelsSource: "server" });
    expect(getModelPickerOptions(defaultConfig, picker.props.capability, models, picker.props.modelsSource)).toEqual(["gpt-6-astra", "claude-fable-5-1"]);
    for (const model of models.slice(0, 2)) {
        const element = module.exports.picker({ config: defaultConfig, value: model.modelId, onChange: () => undefined });
        expect(withModels("ready", () => renderToStaticMarkup(element))).toContain(model.name);
    }
});

test("website Agent cannot display a stale selected model while server model data is unavailable", () => {
    const picker = module.exports.picker({ config: defaultConfig, value: "gpt-6-astra", onChange: () => undefined });
    expect(withModels("loading", () => renderToStaticMarkup(picker))).toContain("正在加载模型");
    expect(withModels("error", () => renderToStaticMarkup(picker))).toContain("模型配置加载失败");
});

test("the directly visible chat-model control writes the shared global textModel", () => {
    const row = findNode((node) => ts.isJsxElement(node) && node.openingElement.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === "data-testid" && attribute.initializer?.getText(ast) === '"canvas-agent-text-model"'));
    expect(row).toBeDefined();
    const picker = findNode((node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "AgentTextModelPicker", row!) as ts.JsxSelfClosingElement;
    const handler = picker.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === "onChange") as ts.JsxAttribute;
    const changes: unknown[][] = [];
    invokeExpression((handler.initializer as ts.JsxExpression).expression!, { updateConfig: (...args: unknown[]) => changes.push(args) }, "claude-fable-5-1");
    expect(changes).toEqual([["textModel", "claude-fable-5-1"]]);
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
    const markup = withModels("ready", () => renderToStaticMarkup(module.exports.setup({ theme: canvasThemes.light, config: { ...defaultConfig, textModel: "gpt-6-astra" }, onModelChange: () => undefined })));
    expect(markup).toContain('href="/admin?tab=api"');
    expect(markup).toContain("GPT-6 Astra");
    expect(markup).toContain("后台模型配置");
    expect(markup).not.toContain('type="password"');
});
