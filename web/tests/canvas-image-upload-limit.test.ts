import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { assertCanvasImageUploadSize, CANVAS_IMAGE_MAX_BYTES } from "@/lib/canvas/canvas-image-upload-limit";

const source = ts.createSourceFile("project.tsx", readFileSync(new URL("../src/pages/canvas/project.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name: string, scope: Record<string, unknown>): (...args: any[]) => any {
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
    drop({ dataTransfer: { files: [large] }, preventDefault: () => { prevented = true; }, clientX: 0, clientY: 0 });
    await Promise.resolve();
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
