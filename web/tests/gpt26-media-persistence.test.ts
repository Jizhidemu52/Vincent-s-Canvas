import { afterEach, expect, test } from "bun:test";
import { createCanvasProjectsArchive } from "@/lib/canvas/canvas-export";
import { restoreCanvasExportMedia } from "@/lib/canvas/canvas-export-media";
import { portableCanvasMedia } from "@/lib/canvas/canvas-portable-media";
import { imageMarkupReference } from "@/lib/image-advanced-settings";
import { promptImageSettings } from "@/lib/prompt-editor-parameters";
import { fingerprintImage } from "@/services/api/generation-history";
import { hydratePromptReuse, type PromptReusePayload } from "@/services/api/prompts";
import { readZip } from "@/lib/zip";
import { CanvasNodeType } from "@/types/canvas";
import { decodeCanvasProject } from "@/lib/canvas/canvas-project-codec";
import { parseCanvasDocumentWrite } from "../../server/src/canvas-document";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasExportFile } from "@/types/canvas-export";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const assetId = "11111111-1111-4111-8111-111111111111";
const url = `/api/assets/${assetId}/content`;
const pngBytes = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64"));
const blob = new Blob([pngBytes], { type: "image/png" });
const markup = (local = false) => ({ id: "markup", name: "overlay.png", type: "image/png", bytes: blob.size, dataUrl: local ? "blob:old-device" : url, sourceAssetId: "former-owner", ...(local ? { storageKey: "image:original-markup" } : {}) });
const options = (local = false) => JSON.stringify({ complexity: "low", markup_reference: JSON.stringify(markup(local)) });
function project(local = false): CanvasProject {
    const nodes = [{ id: "draft-node", type: CanvasNodeType.Config, title: "Draft", position: { x: 10, y: 20 }, width: 400, height: 300, metadata: { prompt: "keep", imageOptions: options(local) } }];
    return { id: "markup-project", title: "Markup", createdAt: "2026-11-06T00:00:00.000Z", updatedAt: "2026-11-06T00:00:00.000Z", nodes, connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: true, viewport: { x: 0, y: 0, k: 1 },
        history: { past: [{ nodes, connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: true }], future: [] } } as CanvasProject;
}

test.each([false, true])("markup PNG bytes survive local=%s ZIP backup and restore separately from ordinary references", async local => {
    const source = project(local), before = JSON.stringify(source), reads: string[] = [];
    const zip = await createCanvasProjectsArchive([source], {
        getImageBlob: async key => { reads.push(key); return blob; },
        fetchBlob: async path => { reads.push(path); return blob; },
    });
    const entries = await readZip(zip);
    expect(entries.has("missing.txt")).toBe(false);
    const manifest = JSON.parse(await entries.get("projects.json")!.text()) as CanvasExportFile;
    expect(reads).toEqual([local ? "image:original-markup" : url]);
    expect(manifest.projects[0]!.files).toHaveLength(1);
    const file = manifest.projects[0]!.files[0]!;
    expect(new Uint8Array(await entries.get(file.path)!.arrayBuffer())).toEqual(pngBytes);
    const restored = decodeCanvasProject(restoreCanvasExportMedia(manifest.projects[0]!.project, new Map([[file.storageKey, "blob:new-device"]])));
    for (const node of [restored.nodes[0]!, restored.history!.past[0]!.nodes[0]!]) {
        const layer = imageMarkupReference(node.metadata.imageOptions);
        expect(layer).toMatchObject({ dataUrl: "blob:new-device", storageKey: file.storageKey, type: "image/png" });
        expect(layer).not.toHaveProperty("sourceAssetId");
        expect(node.metadata.references).toBeUndefined();
        expect(JSON.parse(node.metadata.imageOptions!).complexity).toBe("low");
    }
    expect(JSON.stringify(source)).toBe(before);
});

test("portable cloud markup resolves original storage once across undo and ignores prompt JSON", async () => {
    const source = project(true), calls: unknown[] = [];
    source.nodes[0]!.metadata.prompt = options(true);
    const before = JSON.stringify(source);
    const result = await portableCanvasMedia(source, async input => { calls.push(input); return url; });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ storageKey: "image:original-markup", url: "blob:old-device" });
    const layer = imageMarkupReference(result.nodes[0]!.metadata.imageOptions);
    expect(layer).toMatchObject({ dataUrl: url, type: "image/png" });
    expect(layer).not.toHaveProperty("storageKey");
    expect(layer).not.toHaveProperty("sourceAssetId");
    expect(result.nodes[0]!.metadata.prompt).toBe(options(true));
    expect(result.history!.past[0]!.nodes[0]!.metadata.imageOptions).toBe(result.nodes[0]!.metadata.imageOptions);
    expect(JSON.stringify(source)).toBe(before);
    expect(source.nodes[0]!.metadata.imageOptions).toBe(options(true));
    expect(parseCanvasDocumentWrite(source.id, { baseRevision: 0, document: result }).assetIds).toEqual([assetId]);
});

async function reusePayload(): Promise<PromptReusePayload> {
    const reference = { id: "original", name: "overlay.png", type: "image/png", bytes: blob.size, sha256: await fingerprintImage(blob), url };
    return { template: { id: "template", targetTool: "canvas", parameters: { complexity: "high", inputArchive: { version: 1, config: { imageOptions: "{}" }, markupReferenceIndex: 2, references: [reference, reference, reference] } }, referenceAssetIds: ["base-1", "base-2", assetId] },
        pricing: { selectedModel: { id: "gpt26", modelId: "gpt-image-2.6-flare", name: "GPT2.6" }, modelChanged: false }, mode: "fill", warnings: [] } as unknown as PromptReusePayload;
}

test("template hydrate separates markup without changing ordinary source order or archive roles", async () => {
    const payload = await reusePayload(), before = JSON.stringify(payload), calls: string[] = [];
    globalThis.fetch = (async input => { calls.push(String(input)); return String(input).includes("/reuse/") ? Response.json(payload) : new Response(blob); }) as typeof fetch;
    const restored = await hydratePromptReuse("once");
    expect(calls).toEqual(["/api/prompt-templates/reuse/once", url]);
    expect(restored.template.referenceAssetIds).toEqual(["base-1", "base-2"]);
    expect(restored.template.parameters.inputArchive).toEqual(payload.template.parameters.inputArchive);
    const settings = promptImageSettings(restored.template.parameters, "gpt-image-2.6-flare");
    expect(imageMarkupReference(settings.imageOptions)).toMatchObject({ dataUrl: url, sourceAssetId: assetId, type: "image/png", bytes: blob.size });
    expect(JSON.parse(settings.imageOptions).complexity).toBe("high");
    expect(JSON.stringify(payload)).toBe(before);
});

test("template markup refuses changed bytes, shifted indices and unsupported replacement models atomically", async () => {
    for (const failure of ["bytes", "index", "model"] as const) {
        const payload = await reusePayload();
        if (failure === "index") (payload.template.parameters.inputArchive as { markupReferenceIndex: number }).markupReferenceIndex = 0;
        if (failure === "model") payload.pricing.selectedModel!.modelId = "mai-image-2.6-flash";
        globalThis.fetch = (async input => String(input).includes("/reuse/") ? Response.json(payload) : new Response(new Blob(["changed"]))) as typeof fetch;
        await expect(hydratePromptReuse(failure)).rejects.toThrow(failure === "bytes" ? "原始 PNG 字节" : failure === "index" ? "顺序不完整" : "降级为普通参考图");
        expect(payload.template.referenceAssetIds).toHaveLength(3);
    }
});
