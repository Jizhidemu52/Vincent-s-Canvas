import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { fingerprintImage } from "@/services/api/generation-history";
import { compositeOperationId } from "@/services/api/local-processing";
import { historyAssetPath } from "@/services/api/generation-task-history";
import { createSceneForm, cloneSceneForm } from "@/pages/creative/scene-form-model";
import { imageMarkupReference, readImageOptions } from "@/lib/image-advanced-settings";
import { localProcessingParametersSchema } from "../../shared/local-processing-contracts";
import type * as Archive from "@/pages/creative/scene-final-archive";
import type { SceneImage, SceneResult, storeSceneResult as StoreSceneResult } from "@/pages/creative/use-scene-workspace";

const owner = "00000000-0000-4000-8000-000000000099", originalId = "10000000-0000-4000-8000-000000000001", maskId = "10000000-0000-4000-8000-000000000002";
const rawId = "10000000-0000-4000-8000-000000000003", finalId = "10000000-0000-4000-8000-000000000004", taskId = "20000000-0000-4000-8000-000000000001";
const originalBlob = new Blob(["original exact pixels"], { type: "image/png" }), maskBlob = new Blob(["selection alpha"], { type: "image/png" }), finalBlob = new Blob(["actual composite pixels"], { type: "image/png" });
const picture = (id: string): SceneImage => ({ id, sourceAssetId: id, name: `${id}.png`, storageKey: `image:${id}`, dataUrl: `/api/assets/${id}/content`, mimeType: "image/png", type: "image/png", width: 20, height: 20, bytes: 20 });
const config = { model: "model", imageModel: "model", size: "auto", quality: "auto", count: "1" }, form = createSceneForm("local-restyle");

function exportsFrom(path: string, bindings: Record<string, unknown>, selected?: string[]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8"), ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const body = ast.statements.filter(item => !ts.isImportDeclaration(item) && (!selected || ts.isFunctionDeclaration(item) && selected.includes(item.name?.text || ""))).map(item => item.getText(ast)).join("\n");
    const code = ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
    const exported = {};
    new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exported);
    return exported;
}

function archiveHarness(options: { cacheFails?: boolean; mappingFails?: boolean } = {}) {
    const archives: Array<{ file: File; input: any; ownerId: string }> = [], uploads: any[] = [], cloudReads: string[] = [];
    let currentOwner = owner;
    const bindings = {
        fingerprintImage, historyAssetPath, compositeOperationId, cloneSceneForm, imageMarkupReference, readImageOptions, localProcessingParametersSchema,
        assertHistoryOwner: (id: string) => { if (id !== currentOwner) throw new Error("员工会话已变化"); },
        getImageBlob: async (key: string) => { if (options.cacheFails) throw new Error("QuotaExceededError"); return key.endsWith(maskId) ? maskBlob : key.endsWith(finalId) ? finalBlob : originalBlob; },
        readHistoryOriginal: async (path: string) => { cloudReads.push(path); return path.includes(maskId) ? maskBlob : path.includes(finalId) ? finalBlob : originalBlob; },
        uploadImageReference: async (image: SceneImage, file: File, hash: string, ownerId: string) => { uploads.push({ image, file, hash, ownerId }); return image.sourceAssetId || image.id; },
        archiveLocalProcessing: async (file: File, input: any, ownerId: string) => { archives.push({ file, input, ownerId }); return { outputAssetId: finalId, contentUrl: `/api/assets/${finalId}/content` }; },
        serverMediaId: (path: string) => path.match(/^\/api\/assets\/([^/]+)\/content$/)?.[1] || "",
        rememberMediaSource: async () => { if (options.mappingFails) throw new Error("QuotaExceededError"); },
        rememberUploadedMedia: async () => { if (options.mappingFails) throw new Error("QuotaExceededError"); },
    };
    const api = exportsFrom("../src/pages/creative/scene-final-archive.ts", bindings) as typeof Archive;
    return { api, archives, uploads, cloudReads, changeOwner: () => { currentOwner = "other"; } };
}

test("composite archive uses final bytes and records original, alpha mask and immutable raw task result", async () => {
    const h = archiveHarness(), save = h.api.selectionFinalSave(taskId, picture(rawId));
    const result = await h.api.saveSceneFinalImage({ final: picture(finalId), finalBlob, original: picture(originalId), mask: picture(maskId), raw: picture(rawId), taskId,
        prompt: "原任务完整要求", form, config, save, ownerId: owner });
    expect(await h.archives[0].file.text()).toBe(await finalBlob.text());
    expect(h.archives[0].input).toMatchObject({ board: "creative-local-restyle", operation: "selection-composite", sourceTaskId: taskId, sourceAssetIds: [originalId, maskId, rawId],
        parameters: { selection: { sourceAssetId: originalId, maskAssetId: maskId }, form, config } });
    expect(h.uploads.map(item => item.image.id)).toEqual([originalId, maskId]);
    expect(result.image).toMatchObject({ sourceAssetId: finalId, dataUrl: `/api/assets/${finalId}/content` });
    expect(picture(rawId).sourceAssetId).toBe(rawId);
});

test("recolor archives exact structured mappings without inventing an AI task or serializing private settings", async () => {
    const h = archiveHarness(), recolor = { rules: [{ from: "#112233", to: "#AABBCC" }], tolerance: 8 };
    await h.api.saveSceneFinalImage({ final: picture(finalId), finalBlob, original: picture(originalId), prompt: "精确换色", form,
        config: { ...config, imageOptions: '{"resolution":"2k","output_format":"gif","frame_count":"9","frame_duration_ms":"200","metadata":"{\\"collection\\":\\"spring\\"}"}', systemPrompt: "private instruction" } as any,
        save: { operation: "recolor", clientOperationId: crypto.randomUUID(), recolor }, ownerId: owner });
    expect(h.archives[0].input).toMatchObject({ board: "creative-pattern-colorway", operation: "recolor", sourceAssetIds: [originalId], parameters: { recolor } });
    expect(h.archives[0].input).not.toHaveProperty("sourceTaskId");
    expect(JSON.stringify(h.archives[0].input)).not.toContain("private");
    expect(h.archives[0].input.parameters.config.imageOptions).toEqual({ resolution: "2k", output_format: "gif", frame_count: "9", frame_duration_ms: "200", metadata: { collection: "spring" } });
});

test("markup keeps only an authorized cloud source identity and participates in source ownership validation", async () => {
    const h = archiveHarness(), markup = { ...picture(maskId), name: "markup.png", dataUrl: "blob:local-markup", storageKey: `image:${maskId}` };
    await h.api.saveSceneFinalImage({ final: picture(finalId), finalBlob, original: picture(originalId), prompt: "精确换色", form,
        config: { ...config, imageOptions: JSON.stringify({ complexity: "high", markup_reference: JSON.stringify(markup) }) },
        save: { operation: "recolor", clientOperationId: crypto.randomUUID(), recolor: { rules: [{ from: "#000000", to: "#FFFFFF" }], tolerance: 0 } }, ownerId: owner });
    expect(h.archives[0].input.sourceAssetIds).toEqual([originalId, maskId]);
    expect(h.archives[0].input.parameters.config.imageOptions).toEqual({ complexity: "high", markup_reference: { sourceAssetId: maskId, name: "markup.png", type: "image/png", width: 20, height: 20, bytes: 20 } });
    expect(h.uploads.map(item => item.image.id)).toEqual([maskId, originalId]);
    expect(JSON.stringify(h.archives[0].input)).not.toMatch(/storageKey|dataUrl|blob:/);
});

test("advanced parameters reject credentials and local addresses even inside JSON-encoded metadata", async () => {
    for (const imageOptions of [
        { storageKey: "private" }, { metadata: '{"api_key":"private"}' }, { metadata: '{"nested":"{\\"authorization\\":\\"private\\"}"}' },
        { metadata: '{"preview":"blob:local"}' }, { metadata: '{"preview":"  file:///C:/private.png"}' },
        { cref: "http://127.0.0.1:3000/private.png" }, { sref: "http://user:private@example.test/image.png" }, { metadata: "{invalid" },
    ]) {
        const h = archiveHarness();
        await expect(h.api.saveSceneFinalImage({ final: picture(finalId), finalBlob, original: picture(originalId), prompt: "精确换色", form,
            config: { ...config, imageOptions: JSON.stringify(imageOptions) },
            save: { operation: "recolor", clientOperationId: crypto.randomUUID(), recolor: { rules: [{ from: "#000000", to: "#FFFFFF" }], tolerance: 0 } }, ownerId: owner })).rejects.toThrow();
        expect(h.archives).toHaveLength(0); expect(h.uploads).toHaveLength(0);
    }
});

test("a full local cache does not prevent immutable source capture or successful final cloud output", async () => {
    const h = archiveHarness({ cacheFails: true, mappingFails: true });
    const frozen = await h.api.freezeSceneSource(picture(originalId), owner);
    expect(frozen).toMatchObject({ inputSha256: await fingerprintImage(originalBlob), sourceAssetId: originalId, storageKey: undefined, dataUrl: `/api/assets/${originalId}/content` });
    const result = await h.api.saveSceneFinalImage({ final: picture(finalId), finalBlob, original: frozen, prompt: "精确换色", form, config,
        save: { operation: "recolor", clientOperationId: crypto.randomUUID(), recolor: { rules: [{ from: "#000000", to: "#FFFFFF" }], tolerance: 0 } }, ownerId: owner });
    expect(result.image.dataUrl).toBe(`/api/assets/${finalId}/content`);
    expect(h.cloudReads.length).toBeGreaterThan(0);
});

test("changed frozen bytes and an obsolete account cannot archive a final result", async () => {
    const h = archiveHarness();
    await expect(h.api.readSceneImageBlob({ ...picture(originalId), inputSha256: "wrong-hash" }, owner)).rejects.toThrow("输入字节不一致");
    h.changeOwner();
    await expect(h.api.freezeSceneSource(picture(originalId), owner)).rejects.toThrow("员工会话已变化");
    expect(h.archives).toEqual([]); expect(h.uploads).toEqual([]);
});

function resultHarness(options: { archiveFails?: boolean; cacheFails?: boolean; hold?: Promise<void> } = {}) {
    const savedInputs: any[] = [];
    const bindings = {
        canvasImageReferenceIdentity: () => ({}), serverMediaId: (path: string) => path.match(/^\/api\/assets\/([^/]+)\/content$/)?.[1] || "",
        uploadImage: async (input: string | Blob) => { if (options.cacheFails && input instanceof Blob) throw new Error("QuotaExceededError"); return { storageKey: "image:temporary", url: "blob:cached", mimeType: "image/png", bytes: 20, width: 20, height: 20 }; },
        readImageMeta: async () => ({ width: 20, height: 20, mimeType: "image/png" }), getDataUrlByteSize: () => 20,
        compositeSelectedImage: async () => finalBlob,
        selectionFinalSave: (task: string, raw: SceneImage) => { expect(raw.sourceAssetId).toBe(rawId); return { clientOperationId: compositeOperationId(task, raw.sourceAssetId!), operation: "selection-composite" }; },
        saveSceneFinalImage: async (input: any) => { savedInputs.push(input); await options.hold; if (options.archiveFails) throw new Error("storage unavailable"); return { image: { ...input.final, sourceAssetId: finalId, dataUrl: `/api/assets/${finalId}/content` }, record: { outputAssetId: finalId } }; },
        errorText: (error: unknown) => error instanceof Error ? error.message : "error", URL: { createObjectURL: () => "blob:uncached-final" },
    };
    const api = exportsFrom("../src/pages/creative/use-scene-workspace.ts", bindings, ["storeSceneResult"]) as { storeSceneResult: typeof StoreSceneResult };
    const run = (item: SceneResult = { id: "result", taskId, status: "pending" }) => api.storeSceneResult(item, { id: "generated", dataUrl: `/api/assets/${rawId}/content`, sourceTaskId: taskId, durationMs: 1, prompt: "完整要求", userInput: undefined, optimized: false },
        0, "local-restyle", { images: { primary: picture(originalId) }, selection: { sourceId: originalId, mask: picture(maskId) }, form, config }, () => {}, { ownerId: owner, prompt: "完整要求" });
    return { run, savedInputs };
}

test("the real result pipeline does not report success before cloud finalization resolves", async () => {
    let release!: () => void, finished = false;
    const h = resultHarness({ hold: new Promise<void>(resolve => { release = resolve; }) });
    const pending = h.run().then(result => { finished = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.savedInputs).toHaveLength(1); expect(finished).toBe(false);
    release(); const result = await pending;
    expect(result).toMatchObject({ status: "success", finalAssetId: finalId, image: { sourceAssetId: finalId } });
    expect(h.savedInputs[0].finalBlob).toBe(finalBlob);
});

test("cloud save failure preserves raw and final candidates and cannot become a paid retry", async () => {
    const h = resultHarness({ archiveFails: true }), result = await h.run();
    expect(result).toMatchObject({ status: "failed", failureKind: "local", taskId, uncompositedImage: { sourceAssetId: rawId }, pendingFinalImage: { dataUrl: "blob:cached" }, finalSave: { operation: "selection-composite" } });
    expect(result.image).toBeUndefined(); expect(result.error).toContain("原 AI 任务已成功"); expect(result.error).toContain("不会重新生成或扣费");
});

test("the composite still uploads exact final bytes when the optional local cache is full", async () => {
    const h = resultHarness({ cacheFails: true }), result = await h.run();
    expect(result.status).toBe("success");
    expect(h.savedInputs[0].final).toMatchObject({ dataUrl: "blob:uncached-final", storageKey: undefined, sourceAssetId: undefined });
    expect(h.savedInputs[0].finalBlob).toBe(finalBlob);
});

test("cache and cloud failures together retain the only in-memory final image for a save-only retry", async () => {
    const h = resultHarness({ cacheFails: true, archiveFails: true }), result = await h.run();
    expect(result).toMatchObject({ status: "failed", failureKind: "local", pendingFinalImage: { dataUrl: "blob:uncached-final", storageKey: undefined }, finalSave: { operation: "selection-composite" } });
    expect(result.uncompositedImage?.sourceAssetId).toBe(rawId);
});
