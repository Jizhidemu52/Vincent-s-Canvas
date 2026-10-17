import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { prepareCanvasBatchFiles } from "@/pages/canvas/canvas-batch-edit-runtime";
import { assertCanvasImageUploadSize, CANVAS_IMAGE_MAX_BYTES } from "@/lib/canvas/canvas-image-upload-limit";

test("multi-file selection keeps all supported images in natural filename order", () => {
    const files = ["10.png", "2.png", "1.png"].map(name => new File(["image"], name, { type: "image/png" }));
    const items = prepareCanvasBatchFiles([...files, new File(["note"], "readme.txt", { type: "text/plain" })]);
    expect(items.map(item => item.relativePath)).toEqual(["1.png", "2.png", "10.png"]);
    expect(items.map(item => item.file)).toEqual([files[2], files[1], files[0]]);
    expect(items.every(item => item.status === "waiting")).toBe(true);
    expect(new Set(items.map(item => item.id)).size).toBe(3);
});

test("100 input tasks are accepted but oversized selections are not silently truncated", () => {
    const file = new File(["image"], "a.png", { type: "image/png" });
    expect(prepareCanvasBatchFiles(Array(100).fill(file))).toHaveLength(100);
    expect(() => prepareCanvasBatchFiles(Array(101).fill(file))).toThrow("最多处理 100");
});

test("batch file selection accepts exactly 20 MiB and rejects any larger file without changing the input", () => {
    const boundary = new File([new Uint8Array(CANVAS_IMAGE_MAX_BYTES)], "boundary.png", { type: "image/png" });
    expect(prepareCanvasBatchFiles([boundary])[0]?.file).toBe(boundary);
    const large = new File([new Uint8Array(CANVAS_IMAGE_MAX_BYTES + 1)], "large.png", { type: "image/png" });
    const selected = [boundary, large];
    expect(() => prepareCanvasBatchFiles(selected)).toThrow("large.png");
    expect(selected).toEqual([boundary, large]);
});

test("batch execution rejects stale oversized selections before uploading, queueing or changing the canvas", async () => {
    const source = ts.createSourceFile("canvas-batch-edit-runtime.ts", readFileSync(new URL("../src/pages/canvas/canvas-batch-edit-runtime.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "runCanvasBatchImageEdit")!;
    const code = ts.transpileModule(declaration.getText(source).replace(/^export\s+/, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    const effects: string[] = [];
    const errors: string[] = [];
    const dependencies = {
        assertCanvasImageUploadSize, modelOptionName: (model: string) => model, deploymentFeatures: { creditsEnabled: false },
        uploadImage: async () => { effects.push("upload"); throw new Error("No upload expected"); },
        requestBatchEdit: async () => { effects.push("submit"); throw new Error("No generation expected"); },
        nanoid: () => { effects.push("allocate"); return "test"; },
    };
    const run = new Function(...Object.keys(dependencies), `${code};return runCanvasBatchImageEdit`)(...Object.values(dependencies));
    const files = [new File(["image"], "small.png", { type: "image/png" }), new File([new Uint8Array(CANVAS_IMAGE_MAX_BYTES + 1)], "large.png", { type: "image/png" })];
    const items = files.map((file, index) => ({ id: String(index), file, relativePath: file.name, status: "waiting" }));
    const mutate = () => { effects.push("state"); };
    await run({ prompt: "edit", items, config: { model: "test" }, estimate: () => ({ configured: true, credits: 0 }),
        isAiConfigReady: () => true, onMissingModel: mutate, user: { status: "active", creditBalance: 100 }, projectId: "test",
        getCenter: () => ({ x: 0, y: 0 }), imageMetadata: mutate, addAssets: mutate, setRunning: mutate, setServerId: mutate,
        setAction: mutate, setItems: mutate, setNodes: mutate, setConnections: mutate, setSelectedNodeIds: mutate,
        message: { error: (text: string) => errors.push(text), warning: mutate, success: mutate },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("large.png");
    expect(errors[0]).toContain("20 MB");
    expect(effects).toEqual([]);
    expect(items.map(item => item.status)).toEqual(["waiting", "waiting"]);
});
