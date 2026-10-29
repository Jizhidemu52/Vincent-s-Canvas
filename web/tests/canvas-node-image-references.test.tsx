import { i18nHarness } from "./helpers/i18n-harness";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ts from "typescript";

import { CanvasNodePromptPanel } from "@/components/canvas/canvas-node-prompt-panel";
import { ReferenceImageTray } from "@/components/reference-images/reference-image-tray";
import { CanvasResourceMentionTextarea } from "@/components/canvas/canvas-resource-mention-textarea";
import { CanvasImageReferenceDialog } from "@/components/canvas/canvas-image-reference-dialog";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { canvasImageReferenceMentions, resolveCanvasNodeImageReferences } from "@/lib/canvas/canvas-image-references";
import { createCanvasMentionReferenceIndex, createCanvasResourceReferenceIndex } from "@/lib/canvas/canvas-resource-references";
import { CANVAS_IMAGE_MAX_BYTES } from "@/lib/canvas/canvas-image-upload-limit";

const noop = () => undefined;
const source: CanvasNodeData = { id: "original", type: CanvasNodeType.Image, title: "原始产品", position: { x: 0, y: 0 }, width: 240, height: 240,
    metadata: { content: "https://images.test/original.png", storageKey: "image:original", mimeType: "image/png", draftPrompt: "按图片2的配色和图片3的花型修改图片1", model: "gpt-image-2",
        manualImageReferences: [
            { referenceKey: "upload:color", id: "color", name: "配色", type: "image/png", content: "https://images.test/color.png", storageKey: "image:color", origin: "upload" },
            { referenceKey: "asset:pattern", id: "pattern", name: "花型", type: "image/png", content: "https://images.test/pattern.png", storageKey: "image:pattern", origin: "asset" },
        ] } };

function elements(node: unknown): ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement<any>(node)) return [];
    return [node, ...elements(node.props.children)];
}

// Run the actual component callbacks without browser storage, effects or network calls.
function loadComponent<T = (props: any) => ReactElement<any>>(path: string, name: string, overrides: Record<string, unknown> = {}) {
    const url = new URL(path, import.meta.url);
    const requireModule = createRequire(url);
    const code = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const dependencies: Record<string, unknown> = {
        react: { ...React, useState: (initial: any) => [typeof initial === "function" ? initial() : initial, noop], useRef: (current: unknown) => ({ current }), useEffect: noop },
        antd: { ...requireModule("antd"), App: { useApp: () => ({ message: { error: noop } }) } },
        "@/stores/use-config-store": { ...requireModule("@/stores/use-config-store"), useEffectiveConfig: () => defaultConfig, useConfigStore: (select: Function) => select({ openConfigDialog: noop }) },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: Function) => select({ estimate: () => ({ configured: true, credits: 0 }) }) },
        "@/stores/use-theme-store": { useThemeStore: (select: Function) => select({ theme: "light" }) },
        "@/lib/image-model-settings": { ...requireModule("@/lib/image-model-settings"), useImageModelProfile: requireModule("@/lib/image-model-settings").imageModelProfile },
        "@/hooks/use-tool-config": {
            ...requireModule("@/hooks/use-tool-config"),
            useToolConfig: (config: typeof defaultConfig) => config,
            useToolEnabled: (key: string) => key === "canvas-edit" || key === "canvas-image",
        },
        ...overrides,
    };
    const module = { exports: {} as any };
    new Function("require", "module", "exports", code)((id: string) => id === "@/lib/i18n" ? i18nHarness : ((id: string) => dependencies[id] || requireModule(id))(id), module, module.exports);
    return module.exports[name] as T;
}

const renderPanel = loadComponent("../src/components/canvas/canvas-node-prompt-panel.tsx", "CanvasNodePromptPanel");
const renderTray = loadComponent("../src/components/reference-images/reference-image-tray.tsx", "ReferenceImageTray");

function panel(node = source, canvasNodes = [node], canvasConnections: any[] = [], renderComponent = renderPanel) {
    let current = node;
    const generate: unknown[][] = [];
    const render = () => elements(renderComponent({ node: current, canvasNodes, canvasConnections, isRunning: false,
        onPromptChange: noop, onStop: noop, onGenerate: (...args: unknown[]) => generate.push(args),
        onConfigChange: (_id: string, patch: unknown) => { current = { ...current, metadata: { ...current.metadata, ...(patch as object) } }; },
        // This old, connection-based label must not override the actual image input order.
        mentionReferences: [{ id: "color", nodeId: "color", kind: "image", label: "图片1", title: "配色", active: true }],
    }));
    return { render, generate, get node() { return current; } };
}

function tray(app: ReturnType<typeof panel>) { return app.render().find(element => element.type === ReferenceImageTray)!; }

function uploadPanel(failUpload = false) {
    const uploaded: File[] = [];
    const errors: string[] = [];
    const requireModule = createRequire(import.meta.url);
    const render = loadComponent("../src/components/canvas/canvas-node-prompt-panel.tsx", "CanvasNodePromptPanel", {
        antd: { ...requireModule("antd"), App: { useApp: () => ({ message: { error: (text: string) => errors.push(text) } }) } },
        "@/services/image-storage": { uploadImage: async (file: File) => {
            uploaded.push(file);
            if (failUpload) throw new Error("本地图片保存失败");
            return { url: `blob:${file.name}`, storageKey: `image:${file.name}`, mimeType: file.type };
        } },
    });
    const app = panel(source, [source], [], render);
    const select = async (files: File[]) => {
        const input = app.render().find(element => element.type === "input" && element.props.type === "file")!;
        const target = { files, value: "selected" };
        input.props.ref.current = target;
        input.props.onChange({ target });
        expect(target.value).toBe("");
        await new Promise(resolve => setTimeout(resolve, 0));
    };
    return { app, uploaded, errors, select };
}

test("node reference uploads reject a later oversized file before saving any selected image and allow reselect", async () => {
    const h = uploadPanel();
    const small = new File(["image"], "small.png", { type: "image/png" });
    const large = new File([new Uint8Array(CANVAS_IMAGE_MAX_BYTES + 1)], "large.png", { type: "image/png" });
    await h.select([small, large]);
    expect(h.uploaded).toEqual([]);
    expect(h.app.node).toBe(source);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain("large.png");
    expect(h.errors[0]).toContain("20 MB");
    await h.select([large]);
    expect(h.errors).toHaveLength(2);
    expect(h.uploaded).toEqual([]);
    await h.select([small]);
    expect(h.uploaded).toEqual([small]);
    expect(h.app.node.metadata?.manualImageReferences?.map(item => item.name)).toEqual(["配色", "花型", "small.png"]);
});

test("node reference uploads preserve exact 20 MiB files without compression", async () => {
    const h = uploadPanel();
    const boundary = new File([new Uint8Array(CANVAS_IMAGE_MAX_BYTES)], "boundary.png", { type: "image/png" });
    await h.select([boundary]);
    expect(h.uploaded).toEqual([boundary]);
    expect(h.uploaded[0]).toBe(boundary);
    expect(h.errors).toEqual([]);
    expect(h.app.node.metadata?.manualImageReferences?.at(-1)?.name).toBe("boundary.png");
});

test("node reference upload failures are handled without altering existing references", async () => {
    const h = uploadPanel(true);
    await h.select([new File(["image"], "small.png", { type: "image/png" })]);
    expect(h.errors).toEqual(["本地图片保存失败"]);
    expect(h.app.node).toBe(source);
});

test("node editing displays the original and two auxiliaries in the same order used by image mentions", () => {
    const app = panel();
    const references = tray(app).props.references;
    expect(references.map((item: any) => item.id)).toEqual(["original", "color", "pattern"]);
    const mention = app.render().find(element => element.type === CanvasResourceMentionTextarea)!;
    expect(mention.props.references.filter((item: any) => item.kind === "image").map((item: any) => [item.nodeId, item.label])).toEqual([
        ["original", "图片1"], ["color", "图片2"], ["pattern", "图片3"],
    ]);
    const markup = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><CanvasNodePromptPanel node={source} canvasNodes={[source]} isRunning={false} onPromptChange={noop} onConfigChange={noop} onGenerate={noop} onStop={noop} /></QueryClientProvider>);
    expect(markup).toContain("当前原图");
    expect(markup.indexOf('alt="原始产品"')).toBeLessThan(markup.indexOf('alt="配色"'));
    expect(markup).toContain("图片3");
});

test("the original cannot be removed, cleared, moved, or saved as an auxiliary", () => {
    const app = panel();
    let view = tray(app);
    const controls = elements(renderTray(view.props));
    expect(controls.filter(element => element.props["aria-label"] === "移除参考图")).toHaveLength(2);
    expect(controls.find(element => element.props["aria-label"] === "将图片1后移")).toBeUndefined();
    expect(controls.find(element => element.props["aria-label"] === "将图片2前移")!.props.disabled).toBe(true);
    controls.find(element => element.props["aria-label"] === "将图片2前移")!.props.onClick();
    expect(tray(app).props.references.map((item: any) => item.id)).toEqual(["original", "color", "pattern"]);
    expect(controls.filter(element => element.type === "div" && element.props.draggable === false)).toHaveLength(1);
    controls.find(element => element.props.children === "清空附加图")!.props.onClick();
    expect(tray(app).props.references.map((item: any) => item.id)).toEqual(["original"]);
    expect(app.node.metadata?.manualImageReferences).toEqual([]);
    view = tray(app);
    view.props.onChange([]);
    expect(tray(app).props.references.map((item: any) => item.id)).toEqual(["original"]);
});

test("reordering or removing auxiliaries updates mention numbers and preserves the fixed original", () => {
    const app = panel();
    let controls = elements(renderTray(tray(app).props));
    controls.find(element => element.props["aria-label"] === "将图片3前移")!.props.onClick();
    expect(tray(app).props.references.map((item: any) => item.id)).toEqual(["original", "pattern", "color"]);
    expect(app.node.metadata?.manualImageReferences?.map(item => item.id)).toEqual(["pattern", "color"]);
    const mentions = app.render().find(element => element.type === CanvasResourceMentionTextarea)!.props.references;
    expect(mentions.filter((item: any) => item.kind === "image").map((item: any) => [item.nodeId, item.label])).toEqual([["original", "图片1"], ["pattern", "图片2"], ["color", "图片3"]]);
    controls = elements(renderTray(tray(app).props));
    controls.filter(element => element.props["aria-label"] === "移除参考图")[0]!.props.onClick();
    expect(tray(app).props.references.map((item: any) => item.id)).toEqual(["original", "color"]);
});

test("the edit API receives exactly the displayed and mentioned image order, including after auxiliary reorder", async () => {
    const submitted: any[] = [];
    const requestEdit = loadComponent<typeof import("@/services/api/image").requestEdit>("../src/services/api/image.ts", "requestEdit", {
        "@/services/api/generation-tasks": { requestQueuedImages: async (input: unknown) => { submitted.push(input); return []; } },
        "./tool-runtime": { resolveToolConfig: async (config: typeof defaultConfig) => ({ config, toolKey: "canvas-edit", model: { id: "gpt-image-2", modelId: "gpt-image-2", name: "gpt-image-2", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 } }) },
    });
    const app = panel();
    const config = { ...defaultConfig, model: "gpt-image-2", imageModel: "gpt-image-2", systemPrompt: "" };
    await requestEdit(config, source.metadata!.draftPrompt!, resolveCanvasNodeImageReferences(app.node, [app.node], []));
    expect(submitted[0].references.map((item: any) => [item.id, item.dataUrl])).toEqual([
        ["original", "https://images.test/original.png"], ["color", "https://images.test/color.png"], ["pattern", "https://images.test/pattern.png"],
    ]);
    expect(submitted[0].prompt).toBe("参考图片编号：图片1、图片2、图片3。请按这些编号理解提示词中的图片引用。\n\n按图片2的配色和图片3的花型修改图片1");
    elements(renderTray(tray(app).props)).find(element => element.props["aria-label"] === "将图片3前移")!.props.onClick();
    await requestEdit(config, "用图片2的花型和图片3的配色修改图片1", resolveCanvasNodeImageReferences(app.node, [app.node], []));
    expect(submitted[1].references.map((item: any) => item.id)).toEqual(["original", "pattern", "color"]);
});

test("a removed connected auxiliary stays excluded after a later reorder", () => {
    const connected = { ...source, id: "connected", title: "连接图", metadata: { content: "https://images.test/connected.png" } };
    const app = panel(source, [source, connected], [{ id: "link", fromNodeId: "connected", toNodeId: source.id }]);
    let controls = elements(renderTray(tray(app).props));
    expect(tray(app).props.references.map((item: any) => item.id)).toEqual(["original", "color", "pattern", "connected"]);
    controls.filter(element => element.props["aria-label"] === "移除参考图")[2]!.props.onClick();
    controls = elements(renderTray(tray(app).props));
    controls.find(element => element.props["aria-label"] === "将图片3前移")!.props.onClick();
    expect(tray(app).props.references.map((item: any) => item.id)).toEqual(["original", "pattern", "color"]);
    expect(app.node.metadata?.excludedConnectedImageReferenceKeys).toEqual(["node:connected"]);
});

test("an ordinary reference tray retains its first-image move, removal and clear behavior", () => {
    const references = resolveCanvasNodeImageReferences(source, [source], []).slice(1);
    let next = references;
    const controls = elements(renderTray({ references, validation: { valid: true, minimum: 0, maximum: 16, supportsReferences: true }, onChange: (value: typeof references) => { next = value; }, onRequestUpload: noop }));
    controls.find(element => element.props["aria-label"] === "将图片1后移")!.props.onClick();
    expect(next.map(item => item.id)).toEqual(["pattern", "color"]);
    controls.find(element => element.props.children === "清空")!.props.onClick();
    expect(next).toEqual([]);
});

test("the canvas picker excludes its own original even if a stale selection submits its id", () => {
    const app = panel();
    const picker = app.render().find(element => element.type === CanvasImageReferenceDialog)!;
    expect(picker.props.nodes.some((item: CanvasNodeData) => item.id === source.id)).toBe(false);
    picker.props.onConfirm([source.id]);
    expect(app.node.metadata?.manualImageReferences?.map(item => item.id)).toEqual(["color", "pattern"]);
});

test("the reference limit counts the fixed original and disables an over-limit edit before submission", () => {
    const node = { ...source, metadata: { ...source.metadata, manualImageReferences: Array.from({ length: 16 }, (_, index) => ({ referenceKey: `upload:${index}`, id: String(index), name: `ref-${index}`, type: "image/png", content: `https://images.test/${index}.png`, origin: "upload" as const })) } };
    const app = panel(node);
    expect(tray(app).props.references).toHaveLength(17);
    expect(tray(app).props.validation.valid).toBe(false);
    const generate = app.render().find(element => element.props["aria-label"] === "生成")!;
    expect(generate.props.disabled).toBe(true);
    generate.props.onClick();
    expect(app.generate).toEqual([]);
});

test("a disabled node editing tool retains its ordered references and blocks its submit handler", () => {
    const requireModule = createRequire(new URL("../src/components/canvas/canvas-node-prompt-panel.tsx", import.meta.url));
    const disabledPanel = loadComponent("../src/components/canvas/canvas-node-prompt-panel.tsx", "CanvasNodePromptPanel", {
        "@/hooks/use-tool-config": { ...requireModule("@/hooks/use-tool-config"), useToolConfig: (config: typeof defaultConfig) => config, useToolEnabled: () => false },
    });
    const app = panel(source, [source], [], disabledPanel);
    expect(tray(app).props.references.map((item: any) => item.id)).toEqual(["original", "color", "pattern"]);
    const generate = app.render().find(element => element.props["aria-label"] === "生成")!;
    expect(generate.props.disabled).toBe(true);
    generate.props.onClick();
    expect(app.generate).toEqual([]);
    expect(app.node.metadata?.draftPrompt).toBe(source.metadata?.draftPrompt);
});

test("canvas badges follow the node edit references while quick generation keeps its own selected order", () => {
    const nodes: CanvasNodeData[] = [source, ...["color", "pattern"].map(id => ({ ...source, id, title: id, metadata: { content: `https://images.test/${id}.png`, storageKey: `image:${id}` } }))];
    const connections = [{ id: "color-input", fromNodeId: "color", toNodeId: source.id }];
    const ast = ts.createSourceFile("project.tsx", readFileSync(new URL("../src/pages/canvas/project.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let factory: ts.Node | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "resourceReferencesForActiveNode" && node.initializer && ts.isCallExpression(node.initializer)) factory = node.initializer.arguments[0];
        ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(factory).toBeDefined();
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const bindings = { assistantOpen: false, quickGenerateOpen: false, dialogNodeId: null, nodes, nodeById, connections,
        mentionReferenceIndex: createCanvasMentionReferenceIndex(nodes, connections), globalResourceReferenceIndex: createCanvasResourceReferenceIndex(nodes),
        resolveCanvasNodeImageReferences, canvasImageReferenceMentions, CanvasNodeType, quickGenerateReferences: [{ canvasNodeId: "pattern" }, { canvasNodeId: "color" }] };
    const labels = (quickGenerateOpen: boolean) => {
        const input = { ...bindings, quickGenerateOpen };
        const code = ts.transpileModule(`const resolve = ${factory!.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
        const references = new Function(...Object.keys(input), `${code} return resolve(${JSON.stringify(source.id)});`)(...Object.values(input)) as Map<string, { label: string }>;
        return [...references].map(([id, reference]) => [id, reference.label]);
    };
    expect(labels(false)).toEqual([["original", "图片1"], ["color", "图片2"], ["pattern", "图片3"]]);
    expect(labels(true)).toContainEqual(["pattern", "图片1"]);
    expect(labels(true)).toContainEqual(["color", "图片2"]);
});
