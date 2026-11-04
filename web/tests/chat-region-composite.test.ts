import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { imageModelProfile } from "@/lib/image-model-settings";
import { validateImageReferences } from "@/lib/image-reference-policy";
import { selectionSizeMatches, compositeSelectedPixels } from "@/pages/creative/image-processing";
import { canvasMaskAdaptationPlan } from "@/lib/canvas/canvas-mask-adaptation";
import { canvasMaskEditImageSettings } from "@/components/canvas/canvas-node-mask-edit-dialog";
import { chatImageTaskSignature, duplicateChatImageTask } from "@/pages/chat/chat-image-tasks";
import { createChatBranch } from "@/pages/chat/chat-message-actions";
import { collectImageStorageKeys } from "@/services/image-storage";
import type { ChatRegionComposite } from "@/lib/image-agent/mask";
import type { PendingChatImageTask } from "@/services/api/chat-image-recovery";
import type { ChatSession } from "@/pages/chat/chat-types";

// Execute the actual preparation/restoration bodies without a browser, provider,
// storage writes or module-global mocks. Browser tests cover the real worker/PNG.
const path = new URL("../src/lib/image-agent/mask.ts", import.meta.url);
const ast = ts.createSourceFile("mask.ts", readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
const functions = ["prepareChatMask", "prepareChatRegionEdit", "restoreChatMaskResult"].map(name => {
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    if (!node) throw new Error(`Missing production function ${name}`);
    return node.getText(ast).replace(/^export /, "");
}).join("\n");
const code = ts.transpileModule(`${functions}\nreturn { prepareChatRegionEdit, restoreChatMaskResult };`, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }).outputText;
const source = { id: "base", name: "底图.png", dataUrl: "source", storageKey: "image:source", type: "image/png", width: 64, height: 64, bytes: 64 };
const selection = { imageId: "base", mask: { id: "native", name: "蒙版.png", type: "image/png", dataUrl: "native-mask", storageKey: "image:mask" }, selection: { id: "selection", name: "选区.png", type: "image/png", dataUrl: "selection", storageKey: "image:selection" } };
const region: ChatRegionComposite = { mode: "selection-composite", source: { imageId: "base", storageKey: "image:source", width: 64, height: 64 }, selection: { storageKey: "image:selection", width: 64, height: 64 } };
const config = { model: "fixture", imageModel: "fixture", size: "1:1", quality: "1k", count: "1", imageOptions: "" };

function harness(options: { native?: boolean; kind?: "gemini" | "grok-image"; missing?: string; wrongSize?: string; outputType?: string } = {}) {
    const calls: Array<{ kind: string; value?: unknown }> = [];
    const model = { id: "fixture", modelId: options.native ? "gpt-image-2" : "gemini-3.1-flash-image-preview-official", name: "fixture", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0, imageParameterProfile: options.native ? "standard" as const : options.kind || "gemini", imageSupportsMask: Boolean(options.native) };
    const profile = imageModelProfile(model.id, [model]);
    const bindings = {
        imageModelProfile: () => profile,
        IMAGE_AGENT_MAX_IMAGES: 5, validateImageReferences, selectionSizeMatches,
        async imageToDataUrl(image: { storageKey?: string; dataUrl?: string }) {
            const value = image.storageKey || image.dataUrl || ""; calls.push({ kind: "read", value });
            return value === options.missing ? "" : value;
        },
        async readCanvasMaskImageSize(url: string) { return { width: url === options.wrongSize ? 128 : 64, height: 64 }; },
        async uploadImage(input: string | Blob) { calls.push({ kind: "store", value: input }); return { storageKey: "image:guide", url: "guide", width: 64, height: 64, bytes: 64, mimeType: "image/png" }; },
        async createSelectionGuide(...args: string[]) { calls.push({ kind: "guide", value: args }); return new Blob(["guide"], { type: "image/png" }); },
        async compositeSelectedImage(...args: string[]) { calls.push({ kind: "composite", value: args }); return new Blob(["composited-pixels"], { type: options.outputType || "image/png" }); },
        async readFileAsDataUrl(file: File) { return `data:${file.type};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`; },
        canvasMaskAdaptationPlan, canvasMaskEditImageSettings,
        async adaptCanvasMaskInputs(...args: unknown[]) { calls.push({ kind: "adapt-native", value: args }); return { sourceDataUrl: "native-source", maskDataUrl: "native-mask" }; },
        async restoreCanvasMaskResult(...args: unknown[]) { calls.push({ kind: "restore-native", value: args }); return "native-result"; },
        CanvasNodeType: { Image: "image" },
    };
    const api = new Function(...Object.keys(bindings), code)(...Object.values(bindings)) as {
        prepareChatRegionEdit: typeof import("@/lib/image-agent/mask").prepareChatRegionEdit;
        restoreChatMaskResult: typeof import("@/lib/image-agent/mask").restoreChatMaskResult;
    };
    return { ...api, calls };
}

describe("standalone chat region preparation", () => {
    test("Nano keeps the real source first, appends a guide and never returns a native mask", async () => {
        const api = harness();
        const references = [structuredClone(source)];
        const snapshot = structuredClone(references);
        const result = await api.prepareChatRegionEdit(config as never, references, selection, () => {});
        expect(result.references[0]).toBe(references[0]);
        expect(result.references[1]).toMatchObject({ id: "selection-guide:selection", name: "蓝色选区示意.png", storageKey: "image:guide" });
        expect(result.mask).toBeUndefined(); expect(result.adaptation).toBeUndefined();
        expect(result.regionComposite).toEqual(region);
        expect(result.promptPrefix).toContain("输入图2"); expect(result.promptPrefix).toContain("不是配色或款式参考");
        expect(result.promptPrefix).not.toContain("透明区域");
        expect(references).toEqual(snapshot);
        expect(api.calls.find(call => call.kind === "guide")?.value).toEqual(["image:source", "image:selection"]);
        expect(api.calls.some(call => call.kind === "adapt-native")).toBe(false);
        expect([...collectImageStorageKeys({ regionComposite: result.regionComposite })].sort()).toEqual(["image:selection", "image:source"]);
    });
    test("native mask keeps its existing paired adaptation and restoration route", async () => {
        const api = harness({ native: true });
        const result = await api.prepareChatRegionEdit(config as never, [source], selection, () => {});
        expect(result.references).toHaveLength(1);
        expect(result.references[0]?.dataUrl).toBe("native-source");
        expect(result.mask?.dataUrl).toBe("native-mask");
        expect(result.adaptation).toMatchObject({ sourceStorageKey: "image:source", maskStorageKey: "image:mask", width: 1024, height: 1024 });
        expect(result.regionComposite).toBeUndefined();
        expect(result.promptPrefix).toContain("蒙版透明区域");
        expect(await api.restoreChatMaskResult({ requestId: "native", maskAdaptation: result.adaptation }, "raw")).toBe("native-result");
        expect(api.calls.some(call => call.kind === "guide" || call.kind === "composite")).toBe(false);
    });
    test.each([{ count: 5, kind: "gemini" as const, message: "最多 5 张" }, { count: 3, kind: "grok-image" as const, message: "计入参考图数量" }])("guide capacity is rejected before reads or preparation: $kind", async ({ count, kind, message }) => {
        const api = harness({ kind });
        const refs = Array.from({ length: count }, (_, index) => ({ ...source, id: index ? `reference-${index}` : "base" }));
        await expect(api.prepareChatRegionEdit(config as never, refs, selection, () => {})).rejects.toThrow(message);
        expect(api.calls).toEqual([]);
    });
    test.each([
        { patch: { ...selection, imageId: "another" }, message: "另一张图片" },
        { patch: { ...selection, selection: { ...selection.selection, storageKey: undefined } }, message: "尚未保存" },
    ])("invalid ownership/persistence is rejected before preparing", async ({ patch, message }) => {
        const api = harness();
        await expect(api.prepareChatRegionEdit(config as never, [source], patch, () => {})).rejects.toThrow(message);
        expect(api.calls).toEqual([]);
    });
    test.each([{ missing: "image:selection" }, { wrongSize: "image:selection" }])("missing or changed selection cannot fall back to full-image generation", async options => {
        const api = harness(options);
        await expect(api.prepareChatRegionEdit(config as never, [source], selection, () => {})).rejects.toThrow("尚未提交");
        expect(api.calls.some(call => call.kind === "guide" || call.kind === "store")).toBe(false);
    });
    test("an explicit incompatible output aspect is not silently overridden", async () => {
        const api = harness();
        await expect(api.prepareChatRegionEdit({ ...config, size: "16:9" } as never, [source], selection, () => {})).rejects.toThrow("相同比例");
        expect(api.calls.some(call => call.kind === "guide" || call.kind === "store")).toBe(false);
    });
});

describe("saved region result contract", () => {
    test("regenerate and edited branches retain a durable original selection, while incomplete historical region turns are blocked", () => {
        const savedSelection = { ...selection, selection: { ...selection.selection, dataUrl: "" }, mask: { ...selection.mask, dataUrl: "" } };
        const session: ChatSession = { id: "session", title: "选区", updatedAt: "now", messages: [
            { id: "user", role: "user", content: "改色", createdAt: "now", regionSelection: savedSelection },
            { id: "answer", parentMessageId: "user", role: "assistant", content: "已完成", createdAt: "now", generatedImages: [{ id: "result", dataUrl: "", regionComposite: region }] },
            { id: "later-user", role: "user", content: "继续讨论", createdAt: "now" },
            { id: "later-answer", parentMessageId: "later-user", role: "assistant", content: "可以", createdAt: "now" },
        ] };
        const durable = JSON.parse(JSON.stringify(session)) as ChatSession;
        for (const messageId of ["user", "answer"]) {
            const branch = createChatBranch(durable, messageId, "branch", "later");
            expect(branch.source.regionSelection).toEqual(savedSelection);
            expect(branch.session.messages).toEqual([]);
        }
        expect([...collectImageStorageKeys(durable.messages[0])].sort()).toEqual(["image:mask", "image:selection"]);
        delete durable.messages[0]!.regionSelection;
        for (const messageId of ["user", "answer"]) expect(() => createChatBranch(durable, messageId, "branch", "later")).toThrow("未重新调用模型");
        expect(createChatBranch(durable, "later-answer", "branch", "later").source.id).toBe("later-user");
        durable.messages[0]!.regionSelection = { ...savedSelection, mask: { ...savedSelection.mask, storageKey: undefined } };
        expect(() => createChatBranch(durable, "answer", "branch", "later")).toThrow("记录不完整");
    });
    test("live and JSON-restored tasks run the exact same PNG compositor against durable originals", async () => {
        const api = harness();
        const pending = { requestId: "one", regionComposite: region };
        const live = await api.restoreChatMaskResult(pending, "/api/assets/raw/content");
        const restored = await api.restoreChatMaskResult(JSON.parse(JSON.stringify(pending)), "/api/assets/raw/content");
        expect(live).toBe(restored); expect(live).toStartWith("data:image/png;base64,");
        expect(api.calls.filter(call => call.kind === "composite").map(call => call.value)).toEqual(Array(2).fill(["image:source", "/api/assets/raw/content", "image:selection"]));
    });
    test.each([{ missing: "image:source" }, { missing: "image:selection" }, { wrongSize: "image:source" }, { wrongSize: "image:selection" }])("missing or changed saved originals reject rather than return the provider image: %s", async options => {
        const api = harness(options);
        await expect(api.restoreChatMaskResult({ requestId: "one", regionComposite: region }, "raw")).rejects.toThrow("原任务");
        expect(api.calls.some(call => call.kind === "composite")).toBe(false);
    });
    test("corrupt/mixed mode and lossy output are never accepted as a protected result", async () => {
        for (const invalid of [{ ...region, mode: "unknown" }, { ...region, selection: { ...region.selection, width: 1 } }]) {
            const api = harness();
            await expect(api.restoreChatMaskResult({ requestId: "one", regionComposite: invalid as ChatRegionComposite }, "raw")).rejects.toThrow("记录");
            expect(api.calls).toEqual([]);
        }
        const api = harness({ outputType: "image/jpeg" });
        await expect(api.restoreChatMaskResult({ requestId: "one", regionComposite: region }, "raw")).rejects.toThrow("无损 PNG");
        await expect(api.restoreChatMaskResult({ requestId: "one", regionComposite: region, maskAdaptation: {} as never }, "raw")).rejects.toThrow("记录");
    });
    test("region mode and selection identity participate in deduplication, not a random guide identity", () => {
        const task: PendingChatImageTask = { requestId: "first", prompt: "改色", action: "edit", modelId: "nano", parentId: "base", referenceImageIds: ["base"], regionComposite: region };
        task.signature = chatImageTaskSignature(task);
        const session = { messages: [{ pendingImageTask: task }] } as never;
        expect(duplicateChatImageTask(session, { ...task, requestId: "second" })).toBeDefined();
        expect(chatImageTaskSignature(task)).toContain("selection-composite");
        const other = { ...task, signature: undefined, regionComposite: { ...region, selection: { ...region.selection, storageKey: "image:another-selection" } } };
        expect(duplicateChatImageTask(session, other)).toBeUndefined();
        expect(chatImageTaskSignature({ ...task, regionComposite: undefined })).not.toBe(task.signature);
    });
    test("the reused compositor copies every zero-coverage RGBA pixel, including transparency", () => {
        const original = { width: 3, height: 1, data: new Uint8ClampedArray([13, 21, 31, 255, 40, 51, 62, 128, 71, 82, 93, 0]) };
        const generated = { ...original, data: new Uint8ClampedArray([220, 0, 0, 255, 220, 0, 0, 255, 220, 0, 0, 255]) };
        const coverage = { ...original, data: new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0]) };
        const result = compositeSelectedPixels(original, generated, coverage);
        expect(Array.from(result.data)).toEqual([220, 0, 0, 255, 40, 51, 62, 128, 71, 82, 93, 0]);
        expect(Array.from(original.data)).toEqual([13, 21, 31, 255, 40, 51, 62, 128, 71, 82, 93, 0]);
    });
});
