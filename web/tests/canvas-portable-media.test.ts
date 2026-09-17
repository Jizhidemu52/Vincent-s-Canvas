import { describe, expect, test } from "bun:test";
import { portableCanvasMedia, type PortableMediaResolver } from "@/lib/canvas/canvas-portable-media";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasProject, CanvasHistorySnapshot } from "@/stores/canvas/use-canvas-store";
import { parseCanvasDocumentWrite } from "../../server/src/canvas-document";

const timestamp = "2026-09-17T00:00:00.000Z";
const assetId = (index: number) => `b631dfe3-5dc6-44e6-8a13-${String(index).padStart(12, "0")}`;
const assetUrl = (index: number) => `/api/assets/${assetId(index)}/content`;
function node(id: string, type: CanvasNodeType, metadata: Record<string, unknown>): CanvasNodeData {
    return { id, type, title: id, position: { x: -12.25, y: 71.5 }, width: 1441, height: 2117, metadata };
}
function project(nodes: CanvasNodeData[] = []): CanvasProject {
    return { id: "portable-full-document", title: "完整原稿", createdAt: timestamp, updatedAt: timestamp, nodes, connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: true, viewport: { x: -12.5, y: 34.25, k: 0.375 } };
}
function captureResolver() {
    const calls: Parameters<PortableMediaResolver>[0][] = [];
    const resolve: PortableMediaResolver = async (input) => { calls.push(input); return assetUrl(calls.length); };
    return { calls, resolve };
}
function validate(value: CanvasProject) {
    const parsed = parseCanvasDocumentWrite(value.id, { baseRevision: 0, document: value });
    expect(parsed.document).toEqual(value);
    return parsed.assetIds;
}
function snapshot(nodes: CanvasNodeData[]): CanvasHistorySnapshot {
    return { nodes, connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false };
}

describe("portable whole-canvas media and server validator compatibility", () => {
    test("image, video and audio content retain graph geometry and pass server validation after conversion", async () => {
        const source = project([
            node("image", CanvasNodeType.Image, { content: "data:image/png;base64,AAECA/8=", mimeType: "image/png", originalFileName: "原图.png", naturalWidth: 1441, naturalHeight: 2117 }),
            node("video", CanvasNodeType.Video, { content: "blob:https://canvas.example/video", mimeType: "video/mp4", durationMs: 7812, fps: 29.97 }),
            node("audio", CanvasNodeType.Audio, { content: "data:audio/wav;base64,BAUGBw==", mimeType: "audio/wav" }),
        ]);
        source.connections = [{ id: "image-video", fromNodeId: "image", toNodeId: "video" }];
        const before = JSON.stringify(source), { calls, resolve } = captureResolver();
        const result = await portableCanvasMedia(source, resolve);
        expect(calls).toHaveLength(3);
        expect(result.nodes.map(item => item.metadata?.content)).toEqual([assetUrl(1), assetUrl(2), assetUrl(3)]);
        expect(result.nodes.map(({ metadata: _metadata, ...item }) => item)).toEqual(source.nodes.map(({ metadata: _metadata, ...item }) => item));
        expect(result.nodes[0]!.metadata).toMatchObject({ naturalWidth: 1441, naturalHeight: 2117, originalFileName: "原图.png" });
        expect(result.nodes[1]!.metadata).toMatchObject({ durationMs: 7812, fps: 29.97 });
        expect(result.connections).toEqual(source.connections);
        expect(result.viewport).toEqual(source.viewport);
        expect(JSON.stringify(source)).toBe(before);
        expect(validate(result).sort()).toEqual([assetId(1), assetId(2), assetId(3)].sort());
    });

    test("manual MIME-typed image references and string reference arrays are portable", async () => {
        const source = project([node("config", CanvasNodeType.Config, {
            manualImageReferences: [{ referenceKey: "manual:original", id: "reference-1", name: "原始参考图", type: "image/png", content: "blob:https://canvas.example/manual", storageKey: "image:manual", origin: "upload", originalFileName: "参考.png" }],
            references: ["data:image/png;base64,CQgHBg==", assetUrl(99)],
        })]);
        const { calls, resolve } = captureResolver();
        const result = await portableCanvasMedia(source, resolve);
        expect(result.nodes[0]!.metadata?.manualImageReferences?.[0]).toEqual({ referenceKey: "manual:original", id: "reference-1", name: "原始参考图", type: "image/png", content: assetUrl(1), origin: "upload", originalFileName: "参考.png" });
        expect(result.nodes[0]!.metadata?.references).toEqual([assetUrl(2), assetUrl(99)]);
        expect(calls).toHaveLength(2);
        expect(validate(result).sort()).toEqual([assetId(1), assetId(2), assetId(99)].sort());
    });

    test("chat references, attachments and nested media-workflow outputs share the same conversion", async () => {
        const source = project();
        source.chatSessions = [{ id: "chat", title: "讨论", createdAt: timestamp, updatedAt: timestamp, messages: [{
            id: "message", role: "assistant", text: "保留所有对话文字", references: [{ id: "reference", type: CanvasNodeType.Image, title: "参考", dataUrl: "blob:https://canvas.example/reference", storageKey: "image:reference" }],
            attachments: [{ id: "attachment", name: "设计.png", url: "data:image/png;base64,AQIDBA==", mediaType: "image", width: 1441, height: 2117 }],
            detail: { candidate: { url: "blob:https://canvas.example/candidate", storageKey: "media:video" } },
        }] }];
        source.activeChatId = "chat";
        const { resolve, calls } = captureResolver();
        const result = await portableCanvasMedia(source, resolve);
        const message = result.chatSessions[0]!.messages[0]!;
        expect(message.references?.[0]?.dataUrl).toBe(assetUrl(1));
        expect(message.attachments?.[0]).toMatchObject({ url: assetUrl(2), width: 1441, height: 2117 });
        expect(message.detail?.candidate).toEqual({ url: assetUrl(3) });
        expect(message.text).toBe("保留所有对话文字");
        expect(calls).toHaveLength(3);
        expect(validate(result)).toHaveLength(3);
    });

    test("undo and redo snapshots are converted and duplicate storage keys upload only once", async () => {
        const current = node("image", CanvasNodeType.Image, { content: "blob:https://canvas.example/current", storageKey: "image:immutable-original", mimeType: "image/png", originalFileName: "原图.png" });
        const source = project([current]);
        source.history = {
            past: [snapshot([node("previous", CanvasNodeType.Image, { content: "blob:https://canvas.example/past-url", storageKey: "image:immutable-original" })])],
            future: [snapshot([node("next", CanvasNodeType.Image, { content: "data:image/png;base64,AAECA/8=", storageKey: "image:immutable-original" })])],
        };
        const original = JSON.stringify(source), { calls, resolve } = captureResolver();
        const result = await portableCanvasMedia(source, resolve);
        expect(calls).toEqual([{ storageKey: "image:immutable-original", url: "blob:https://canvas.example/current", mimeType: "image/png", name: "原图.png" }]);
        expect(result.nodes[0]!.metadata?.content).toBe(assetUrl(1));
        expect(result.history?.past[0]?.nodes[0]?.metadata?.content).toBe(assetUrl(1));
        expect(result.history?.future[0]?.nodes[0]?.metadata?.content).toBe(assetUrl(1));
        expect(JSON.stringify(result)).not.toContain('"storageKey"');
        expect(JSON.stringify(source)).toBe(original);
        expect(validate(result)).toEqual([assetId(1)]);
    });

    test("prompt, text-node content and conversation text that mention URLs are never rewritten", async () => {
        const prompt = "data:image/png;base64,AQID and blob:https://example/notes are explanatory text";
        const source = project([
            node("text", CanvasNodeType.Text, { content: prompt, prompt, draftPrompt: prompt, composerContent: prompt }),
            node("image", CanvasNodeType.Image, { content: assetUrl(99), prompt, draftPrompt: prompt, composerContent: prompt }),
        ]);
        const { calls, resolve } = captureResolver();
        const result = await portableCanvasMedia(source, resolve);
        expect(result).toEqual(source);
        expect(calls).toEqual([]);
        expect(validate(result)).toEqual([assetId(99)]);
    });

    test("the resolver receives the original image byte source without decoding, resizing or re-encoding", async () => {
        const originalBytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255, 0, 3]);
        const originalDataUrl = `data:image/png;base64,${Buffer.from(originalBytes).toString("base64")}`;
        const source = project([node("image", CanvasNodeType.Image, { content: originalDataUrl, mimeType: "image/png", originalFileName: "原文件.png", bytes: originalBytes.byteLength })]);
        let calls = 0;
        const result = await portableCanvasMedia(source, async input => {
            calls++;
            expect(input).toEqual({ storageKey: undefined, url: originalDataUrl, mimeType: "image/png", name: "原文件.png" });
            expect(new Uint8Array(Buffer.from(input.url.split(",")[1]!, "base64"))).toEqual(originalBytes);
            return assetUrl(1);
        });
        expect(calls).toBe(1);
        expect(result.nodes[0]!.metadata?.bytes).toBe(originalBytes.byteLength);
        expect(source.nodes[0]!.metadata?.content).toBe(originalDataUrl);
        validate(result);
    });

    test("storage-key-only media is uploaded rather than silently losing its only file reference", async () => {
        const source = project([node("image", CanvasNodeType.Image, { storageKey: "image:only-original", mimeType: "image/png" })]);
        const { calls, resolve } = captureResolver();
        const result = await portableCanvasMedia(source, resolve);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ storageKey: "image:only-original", url: "" });
        expect(result.nodes[0]!.metadata?.content).toBe(assetUrl(1));
        expect(JSON.stringify(result)).not.toContain('"storageKey"');
        validate(result);
    });

    test("temporary HTTPS media is copied to durable server URLs while stable server links are kept", async () => {
        const temporary = "https://provider.example/generated.png?expires=1&signature=temporary";
        const source = project([node("image", CanvasNodeType.Image, { content: temporary, references: [assetUrl(99)] })]);
        const { calls, resolve } = captureResolver();
        const result = await portableCanvasMedia(source, resolve);
        expect(calls).toEqual([{ storageKey: undefined, url: temporary, mimeType: undefined, name: undefined }]);
        expect(result.nodes[0]!.metadata?.content).toBe(assetUrl(1));
        expect(result.nodes[0]!.metadata?.references).toEqual([assetUrl(99)]);
        validate(result);
    });

    test("storage-key strings in references use their original bytes rather than a relative URL", async () => {
        const source = project([node("config", CanvasNodeType.Config, { references: ["image:reference-original", "media:reference-video"] })]);
        const { calls, resolve } = captureResolver();
        const result = await portableCanvasMedia(source, resolve);
        expect(calls).toEqual([{ storageKey: "image:reference-original", url: "" }, { storageKey: "media:reference-video", url: "" }]);
        expect(result.nodes[0]!.metadata?.references).toEqual([assetUrl(1), assetUrl(2)]);
        validate(result);
    });

    test("a video's independent poster is not replaced with the primary video storage key", async () => {
        const source = project([node("video", CanvasNodeType.Video, {
            content: "blob:https://canvas.example/original-video", storageKey: "media:original-video", mimeType: "video/mp4",
            posterUrl: "data:image/png;base64,AQIDBA==",
        })]);
        const { calls, resolve } = captureResolver();
        const result = await portableCanvasMedia(source, resolve);
        expect(calls).toHaveLength(2);
        expect(calls[0]).toMatchObject({ storageKey: "media:original-video", url: "blob:https://canvas.example/original-video" });
        expect(calls[1]).toMatchObject({ url: "data:image/png;base64,AQIDBA==" });
        expect(calls[1]!.storageKey).toBeUndefined();
        expect(result.nodes[0]!.metadata?.content).toBe(assetUrl(1));
        expect((result.nodes[0]!.metadata as Record<string, unknown>).posterUrl).toBe(assetUrl(2));
        validate(result);
    });

    test("storage-key-only chat image references retain their consumer-facing dataUrl field", async () => {
        const source = project();
        source.chatSessions = [{ id: "chat", title: "讨论", createdAt: timestamp, updatedAt: timestamp, messages: [{
            id: "message", role: "user", text: "这张参考图", references: [{ id: "reference", type: CanvasNodeType.Image, title: "只有本地key", storageKey: "image:chat-reference" }],
        }] }];
        const { calls, resolve } = captureResolver();
        const result = await portableCanvasMedia(source, resolve);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ storageKey: "image:chat-reference", url: "" });
        expect(result.chatSessions[0]!.messages[0]!.references?.[0]?.dataUrl).toBe(assetUrl(1));
        expect(JSON.stringify(result)).not.toContain('"storageKey"');
        validate(result);
    });

    test.each(["posterUrl", "thumbnailUrl", "previewUrl", "imageUrl", "videoUrl", "audioUrl", "resultUrl", "downloadUrl"])("server-recognized %s media fields must not leave local URLs behind", async field => {
        const source = project([node("video", CanvasNodeType.Video, { content: assetUrl(99), [field]: "blob:https://canvas.example/local-preview" })]);
        const { resolve, calls } = captureResolver();
        const result = await portableCanvasMedia(source, resolve);
        expect(calls).toHaveLength(1);
        expect((result.nodes[0]!.metadata as Record<string, unknown>)[field]).toBe(assetUrl(1));
        expect(validate(result).sort()).toEqual([assetId(1), assetId(99)].sort());
    });
});
