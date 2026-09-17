import { describe, expect, test } from "bun:test";

import { createCanvasProjectsArchive } from "@/lib/canvas/canvas-export";
import { collectCanvasExportMedia, restoreCanvasExportMedia } from "@/lib/canvas/canvas-export-media";
import { readZip } from "@/lib/zip";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasExportFile } from "@/types/canvas-export";
import { CanvasNodeType } from "@/types/canvas";

const imageUrl = "/api/assets/11111111-1111-4111-8111-111111111111/content";
const videoUrl = "/api/assets/22222222-2222-4222-8222-222222222222/content";
const audioUrl = "/api/assets/33333333-3333-4333-8333-333333333333/content";
const posterUrl = "/api/assets/44444444-4444-4444-8444-444444444444/content";
const sourceBytes = new Uint8Array([0, 1, 254, 255, 67, 0, 89]);
const files = new Map([
    [imageUrl, new Blob([sourceBytes], { type: "image/png" })],
    [videoUrl, new Blob([new Uint8Array([10, 20, 30])], { type: "video/mp4" })],
    [audioUrl, new Blob([new Uint8Array([40, 50, 60])], { type: "audio/mpeg" })],
    [posterUrl, new Blob([new Uint8Array([70, 80, 90])], { type: "image/jpeg" })],
]);

function project(): CanvasProject {
    const nodes = [{ id: "image", type: CanvasNodeType.Image, title: "Image", width: 640, height: 320, position: { x: 20, y: 40 }, metadata: { content: imageUrl, references: [imageUrl], prompt: `Keep ${posterUrl} verbatim` } }];
    const chatSessions = [{ id: "chat", title: "conversation", createdAt: "", updatedAt: "", messages: [{ id: "message", role: "assistant", text: imageUrl, attachments: [{ id: "video", name: "video", mediaType: "video", url: videoUrl, posterUrl }, { id: "audio", name: "audio", mediaType: "audio", url: audioUrl }], references: [{ id: "ref", name: "reference", type: "image/png", dataUrl: imageUrl }] }] }];
    return { id: "cloud-project", title: "Restored", createdAt: "", updatedAt: "", nodes, connections: [], chatSessions, activeChatId: "chat", backgroundMode: "dots", showImageInfo: true, viewport: { x: 0, y: 0, k: 1 }, history: { past: [{ nodes, connections: [], chatSessions, activeChatId: "chat", backgroundMode: "dots", showImageInfo: true }], future: [] } } as CanvasProject;
}

describe("cloud canvas offline ZIP backup", () => {
    test("importing original bytes does not retain another employee's server authorization identifiers", () => {
        const restored = restoreCanvasExportMedia({ metadata: { storageKey: "image:archive-original", content: "canvas-archive:image:archive-original", serverAssetId: "old-employee-asset", assetId: "old-employee-asset" } }, new Map([["image:archive-original", "blob:new-browser"]]));
        expect(restored.metadata.content).toBe("blob:new-browser");
        expect(restored.metadata.serverAssetId).toBeUndefined();
        expect(restored.metadata.assetId).toBeUndefined();
    });
    test("a fresh device exports every cloud media byte once and restores without network", async () => {
        const original = project();
        const originalJson = JSON.stringify(original);
        const calls: string[] = [];
        const zip = await createCanvasProjectsArchive([original], {
            getImageBlob: async () => null, getMediaBlob: async () => null,
            fetchBlob: async path => { calls.push(path); return files.get(path)!; },
        });
        const entries = await readZip(zip);
        const manifest = JSON.parse(await entries.get("projects.json")!.text()) as CanvasExportFile;
        expect(calls.sort()).toEqual([...files.keys()].sort());
        expect(manifest.projects[0].files).toHaveLength(4);
        expect(JSON.stringify(original)).toBe(originalJson);
        const imported = new Map<string, Blob>();
        const urls = new Map<string, string>();
        // Same storage boundary as the existing importer: files[] becomes typed local Blobs.
        for (const file of manifest.projects[0].files) {
            const bytes = entries.get(file.path)!;
            imported.set(file.storageKey, bytes.slice(0, bytes.size, file.mimeType));
            urls.set(file.storageKey, `blob:offline/${file.storageKey}`);
        }
        const restored = restoreCanvasExportMedia(manifest.projects[0].project, urls);
        const imageKey = restored.nodes[0].metadata.storageKey!;
        expect(new Uint8Array(await imported.get(imageKey)!.arrayBuffer())).toEqual(sourceBytes);
        expect(imported.get(imageKey)!.type).toBe("image/png");
        expect(restored.nodes[0].metadata.content).toBe(`blob:offline/${imageKey}`);
        expect(restored.nodes[0].metadata.references).toEqual([imageKey]);
        expect(restored.nodes[0].position).toEqual({ x: 20, y: 40 });
        expect(restored.history?.past[0].nodes[0].metadata.storageKey).toBe(imageKey);
        const attachments = restored.chatSessions[0].messages[0].attachments!;
        expect(attachments[0].url.startsWith("blob:offline/video:")).toBe(true);
        expect((attachments[0] as unknown as { posterUrl: string }).posterUrl.startsWith("blob:offline/image:")).toBe(true);
        expect(attachments[1].url.startsWith("blob:offline/audio:")).toBe(true);
        expect(restored.nodes[0].metadata.prompt).toBe(`Keep ${posterUrl} verbatim`);
        expect(restored.chatSessions[0].messages[0].text).toBe(imageUrl);
    });

    test("deduplicates same-origin absolute and relative URLs across multiple projects", async () => {
        const first = project();
        first.chatSessions = [];
        first.history = undefined;
        const second = { ...first, id: "second", nodes: [{ ...first.nodes[0], metadata: { content: `https://canvas.example${imageUrl}` } }] };
        const calls: string[] = [];
        await createCanvasProjectsArchive([first, second], { origin: "https://canvas.example", fetchBlob: async path => { calls.push(path); return files.get(path)!; } });
        expect(calls).toEqual([imageUrl]);
    });

    test("never downloads prompt text, text-node contents, lookalike endpoints or cross-origin URLs", async () => {
        const document = { prompt: imageUrl, nodes: [{ type: "text", metadata: { content: imageUrl } }], url: `https://outside.example${imageUrl}`, other: { url: `${imageUrl}/extra` }, credentialUrl: { url: `https://user:password@canvas.example${imageUrl}` }, malformed: { url: "http://" } };
        const result = await collectCanvasExportMedia(document, { origin: "https://canvas.example", fetchBlob: async () => { throw new Error("must not fetch"); } });
        expect(result.document).toEqual(document);
        expect(result.blobs.size).toBe(0);
        expect(restoreCanvasExportMedia({ prompt: "canvas-archive:image:literal-text" }, new Map())).toEqual({ prompt: "canvas-archive:image:literal-text" });
    });

    test("existing local images and storage-key-only references still round trip unchanged", async () => {
        const original = project();
        original.history = undefined;
        original.chatSessions = [];
        original.nodes[0].metadata = { content: "blob:old", storageKey: "image:local", references: ["image:reference-only"] };
        const reads: string[] = [];
        const zip = await createCanvasProjectsArchive([original], {
            getImageBlob: async key => { reads.push(key); return files.get(imageUrl)!; },
            fetchBlob: async () => { throw new Error("local export must not fetch"); },
        });
        const entries = await readZip(zip);
        const manifest = JSON.parse(await entries.get("projects.json")!.text()) as CanvasExportFile;
        expect(reads.sort()).toEqual(["image:local", "image:reference-only"]);
        expect(manifest.projects[0].project).toEqual(original);
        expect(manifest.projects[0].files).toHaveLength(2);
        for (const file of manifest.projects[0].files) expect(new Uint8Array(await entries.get(file.path)!.arrayBuffer())).toEqual(sourceBytes);
    });

    test("a missing cloud download fails export instead of producing an incomplete ZIP", async () => {
        await expect(createCanvasProjectsArchive([project()], { fetchBlob: async () => { throw new Error("403 denied"); } })).rejects.toThrow("403 denied");
        expect(() => restoreCanvasExportMedia({ url: "canvas-archive:image:missing" }, new Map())).toThrow("缺少媒体文件");
    });
});
