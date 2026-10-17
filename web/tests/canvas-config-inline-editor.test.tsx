import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { CanvasConfigNodePanel, configReferencePresentation } from "@/components/canvas/canvas-config-node-panel";
import { CanvasConfigImageReferences, configImageReferencePatch } from "@/components/canvas/canvas-config-image-references";
import { createImageReferenceItem, dedupeImageReferences, moveImageReference } from "@/lib/image-reference-policy";
import { resolveCanvasImageReferences, toCanvasStoredImageReference } from "@/lib/canvas/canvas-image-references";
import { assertCanvasImageUploadSize, CANVAS_IMAGE_MAX_BYTES } from "@/lib/canvas/canvas-image-upload-limit";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";

const noop = () => {};
const node: CanvasNodeData = { id: "config", type: CanvasNodeType.Config, title: "配置", position: { x: 0, y: 0 }, width: 360, height: 420, metadata: { composerContent: "保持主体不变" } };
const image = (id: string, origin: "upload" | "connection" = "upload") => createImageReferenceItem({ id, name: `${id}.png`, type: "image/png", dataUrl: `blob:${id}`, storageKey: `image:${id}` }, origin);

test("per-image display separates task inputs from common image numbering and mentions", () => {
    const references = [image("a", "connection"), image("b", "connection"), image("common")];
    const inputs = [
        ...references.slice(0, 2).map(image => ({ nodeId: image.id, type: "image" as const, title: image.name, image })),
        { nodeId: "text", type: "text" as const, title: "说明", text: "保留轮廓" },
    ];
    const separate = configReferencePresentation(references, inputs, "image", true);
    expect(separate.trayLabels).toEqual({ "connection:a": "任务输入1", "connection:b": "任务输入2", "upload:common": "图片2" });
    expect(separate.mentionLabels).toEqual({ common: "图片2" });
    expect(separate.inputs.map(input => input.nodeId)).toEqual(["text", "common"]);
    const html = renderToStaticMarkup(<CanvasConfigImageReferences node={node} references={references} labels={separate.trayLabels} disabled={false} onChange={noop} />);
    expect(html).toContain("任务输入1");
    expect(html).toContain("任务输入2");
    expect(html).toContain('aria-label="移除图片2"');
    expect(html).not.toContain("参考图3");
    // Combined references and explicit-target mode use the established full input list.
    const combined = configReferencePresentation(references, inputs, "image", false);
    expect(combined.trayLabels).toBeUndefined();
    expect(combined.mentionLabels).toBeUndefined();
    expect(combined.inputs.map(input => input.nodeId)).toEqual(["text", "a", "b", "common"]);
});

function panel(mode: CanvasGenerationMode) {
    return renderToStaticMarkup(<CanvasConfigNodePanel node={{ ...node, metadata: { ...node.metadata, generationMode: mode } }} isRunning={false} inputSummary={{ textCount: 0, imageCount: 0, videoCount: 2, audioCount: 1 }} onConfigChange={noop} onGenerate={noop} onStop={noop} />);
}

test("image config edits prompts inline with one upload entry and no irrelevant or zero-count input chips", () => {
    const html = panel("image");
    expect(html).toContain('role="textbox"');
    expect(html).toContain('aria-label="提示词"');
    expect(html).toContain('contentEditable="true"');
    expect(html).toContain("添加参考图");
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="image/*"');
    for (const text of ["组装提示词", "参考视频", "参考音频", "已连视频", "已连音频", "0 张", "0 个"]) expect(html).not.toContain(text);
});

test("only video mode displays connected media, and audio mode has TTS text without image controls", () => {
    const video = panel("video");
    expect(video).toContain("已连视频");
    expect(video).toContain("已连音频");
    expect(video).toContain("添加参考图");
    const audio = panel("audio");
    expect(audio).toContain('aria-label="朗读文本"');
    for (const text of ["添加参考图", "已连视频", "已连音频", 'type="file"']) expect(audio).not.toContain(text);
    const text = panel("text");
    expect(text).not.toContain("已连视频");
    expect(text).not.toContain("已连音频");
});

test("reference thumbnails have explicit remove and order controls only when populated", () => {
    const empty = renderToStaticMarkup(<CanvasConfigImageReferences node={node} references={[]} disabled={false} onChange={noop} />);
    expect(empty).not.toContain("0 张");
    expect(empty).not.toContain("<img");
    const populated = renderToStaticMarkup(<CanvasConfigImageReferences node={node} references={[image("a"), image("b")]} disabled={false} onChange={noop} />);
    expect(populated).toContain('aria-label="移除参考图1"');
    expect(populated).toContain('aria-label="参考图2前移"');
    expect(populated).toContain('aria-label="参考图1后移"');
    // Reloaded graph URLs belong to an old document; wait for storage-backed resolution.
    expect(populated).not.toContain('src="blob:a"');
    expect(populated).toContain("正在恢复媒体预览");
});

test("reference edits persist uploads, exclude connected images without deleting graph edges, and preserve order", () => {
    const connected = { ...image("connected", "connection"), referenceKey: "node:connected" };
    const uploaded = image("uploaded");
    const config = { ...node, metadata: { ...node.metadata, manualImageReferences: [toCanvasStoredImageReference(uploaded)] } };
    const source: CanvasNodeData = { ...node, id: "connected", type: CanvasNodeType.Image, metadata: { content: connected.dataUrl, storageKey: connected.storageKey } };
    const connections = [{ id: "edge", fromNodeId: source.id, toNodeId: config.id }];
    const current = [uploaded, connected];
    const reordered = moveImageReference(current, 1, 0);
    const orderPatch = configImageReferencePatch(config, current, reordered);
    expect(orderPatch.imageReferenceOrder).toEqual(["node:connected", uploaded.referenceKey]);
    expect(orderPatch.manualImageReferences?.[0]).toMatchObject({ content: "blob:uploaded", storageKey: "image:uploaded" });
    const removePatch = configImageReferencePatch(config, current, [uploaded]);
    expect(removePatch.excludedConnectedImageReferenceKeys).toEqual(["node:connected"]);
    expect(resolveCanvasImageReferences({ ...config, metadata: { ...config.metadata, ...removePatch } }, [config, source], connections).map(item => item.id)).toEqual(["uploaded"]);
    expect(connections).toHaveLength(1);
    expect(config.metadata.manualImageReferences).toHaveLength(1);
});

// Exercise the component's actual upload and file-input handlers without module mocks,
// persistence, network requests, or mounting unrelated canvas controls.
const uploadSource = readFileSync(new URL("../src/components/canvas/canvas-config-image-references.tsx", import.meta.url), "utf8");
const uploadAst = ts.createSourceFile("canvas-config-image-references.tsx", uploadSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let addFilesInitializer: ts.Expression | undefined;
let fileInputHandler: ts.Expression | undefined;
function findUploadHandlers(value: ts.Node) {
    if (ts.isVariableDeclaration(value) && value.name.getText(uploadAst) === "addFiles") addFilesInitializer = value.initializer;
    if (ts.isJsxSelfClosingElement(value) && value.tagName.getText(uploadAst) === "input") {
        const attribute = value.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(uploadAst) === "onChange") as ts.JsxAttribute | undefined;
        if (attribute?.initializer && ts.isJsxExpression(attribute.initializer)) fileInputHandler = attribute.initializer.expression;
    }
    ts.forEachChild(value, findUploadHandlers);
}
findUploadHandlers(uploadAst);
if (!addFilesInitializer || !fileInputHandler) throw new Error("The real config reference upload handlers were not found");
const uploadHandlerCode = ts.transpileModule(`const addFiles = ${addFilesInitializer.getText(uploadAst)};
exports.addFiles = addFiles;
exports.onInputChange = ${fileInputHandler.getText(uploadAst)};`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

function uploadHarness(failUpload = false) {
    const original = [image("existing")];
    const references = [...original];
    const uploads: File[] = [];
    const patches: Array<Partial<NonNullable<CanvasNodeData["metadata"]>>> = [];
    const messages: string[] = [];
    const uploadingRef = { current: false };
    let uploading = false;
    let error = "";
    let nextId = 0;
    const env = {
        node, disabled: false, uploadingRef,
        latest: { current: { node, references, onChange: (_id: string, patch: typeof patches[number]) => patches.push(patch) } },
        setUploading: (value: boolean) => { uploading = value; },
        setError: (value: string) => { error = value; },
        message: { error: (detail: string) => { messages.push(detail); } },
        assertCanvasImageUploadSize, createImageReferenceItem, dedupeImageReferences, configImageReferencePatch,
        createClientId: () => `uploaded-${++nextId}`,
        uploadImage: async (file: File) => {
            uploads.push(file);
            if (failUpload) throw new Error("测试存储失败");
            return { url: `blob:${file.name}`, storageKey: `image:${file.name}`, mimeType: file.type, bytes: file.size };
        },
    };
    const handlers = {} as { addFiles: (files: File[]) => Promise<void>; onInputChange: (event: { target: { files: File[]; value: string } }) => void };
    new Function("env", "exports", `const { ${Object.keys(env).join(",")} } = env; ${uploadHandlerCode}`)(env, handlers);
    return { ...handlers, uploads, patches, messages, original, references, uploadingRef, get uploading() { return uploading; }, get error() { return error; } };
}

function sizedImageFile(name: string, size: number) {
    const file = new File(["image"], name, { type: "image/png" });
    Object.defineProperty(file, "size", { value: size });
    return file;
}

test.each([0, 1])("config reference uploads reject the whole selection before storage when oversized image is at index %s", async index => {
    const h = uploadHarness();
    const files = [sizedImageFile("valid.png", 100), sizedImageFile("too-large.png", CANVAS_IMAGE_MAX_BYTES + 1)];
    if (index === 0) files.reverse();
    await expect(h.addFiles(files)).resolves.toBeUndefined();
    expect(h.uploads).toHaveLength(0);
    expect(h.patches).toHaveLength(0);
    expect(h.references).toEqual(h.original);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).toContain("too-large.png");
    expect(h.messages[0]).toContain("超过 20 MB");
    expect(h.error).toBe(h.messages[0]);
    expect(h.uploading).toBe(false);
    expect(h.uploadingRef.current).toBe(false);
});

test("config reference uploads accept the exact 20 MiB limit unchanged and retain existing references", async () => {
    const h = uploadHarness();
    const file = sizedImageFile("boundary.png", CANVAS_IMAGE_MAX_BYTES);
    await h.addFiles([file]);
    expect(h.uploads).toEqual([file]);
    expect(h.uploads[0]).toBe(file);
    expect(h.patches).toHaveLength(1);
    expect(h.patches[0]?.manualImageReferences?.map(item => item.name)).toEqual(["existing.png", "boundary.png"]);
    expect(h.messages).toHaveLength(0);
    expect(h.error).toBe("");
    expect(h.uploadingRef.current).toBe(false);
});

test("config reference input clears rejected selections and permits choosing the same file again", async () => {
    const h = uploadHarness();
    const file = sizedImageFile("repeat.png", CANVAS_IMAGE_MAX_BYTES + 1);
    for (let attempt = 0; attempt < 2; attempt++) {
        const target = { files: [file], value: "C:\\fakepath\\repeat.png" };
        h.onInputChange({ target });
        expect(target.value).toBe("");
    }
    expect(h.messages).toHaveLength(2);
    expect(h.uploads).toHaveLength(0);
    expect(h.patches).toHaveLength(0);
    await h.addFiles([sizedImageFile("repeat.png", CANVAS_IMAGE_MAX_BYTES)]);
    expect(h.uploads).toHaveLength(1);
    expect(h.patches).toHaveLength(1);
});

test("config reference storage failures are caught and shown without changing existing references", async () => {
    const h = uploadHarness(true);
    await expect(h.addFiles([sizedImageFile("valid.png", 100)])).resolves.toBeUndefined();
    expect(h.messages).toEqual(["测试存储失败"]);
    expect(h.error).toBe("测试存储失败");
    expect(h.patches).toHaveLength(0);
    expect(h.references).toEqual(h.original);
    expect(h.uploading).toBe(false);
    expect(h.uploadingRef.current).toBe(false);
});
