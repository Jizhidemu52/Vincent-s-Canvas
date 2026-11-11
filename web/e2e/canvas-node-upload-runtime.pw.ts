import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, expect, newCanvas, IMAGE } from "./fixtures";

test("lazy single-node upload preserves image, video and audio bytes, identity and native sizing", async ({ page, api }) => {
    await newCanvas(page);
    const wav = Buffer.alloc(44 + 1600);
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
    const sources = [
        { kind: "image", type: "image/png", name: "original.png", bytes: Array.from(IMAGE) },
        { kind: "video", type: "video/mp4", name: "original.mp4", bytes: Array.from(await readFile(resolve(import.meta.dirname, "media/video.mp4"))) },
        { kind: "audio", type: "audio/wav", name: "original.wav", bytes: Array.from(wav) },
    ];
    const result = await page.evaluate(async sources => {
        const { prepareCanvasNodeUpload, createCanvasUploadedNode, selectCanvasUploadFiles } = await import("/src/pages/canvas/canvas-node-upload-runtime.ts");
        const { getImageBlob } = await import("/src/services/image-storage.ts");
        const { getMediaBlob } = await import("/src/services/file-storage.ts");
        const original = { id: "keep-node", type: "image", title: "before", position: { x: 100, y: 200 }, width: 300, height: 200, metadata: { status: "idle", prompt: "keep prompt", imageTask: { requestId: "old" }, errorDetails: "old-error" } };
        const before = JSON.stringify(original);
        const results = [];
        const allFiles = sources.map(source => new File([new Uint8Array(source.bytes)], source.name, { type: source.type }));
        const imageOnly = selectCanvasUploadFiles(allFiles, true);
        const mixed = selectCanvasUploadFiles([...allFiles, new File(["ignore"], "notes.txt", { type: "text/plain" })]);
        for (const source of sources) {
            const upload = await prepareCanvasNodeUpload(new File([new Uint8Array(source.bytes)], source.name, { type: source.type }), source.kind);
            const replacement = upload.replace(original);
            const blob = await (source.kind === "image" ? getImageBlob : getMediaBlob)(replacement.metadata.storageKey);
            const { node: created } = await createCanvasUploadedNode(new File([new Uint8Array(source.bytes)], source.name, { type: source.type }), source.kind, { x: 1000, y: 800 });
            results.push({ node: replacement, created, openDialog: upload.openDialog, largeImage: upload.largeImage, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) });
        }
        let oversizeError = "";
        try { await prepareCanvasNodeUpload(new File([new Uint8Array(20 * 1024 * 1024 + 1)], "too-large.png", { type: "image/png" }), "image"); }
        catch (error) { oversizeError = error instanceof Error ? error.message : String(error); }
        return { results, untouched: JSON.stringify(original) === before, oversizeError, imageOnly: { names: imageOnly.files.map(file => file.name), kind: imageOnly.kind, warning: imageOnly.warning }, mixed: { names: mixed.files.map(file => file.name), warning: mixed.warning } };
    }, sources);
    expect(result.untouched).toBe(true);
    expect(result.oversizeError).toContain("超过 20 MB");
    expect(result.imageOnly).toEqual({ names: ["original.png"], kind: "image", warning: "参考款原图仅支持图片，其他文件已跳过" });
    expect(result.mixed).toEqual({ names: ["original.png", "original.mp4", "original.wav"], warning: "仅支持图片、视频和音频，其他文件已跳过" });
    for (const [index, entry] of result.results.entries()) {
        expect(entry.bytes).toEqual(sources[index].bytes);
        expect(entry.node.id).toBe("keep-node");
        expect(entry.node.title).toBe(sources[index].name);
        expect(entry.node.type).toBe(sources[index].kind);
        expect(entry.node.metadata.prompt).toBe("keep prompt");
        expect(entry.node.metadata.errorDetails).toBeUndefined();
        expect(entry.node.metadata.bytes).toBe(sources[index].bytes.length);
        expect(entry.openDialog).toBe(sources[index].kind !== "audio");
        expect(entry.largeImage).toBe(false);
        expect(entry.created.id).toMatch(new RegExp(`^${sources[index].kind}-`));
        expect(entry.created.position).toEqual({ x: 1000 - entry.node.width / 2, y: 800 - entry.node.height / 2 });
        expect(entry.created.metadata.content).toMatch(/^blob:/);
    }
    expect(result.results[0].node).toMatchObject({ position: { x: 100, y: 200 }, width: 256, height: 256, metadata: { naturalWidth: 256, naturalHeight: 256 } });
    expect(result.results[0].node.metadata.imageTask).toBeUndefined();
    expect(result.results[1].node).toMatchObject({ position: { x: 170, y: 255 }, width: 160, height: 90, metadata: { naturalWidth: 160, naturalHeight: 90 } });
    expect(result.results[2].node).toMatchObject({ position: { x: 80, y: 240 }, width: 340, height: 120, metadata: { durationMs: 100 } });
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});
