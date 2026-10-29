import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React, { type ReactElement } from "react";
import ts from "typescript";
import { i18nHarness } from "./helpers/i18n-harness";
import { buildCreativeImageCatalog } from "../src/lib/creative-chat";
import { chatImageOriginal } from "../src/pages/chat/chat-image-selection";

const source = readFileSync(new URL("../src/pages/chat/index.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("chat.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function bubbleHarness(actionsDisabled = false) {
    let initializer: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "ChatBubble") initializer = node.initializer;
        ts.forEachChild(node, visit);
    };
    visit(ast);
    if (!initializer) throw new Error("The actual ChatBubble component was not found");
    const calls: unknown[] = [];
    const bindings = {
        ...i18nHarness,
        React, memo: <T,>(component: T) => component,
        cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
        Bot: () => null, FileText: () => null, Copy: () => null, Pencil: () => null, RotateCcw: () => null,
        useCopyText: () => () => undefined, ChatMarkdown: "div", ChatImage: "chat-image", Tooltip: "div", chatImageOriginal,
    };
    const code = ts.transpileModule(`exports.Bubble = ${initializer.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React } }).outputText;
    const exports = {} as { Bubble: (props: any) => ReactElement<any> };
    new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exports);
    const generated = { id: "task:0", dataUrl: "data:image/png;base64,cmVzdWx0", lineage: { parentImageId: "original", sourceImageIds: ["original"], preservedConstraints: ["保留中文"] } };
    const message = { id: "assistant", role: "assistant", content: "", generatedImages: [generated], attachments: [
        { id: "original", name: "原图.png", dataUrl: "data:image/png;base64,b3JpZ2luYWw=" },
        { id: "brief", name: "规格.pdf", textContent: "20cm" },
    ] };
    const imageCatalog = buildCreativeImageCatalog([{ id: "user", role: "user", content: "", attachments: message.attachments }, { ...message, role: "assistant" }]);
    const imageActions: unknown[] = [];
    const tree = exports.Bubble({ message, imageLabels: new Map([["original", "图1"], ["task:0", "图2"]]), imageCatalog, selectedImageId: "task:0", actionsDisabled, onImageAction: (action: string, id: string) => imageActions.push([action, id]), onPlaceOnCanvas: (image: unknown) => calls.push(image) });
    const nodes: ReactElement<any>[] = [];
    function walk(value: any) {
        if (Array.isArray(value)) { value.forEach(walk); return; }
        if (!React.isValidElement(value)) return;
        const node = value as ReactElement<any>;
        nodes.push(node);
        walk(node.props.children);
    }
    walk(tree);
    const text = (value: any): string => Array.isArray(value) ? value.map(text).join("") : React.isValidElement(value) ? text((value as ReactElement<any>).props.children) : typeof value === "string" ? value : "";
    return { tree, nodes, calls, imageActions, generated, text };
}

test("the page keeps one natural conversation entry and no LLM model or mode selector", () => {
    const labels: string[] = [];
    const calledFunctions: string[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isJsxAttribute(node) && node.name.getText(ast) === "aria-label" && node.initializer) {
            const value = ts.isJsxExpression(node.initializer) && node.initializer.expression && ts.isCallExpression(node.initializer.expression) && node.initializer.expression.expression.getText(ast) === "uiText" ? node.initializer.expression.arguments[0] : node.initializer;
            if (value && ts.isStringLiteral(value)) labels.push(value.text);
        }
        if (ts.isCallExpression(node)) calledFunctions.push(node.expression.getText(ast));
        ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(labels.filter((label) => label === "出图模型")).toHaveLength(1);
    for (const label of ["对话模型", "编辑起点", "创作理解模型", "图像模型"]) expect(labels).not.toContain(label);
    for (const fn of ["switchMode", "continueEditing", "setMode", "onContinueEditing"]) expect(calledFunctions).not.toContain(fn);
});

test("real chat image bubbles wire originals and results to the shared image actions", () => {
    const page = bubbleHarness();
    const images = page.nodes.filter((node) => node.type === "chat-image");
    expect(images.map((node) => node.props.image.dataUrl)).toEqual(["data:image/png;base64,cmVzdWx0", "data:image/png;base64,b3JpZ2luYWw="]);
    const buttons = page.nodes.filter((node) => node.type === "button");
    expect(buttons.map((button) => page.text(button))).toEqual([]);
    expect(page.text(page.tree)).toContain("规格.pdf");
    expect(page.calls).toEqual([]);
    expect(images[0]!.props.selected).toBe(true);
    expect(images[0]!.props.originalDisabledReason).toBeUndefined();
    expect(images[1]!.props.originalDisabledReason).toBe("这张图已经是原图");
    for (const action of ["edit", "original", "reference", "compare", "download"]) images[0]!.props.onAction(action, "task:0");
    expect(page.imageActions).toEqual(["edit", "original", "reference", "compare", "download"].map((action) => [action, "task:0"]));
    images[0]!.props.onPlace();
    expect(page.calls).toEqual([page.generated]);
});

test("all result and upload image actions are disabled while a task is busy", () => {
    const page = bubbleHarness(true);
    expect(page.nodes.find((node) => node.type === "chat-image" && node.props.onPlace)?.props.disabled).toBe(true);
    expect(page.nodes.filter((node) => node.type === "chat-image").every((node) => node.props.disabled)).toBe(true);
    expect(page.calls).toEqual([]);
});

function imageActionHarness() {
    const initializers = new Map<string, string>();
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.initializer) initializers.set(node.name.getText(ast), node.initializer.getText(ast));
        ts.forEachChild(node, visit);
    };
    visit(ast);
    const catalog = buildCreativeImageCatalog([
        { id: "u", role: "user", content: "", attachments: [{ id: "original", name: "原图.png", kind: "image", dataUrl: "data:image/png;base64,AQID" }] },
        { id: "a", role: "assistant", content: "", generatedImages: [{ id: "result", dataUrl: "data:image/png;base64,AgID", storageKey: "image:result", lineage: { parentImageId: "original", sourceImageIds: ["original"], preservedConstraints: [] } }] },
    ]);
    const memory = { target: null as { id: string; mode: string; sessionId: string } | null, references: [] as string[], attachments: [] as any[], disabled: false, currentScope: true, focus: 0 };
    const warnings: string[] = [], downloads: unknown[] = [], comparisons: unknown[] = [];
    const code = ts.transpileModule(`const selectImageTarget = ${initializers.get("selectImageTarget")}; const addImageReference = ${initializers.get("addImageReference")}; exports.act = ${initializers.get("imageAction")}; exports.select = selectImageTarget;`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    const render = () => {
        const bindings = {
            ...i18nHarness, buildCreativeImageCatalog, chatImageOriginal, composerImageCatalog: catalog, imageActionsDisabled: memory.disabled,
            activeSession: { id: "session" }, isCurrentScope: () => memory.currentScope, attachments: memory.attachments,
            selectedImage: catalog.find((item) => item.id === memory.target?.id),
            setImageTarget: (value: typeof memory.target) => { memory.target = value; },
            setReferenceImageIds: (update: (ids: string[]) => string[]) => { memory.references = update(memory.references); },
            setAttachments: (update: (attachments: any[]) => any[]) => { memory.attachments = update(memory.attachments); },
            composerRef: { current: { focus: () => { memory.focus++; } } }, message: { warning: (value: string) => warnings.push(value) },
            dataUrlBytes: (value: string) => Math.floor((value.length - value.indexOf(",") - 1) * 0.75),
            imageTools: { download: async (image: unknown) => { downloads.push(image); }, compare: (image: unknown, originals: unknown[]) => comparisons.push({ image, originals }) },
        };
        const exports = {} as { act: (action: string, id: string) => void; select: (image: unknown) => boolean };
        new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exports);
        return exports;
    };
    return { memory, catalog, warnings, downloads, comparisons, act: (action: string, id: string) => render().act(action, id), select: (id: string) => render().select(catalog.find((image) => image.id === id)) };
}

test("real image handlers select the result or verified root without executing a model request", () => {
    const page = imageActionHarness();
    page.act("edit", "result");
    expect(page.memory.target).toEqual({ id: "result", mode: "edit", sessionId: "session" });
    page.act("original", "result");
    expect(page.memory.target).toEqual({ id: "original", mode: "original", sessionId: "session" });
    expect(page.memory.attachments).toEqual([]);
    expect(page.downloads).toEqual([]);
    expect(page.comparisons).toEqual([]);
    expect(page.memory.focus).toBe(2);
    page.act("original", "original");
    expect(page.warnings).toEqual(["这张图已经是原图"]);
});

test("setting a reference copies original identity once and never changes the selected target", () => {
    const page = imageActionHarness();
    page.act("edit", "original");
    page.act("reference", "result"); page.act("reference", "result");
    expect(page.memory.target?.id).toBe("original");
    expect(page.memory.references).toEqual(["result"]);
    expect(page.memory.attachments).toHaveLength(1);
    expect(page.memory.attachments[0]).toMatchObject({ id: "result", storageKey: "image:result", dataUrl: "data:image/png;base64,AgID", kind: "image" });
    expect(page.downloads).toEqual([]);
    expect(page.comparisons).toEqual([]);
});

test("reference limits reject before dropping any selected image or changing the target", () => {
    const page = imageActionHarness();
    page.memory.attachments = Array.from({ length: 4 }, (_, index) => ({ id: `image-${index}`, name: "图", kind: "image", dataUrl: "data:image/png;base64,AQID" }));
    page.act("edit", "original");
    const before = structuredClone(page.memory.attachments);
    page.act("reference", "result");
    expect(page.memory.attachments).toEqual(before);
    expect(page.memory.references).toEqual([]);
    expect(page.memory.target?.id).toBe("original");
    expect(page.warnings).toEqual(["编辑目标与参考图片合计最多 5 张，请先移除一张图片"]);
});

test("busy or stale-account image actions do not modify the composer or open media", () => {
    for (const blockedBy of ["disabled", "currentScope"] as const) {
        const page = imageActionHarness();
        page.memory[blockedBy] = blockedBy === "disabled";
        for (const action of ["edit", "original", "reference", "compare", "download"]) page.act(action, "result");
        expect(page.memory.target).toBeNull(); expect(page.memory.attachments).toEqual([]); expect(page.memory.references).toEqual([]);
        expect(page.downloads).toEqual([]); expect(page.comparisons).toEqual([]);
    }
});

test("compare and download forward original sources to the shared media effects", () => {
    const page = imageActionHarness();
    page.act("compare", "result"); page.act("download", "result");
    expect(page.comparisons).toEqual([{ image: page.catalog[1], originals: [page.catalog[0]] }]);
    expect(page.downloads).toEqual([page.catalog[1]]);
    expect(page.memory.target).toBeNull(); expect(page.memory.attachments).toEqual([]);
});
