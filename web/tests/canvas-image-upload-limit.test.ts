import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { assertCanvasImageUploadSize, CANVAS_IMAGE_MAX_BYTES } from "@/lib/canvas/canvas-image-upload-limit";
import { isCanvasAudioFile } from "@/pages/canvas/use-canvas-clipboard-drop";

const pageSource = ["project.tsx", "use-canvas-quick-generation.ts"]
    .map(file => readFileSync(new URL(`../src/pages/canvas/${file}`, import.meta.url), "utf8")).join("\n");
const source = ts.createSourceFile("project.tsx", pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name: string, scope: Record<string, unknown>): (...args: any[]) => any {
    if (name === "handleDrop") {
        const hook = ts.createSourceFile("drop.ts", readFileSync(new URL("../src/pages/canvas/use-canvas-clipboard-drop.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
        let action: ts.Node | undefined;
        const find = (node: ts.Node) => { if (ts.isReturnStatement(node) && node.expression && ts.isCallExpression(node.expression) && node.expression.expression.getText(hook) === "useCallback") action = node.expression.arguments[0]; ts.forEachChild(node, find); };
        find(hook);
        if (!action) throw new Error("Missing extracted drop callback");
        const code = ts.transpileModule(`const run = ${action.getText(hook)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
        const message = scope.message as { error: unknown; warning?: unknown };
        const latest = { current: { screenToCanvas: scope.screenToCanvas, createImage: scope.createImageFileNode, createVideo: scope.createVideoFileNode, createAudio: scope.createAudioFileNode, error: message.error, warning: message.warning } };
        return new Function("latest", "isCanvasAudioFile", "createClientId", `${code} return run;`)(latest, isCanvasAudioFile, () => "upload-limit-test");
    }
    let expression: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) expression = node.initializer.arguments[0];
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (!expression) throw new Error(`Missing callback: ${name}`);
    const code = ts.transpileModule(`const run = ${expression.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function("scope", `with (scope) { ${code} return run; }`)(new Proxy({ Error, Array, Math, assertCanvasImageUploadSize, ...scope }, { has: () => true }));
}
const large = { name: "too-large.png", type: "image/png", size: CANVAS_IMAGE_MAX_BYTES + 1 };
const small = { name: "normal.png", type: "image/png", size: 100 };

test("20 MiB is accepted unchanged and even one extra byte is rejected with a clear limit", () => {
    expect(() => assertCanvasImageUploadSize(small)).not.toThrow();
    expect(() => assertCanvasImageUploadSize({ size: CANVAS_IMAGE_MAX_BYTES })).not.toThrow();
    expect(() => assertCanvasImageUploadSize(large)).toThrow("too-large.png」超过 20 MB");
});

test("image-node creation rejects before storing bytes or mutating the canvas", async () => {
    let uploads = 0, changes = 0;
    const create = callback("createImageFileNode", {
        uploadImage: () => uploads++, setNodes: () => changes++, setSelectedNodeIds: () => changes++,
    });
    await expect(create(large, { x: 0, y: 0 })).rejects.toThrow("超过 20 MB");
    expect(uploads).toBe(0);
    expect(changes).toBe(0);
});

test("drop catches the size error and shows feedback instead of leaving an unhandled rejection", async () => {
    const errors: string[] = [];
    const create = callback("createImageFileNode", {});
    const drop = callback("handleDrop", {
        screenToCanvas: () => ({ x: 0, y: 0 }), isAudioFile: () => false,
        createImageFileNode: create,
        message: { error: (text: string) => errors.push(text) },
    });
    let prevented = false;
    await drop({ dataTransfer: { files: [large] }, preventDefault: () => { prevented = true; }, clientX: 0, clientY: 0 });
    expect(prevented).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("超过 20 MB");
});

test("file-picker rejection preserves a replacement target and resets the input for reselection", async () => {
    for (const target of [null, { nodeId: "existing-image" }]) {
        const messages: string[] = [];
        const uploadTargetRef = { current: target };
        const input = { files: [large], value: "too-large.png" };
        const change = callback("handleImageInputChange", { uploadTargetRef, message: { error: (text: string) => messages.push(text) }, isAudioFile: () => false });
        await change({ target: input });
        expect(messages[0]).toContain("超过 20 MB");
        expect(uploadTargetRef.current).toBeNull();
        expect(input.value).toBe("");
    }
});

test("file-picker reports decode failures without mutating a replacement and can select the same file again", async () => {
    for (const target of [null, { nodeId: "existing-image" }]) {
        let mutations = 0;
        const errors: string[] = [];
        const invalid = async () => { throw new Error("图片无法读取，请选择有效的图片"); };
        const uploadTargetRef = { current: target };
        const change = callback("handleImageInputChange", {
            uploadTargetRef, isAudioFile: () => false, uploadImage: invalid, createImageFileNode: invalid,
            screenToCanvas: () => ({ x: 0, y: 0 }), size: { width: 100, height: 100 }, containerRef: { current: null },
            message: { error: (text: string) => errors.push(text) }, setNodes: () => mutations++,
        });
        const input = { files: [small], value: "normal.png" };
        await change({ target: input });
        expect(errors).toEqual(["图片无法读取，请选择有效的图片"]);
        expect(input.value).toBe("");
        expect(uploadTargetRef.current).toBeNull();
        expect(mutations).toBe(0);
    }
});

test("multi-file drop imports every supported file in order and continues after a failed image", async () => {
    const calls: { name: string; x: number; y: number }[] = [];
    const errors: string[] = [], warnings: string[] = [];
    const create = async (file: typeof small, position: { x: number; y: number }) => {
        calls.push({ name: file.name, ...position });
        if (file.name === "broken.png") throw new Error("图片损坏");
    };
    const drop = callback("handleDrop", {
        screenToCanvas: () => ({ x: 10, y: 20 }), isAudioFile: (file: typeof small) => file.type.startsWith("audio/"),
        createImageFileNode: create, createVideoFileNode: create, createAudioFileNode: create,
        message: { error: (text: string) => errors.push(text), warning: (text: string) => warnings.push(text) },
    });
    await drop({ dataTransfer: { files: [small, { ...small, name: "broken.png" }, { name: "notes.txt", type: "text/plain" }, { name: "clip.mp4", type: "video/mp4" }, { name: "audio.mp3", type: "audio/mpeg" }] }, preventDefault() {}, clientX: 0, clientY: 0 });
    expect(calls).toEqual([
        { name: "normal.png", x: 10, y: 20 }, { name: "broken.png", x: 46, y: 56 },
        { name: "clip.mp4", x: 82, y: 92 }, { name: "audio.mp3", x: 118, y: 128 },
    ]);
    expect(errors).toEqual(["broken.png：图片损坏"]);
    expect(warnings).toEqual(["仅支持图片、视频和音频，其他文件已跳过"]);
});

test("clipboard validates the entire selection before creating any node or success message", async () => {
    let created = 0, succeeded = 0;
    const paste = callback("pasteSystemClipboard", {
        nanoid: () => "test", getCanvasCenter: () => ({ x: 0, y: 0 }),
        runLocalImageOperation: (_key: string, _label: string, task: (signal: AbortSignal) => Promise<void>) => task(new AbortController().signal),
        createImageFileNode: () => created++, message: { success: () => succeeded++ },
    });
    await expect(paste([small, large])).rejects.toThrow("超过 20 MB");
    expect(created).toBe(0);
    expect(succeeded).toBe(0);
});

test("creation-panel references reject oversized files before starting any upload", async () => {
    let uploads = 0, changes = 0;
    const errors: string[] = [];
    const change = callback("handleQuickReferenceInputChange", {
        modelOptionName: () => "test", quickGenerateModel: "test", quickGenerateReferences: [],
        validateImageReferences: () => ({ maximum: 16 }),
        uploadImage: () => uploads++, setQuickGenerateReferences: () => changes++,
        message: { error: (text: string) => errors.push(text), warning: () => {} },
    });
    const input = { files: [small, large], value: "selection" };
    await change({ target: input });
    expect(errors[0]).toContain("超过 20 MB");
    expect(uploads).toBe(0);
    expect(changes).toBe(0);
    expect(input.value).toBe("");
});
