import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

import { getNodeSpec } from "@/constant/canvas";
import * as clipboard from "@/lib/canvas/canvas-system-clipboard";
import { createCanvasImageOperationRunner } from "@/lib/canvas/canvas-image-operation";
import { shouldIgnoreCanvasShortcut } from "@/lib/canvas/canvas-keyboard";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { createCanvasSelectionGenerationSync } from "@/lib/canvas/canvas-selection-prompt";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection, type CanvasNodeGroup } from "@/types/canvas";

// Execute the page's real keyboard/copy/paste/import callbacks, without mounting its unrelated editor UI.
// Only the image storage boundary and React state setters are supplied by this harness.
const source = readFileSync(new URL("../src/pages/canvas/project.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("project.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbackNames = new Set(["copySelectedNodes", "pasteCopiedNodes", "createImageFileNode", "createTextNodeFromClipboard", "pasteSystemClipboard"]);
const declarations: ts.Node[] = [];
let selectionEffect: ts.Node;
function containsIdentifier(node: ts.Node, names: string[]): boolean {
    if (ts.isIdentifier(node) && names.includes(node.text)) return true;
    return Boolean(ts.forEachChild(node, child => containsIdentifier(child, names) || undefined));
}
function collect(node: ts.Node) {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "useEffect"
        && containsIdentifier(node, ["syncSelectedGenerationRef"])) selectionEffect = node;
    else if (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => ts.isIdentifier(item.name) && callbackNames.has(item.name.text))) declarations.push(node);
    else if (ts.isFunctionDeclaration(node) && ["createCanvasNode", "imageMetadata"].includes(node.name?.text || "")) declarations.push(node);
    else if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "useEffect"
        && containsIdentifier(node, ["handleKeyDown", "bindCanvasClipboardEvents"])) declarations.push(node);
    else ts.forEachChild(node, collect);
}
collect(ast);
const code = ts.transpileModule(declarations.map(node => node.getText(ast)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
const selectionCode = ts.transpileModule(selectionEffect!.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

function data(files: File[] = [], text = "", items: Array<{ kind: string; type: string; getAsFile(): File | null }> = []) {
    const values = new Map<string, string>(text ? [["text/plain", text]] : []);
    return { files, items, getData: (type: string) => values.get(type) || "", setData: (type: string, value: string) => { values.set(type, value); } };
}

function surface(...matches: string[]) {
    return { closest: (selector: string) => selector.split(",").some(part => matches.includes(part.trim())) ? {} : null };
}

function harness(initialNodes: CanvasNodeData[] = [], initialConnections: CanvasConnection[] = [], waitForUpload?: () => Promise<void>) {
    const target = new EventTarget();
    const nodesRef = { current: initialNodes };
    const connectionsRef = { current: initialConnections };
    const groupsRef = { current: [] as CanvasNodeGroup[] };
    const selectedNodeIdsRef = { current: new Set(initialNodes.map(node => node.id)) };
    const imports: File[] = [];
    const errors: unknown[] = [];
    const pending: Promise<unknown>[] = [];
    const disposers: Array<() => void> = [];
    const imageOperations = createCanvasImageOperationRunner();
    const syncSelectedGenerationRef = { current: createCanvasSelectionGenerationSync() };
    let prompt = "";
    function runSelectionEffect() {
        const state = { useEffect: (effect: () => void) => effect(), syncSelectedGenerationRef, selectedNodeIds: selectedNodeIdsRef.current,
            assistantSelectedNodes: nodesRef.current.filter(node => selectedNodeIdsRef.current.has(node.id)), projectId: "clipboard-test",
            setQuickGeneratePrompt: (value: string) => { prompt = value; },
            setQuickGenerateModel: () => {}, setQuickGenerateSize: () => {}, setQuickGenerateQuality: () => {},
            setQuickGenerateCount: () => {}, setQuickGenerateImageOptions: () => {} };
        new Function("state", `const { ${Object.keys(state).join(",")} } = state; ${selectionCode}`)(state);
    }
    let nextId = 0;
    const noop = () => {};
    const update = <T>(ref: { current: T }) => (value: T | ((current: T) => T)) => { ref.current = typeof value === "function" ? (value as (current: T) => T)(ref.current) : value; };
    const env = {
        ...clipboard, shouldIgnoreCanvasShortcut, fitNodeSize, getNodeSpec, CanvasNodeType, NODE_STATUS_SUCCESS: "success",
        window: target, navigator: {}, // HTTP/permissionless path: no navigator.clipboard exists.
        useCallback: (callback: unknown) => callback,
        useEffect: (effect: () => (() => void) | void) => { const dispose = effect(); if (dispose) disposers.push(dispose); },
        nanoid: () => `fixture-${++nextId}`,
        syncSelectedGenerationRef, projectId: "clipboard-test",
        nodesRef, connectionsRef, groupsRef, selectedNodeIdsRef, clipboardRef: { current: null },
        getCanvasCenter: () => ({ x: 300, y: 200 }),
        setNodes: update(nodesRef), setConnections: update(connectionsRef), setGroups: update(groupsRef),
        setSelectedNodeIds: (value: Set<string>) => { selectedNodeIdsRef.current = value; queueMicrotask(runSelectionEffect); }, commitSelectedNodeIds: update(selectedNodeIdsRef),
        setSelectedConnectionId: noop, setDialogNodeId: noop, setContextMenu: noop,
        selectedConnectionId: null, createSelectedGroup: noop, deleteConnection: noop, deleteNodes: noop,
        redoCanvas: noop, undoCanvas: noop, cancelSelectionPreview: noop, setConnecting: noop,
        setHoveredNodeId: noop, setToolbarNodeId: noop, setEditingNodeId: noop, setInfoNodeId: noop,
        setCropNodeId: noop, setMaskEditNodeId: noop, setPendingConnectionCreate: noop,
        message: { success: noop },
        uploadImage: async (file: File) => {
            imports.push(file);
            await waitForUpload?.();
            return { url: `blob:${file.name}`, storageKey: `image:${file.name}`, width: 320, height: 180, bytes: file.size, mimeType: file.type, originalFileName: file.name };
        },
        runLocalImageOperation: (key: string, _label: string, operation: (signal: AbortSignal) => Promise<void>) => {
            const task = imageOperations.run(key, operation, { start: noop, finish: noop, error: error => { errors.push(error); } });
            pending.push(task);
            return task;
        },
    };
    new Function("env", `const { ${Object.keys(env).join(",")} } = env; ${code}`)(env);
    runSelectionEffect();
    function emit(type: string, transfer: ReturnType<typeof data> | null, options: { target?: unknown; handled?: boolean } = {}) {
        const event = new Event(type, { cancelable: true });
        Object.defineProperty(event, "clipboardData", { value: transfer });
        if (options.target) Object.defineProperty(event, "target", { value: options.target });
        if (options.handled) event.preventDefault();
        target.dispatchEvent(event);
        return event;
    }
    function key(key: string) {
        const event = Object.assign(new Event("keydown", { cancelable: true }), { key, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0 });
        target.dispatchEvent(event);
        return event;
    }
    return {
        nodes: () => nodesRef.current, connections: () => connectionsRef.current, imports, errors, emit, key,
        prompt: () => prompt, typePrompt: (value: string) => { prompt = value; },
        select: (ids: string[]) => { selectedNodeIdsRef.current = new Set(ids); runSelectionEffect(); },
        copy: () => { const transfer = data(); if (!key("c").defaultPrevented) emit("copy", transfer); return transfer; },
        paste: (transfer: ReturnType<typeof data>) => !key("v").defaultPrevented ? emit("paste", transfer) : null,
        flush: () => Promise.all(pending), dispose: () => { disposers.forEach(dispose => dispose()); },
    };
}

function node(id: string): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 80, height: 60, metadata: { storageKey: `image:${id}`, content: `blob:${id}` } };
}
const screenshot = () => new File([new Uint8Array([0, 255, 1, 2])], "screenshot.png", { type: "image/png" });

describe("native canvas clipboard", () => {
    test("Ctrl+V imports the event screenshot without async clipboard permissions or duplicate item/file imports", async () => {
        const canvas = harness();
        const image = screenshot();
        const event = canvas.paste(data([image], "", [{ kind: "file", type: image.type, getAsFile: () => image }]));
        await canvas.flush();
        expect(canvas.nodes()).toHaveLength(1);
        expect(event?.defaultPrevented).toBe(true);
        expect(canvas.imports).toEqual([image]);
        expect(await canvas.imports[0]!.arrayBuffer()).toEqual(await image.arrayBuffer());
        expect(canvas.nodes()[0]).toMatchObject({ type: CanvasNodeType.Image, metadata: { storageKey: "image:screenshot.png", naturalWidth: 320, naturalHeight: 180, originalFileName: "screenshot.png" } });
        expect(canvas.errors).toEqual([]);
    });

    test("falls back to image items and imports multiple original files in order", async () => {
        const canvas = harness();
        const first = screenshot();
        const second = new File(["other bytes"], "second.webp", { type: "image/webp" });
        canvas.emit("paste", data([], "", [
            { kind: "file", type: "image/png", getAsFile: () => null },
            { kind: "file", type: first.type, getAsFile: () => first },
            { kind: "file", type: second.type, getAsFile: () => second },
        ]));
        await canvas.flush();
        expect(canvas.nodes().map(node => node.title)).toEqual(["screenshot.png", "second.webp"]);
        expect(canvas.imports).toEqual([first, second]);
        expect(canvas.nodes()[0]!.position).not.toEqual(canvas.nodes()[1]!.position);
    });

    test("two separate paste gestures each import once even while the first image is still being stored", async () => {
        const canvas = harness();
        const image = screenshot();
        canvas.paste(data([image]));
        canvas.paste(data([image]));
        await canvas.flush();
        expect(canvas.nodes()).toHaveLength(2);
        expect(canvas.imports).toEqual([image, image]);
        expect(canvas.errors).toEqual([]);
    });

    test("native copy/paste retains selected nodes and reconnects the copied endpoints", async () => {
        const canvas = harness([node("a"), node("b")], [{ id: "edge", fromNodeId: "a", toNodeId: "b" } as CanvasConnection]);
        const copied = canvas.copy();
        canvas.paste(copied);
        await canvas.flush();
        expect(canvas.nodes()).toHaveLength(4);
        const copies = canvas.nodes().slice(2);
        expect(copies.map(item => item.metadata?.storageKey)).toEqual(["image:a", "image:b"]);
        expect(canvas.connections()).toHaveLength(2);
        expect(canvas.connections()[1]).toMatchObject({ fromNodeId: copies[0]!.id, toNodeId: copies[1]!.id });
        expect(copies[0]!.id).not.toBe("a");
    });

    test("a new screenshot or text replaces an old internal buffer instead of pasting stale nodes", async () => {
        const canvas = harness([node("old")]);
        canvas.copy();
        canvas.paste(data([screenshot()], "image caption"));
        await canvas.flush();
        expect(canvas.nodes().map(item => item.title)).toEqual(["old", "screenshot.png"]);
        canvas.paste(data([], "新的设计说明"));
        await canvas.flush();
        expect(canvas.nodes()).toHaveLength(3);
        expect(canvas.nodes()[2]).toMatchObject({ type: CanvasNodeType.Text, metadata: { content: "新的设计说明" } });
    });

    test("images take precedence even when clipboard data also carries a valid copied-node marker", async () => {
        const canvas = harness([node("old")]);
        const copied = canvas.copy();
        copied.files.push(screenshot());
        canvas.paste(copied);
        await canvas.flush();
        expect(canvas.nodes().map(item => item.title)).toEqual(["old", "screenshot.png"]);
    });

    test("copying text in an editor never replaces its clipboard with selected canvas nodes", () => {
        const canvas = harness([node("old")]);
        const text = data([], "editor text");
        expect(canvas.emit("copy", text, { target: surface("textarea") }).defaultPrevented).toBe(false);
        expect(text.getData("text/plain")).toBe("editor text");
    });

    test.each(["input", "textarea", "[contenteditable]:not([contenteditable='false'])", "[role='dialog']", ".ant-modal"])("leaves text and image paste on %s to its own editor", async selector => {
        const canvas = harness([node("old")]);
        canvas.copy();
        for (const transfer of [data([], "keep in editor"), data([screenshot()])]) {
            const event = canvas.emit("paste", transfer, { target: surface(selector) });
            expect(event.defaultPrevented).toBe(false);
        }
        await canvas.flush();
        expect(canvas.nodes()).toHaveLength(1);
    });

    test("the explicit quick prompt target imports images but preserves normal text paste", async () => {
        const canvas = harness();
        const prompt = surface("textarea", "[data-canvas-image-paste]");
        const textEvent = canvas.emit("paste", data([], "prompt text"), { target: prompt });
        expect(textEvent.defaultPrevented).toBe(false);
        expect(canvas.nodes()).toEqual([]);
        const imageEvent = canvas.emit("paste", data([screenshot()], "image caption"), { target: prompt });
        await canvas.flush();
        expect(imageEvent.defaultPrevented).toBe(true);
        expect(canvas.nodes()).toHaveLength(1);
        expect(canvas.nodes()[0]!.type).toBe(CanvasNodeType.Image);
    });

    test("clipboard import preserves the live draft through selection synchronization without forging image provenance", async () => {
        const original = { ...node("generated"), metadata: { ...node("generated").metadata, prompt: "原图提示词" } };
        const canvas = harness([original]);
        canvas.typePrompt("提示词必须保留");
        canvas.emit("paste", data([screenshot(), new File(["second"], "second.png", { type: "image/png" })]), { target: surface("textarea", "[data-canvas-image-paste]") });
        await canvas.flush();
        expect(canvas.prompt()).toBe("提示词必须保留");
        expect(canvas.nodes().slice(1).every(item => item.metadata?.prompt === undefined)).toBe(true);
        canvas.select(["generated"]);
        expect(canvas.prompt()).toBe("原图提示词");
        canvas.select([canvas.nodes()[1]!.id]);
        expect(canvas.prompt()).toBe(""); // Manual image selection keeps its established provenance behavior.
    });

    test("typing during an in-flight screenshot import is not replaced by an earlier draft", async () => {
        const upload = Promise.withResolvers<void>();
        const canvas = harness([], [], () => upload.promise);
        canvas.typePrompt("较早草稿");
        canvas.paste(data([screenshot()]));
        await Promise.resolve();
        canvas.typePrompt("上传期间继续输入的新草稿");
        upload.resolve();
        await canvas.flush();
        expect(canvas.prompt()).toBe("上传期间继续输入的新草稿");
    });

    test("handled assistant events and prompt targets inside a modal never import twice", async () => {
        const canvas = harness();
        canvas.emit("paste", data([screenshot()]), { handled: true });
        const event = canvas.emit("paste", data([screenshot()]), { target: surface("textarea", "[data-canvas-image-paste]", ".ant-modal") });
        expect(event.defaultPrevented).toBe(false);
        await canvas.flush();
        expect(canvas.nodes()).toEqual([]);
    });

    test("empty, missing and unknown clipboards never replay an old buffer; disposal removes listeners", async () => {
        const canvas = harness([node("old")]);
        canvas.copy();
        for (const transfer of [null, data(), data([], "   "), data([new File(["pdf"], "file.pdf", { type: "application/pdf" })])]) {
            expect(canvas.emit("paste", transfer).defaultPrevented).toBe(false);
        }
        canvas.dispose();
        canvas.emit("paste", data([screenshot()]));
        await canvas.flush();
        expect(canvas.nodes()).toHaveLength(1);
        expect(canvas.errors).toEqual([]);
    });
});
