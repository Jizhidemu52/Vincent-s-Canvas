import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoSettingsPanel } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { normalizeVideoModelConfig, videoModelRequestParameters } from "@/lib/video-model-parameters";
import { buildGenerationConfig } from "@/pages/canvas/canvas-project-utils";
import { snapshotVideoRequest } from "@/pages/video/video-retry";
import { createVideoGenerationTask, storeGeneratedVideo } from "@/services/api/video";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const config = { ...defaultConfig, model: "doubao-seedance-2.5", videoModel: "doubao-seedance-2.5", videoSeed: "0", videoOutputFormat: "mov" };

test("only documented video seed and output controls appear and values reach request parameters", () => {
    expect(videoModelRequestParameters(config)).toMatchObject({ seed: 0, outputFormat: "mov" });
    expect(videoModelRequestParameters({ ...config, videoSeed: "" })).not.toHaveProperty("seed");
    expect(videoModelRequestParameters({ ...config, videoSeed: "-1" }).seed).toBe(-1);
    const seedance = renderToStaticMarkup(<VideoSettingsPanel config={config} onConfigChange={() => {}} theme={canvasThemes.light} />);
    expect(seedance).toContain("视频输出格式"); expect(seedance).toContain("MOV"); expect(seedance).toContain("视频随机种子");
    const horse = { ...config, model: "happyhorse-1.1" };
    expect(normalizeVideoModelConfig(horse).videoOutputFormat).toBe("mp4");
    expect(videoModelRequestParameters(horse)).not.toHaveProperty("outputFormat");
    const html = renderToStaticMarkup(<VideoSettingsPanel config={horse} onConfigChange={() => {}} theme={canvasThemes.light} />);
    expect(html).toContain("视频随机种子"); expect(html).not.toContain("视频输出格式");
    expect(() => videoModelRequestParameters({ ...horse, videoSeed: "2147483648" })).toThrow("0–2147483647");
});

test("invalid seed stops before source uploads or task creation", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async input => {
        const url = String(input);
        if (url === "/api/models") return Response.json({ models: [{ id: "seedance", modelId: config.model, name: "Seedance", capabilities: ["video"], creditCost: 0, rmbCost: 0 }], tools: [], prices: [] });
        requests.push(url); throw new Error("No upload or submission expected");
    }) as typeof fetch;
    await expect(createVideoGenerationTask({ ...config, videoSeed: "1.5" }, "one video")).rejects.toThrow("整数");
    expect(requests).toEqual([]);
});

test("canvas saved metadata and immutable retry retain seed zero, cleared seed and MOV", () => {
    const node: CanvasNodeData = { id: "video", type: CanvasNodeType.Video, title: "clip", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { videoSeed: "0", videoOutputFormat: "mov" } };
    expect(buildGenerationConfig({ ...config, videoSeed: "42", videoOutputFormat: "mp4" }, node, "video")).toMatchObject({ videoSeed: "0", videoOutputFormat: "mov" });
    expect(buildGenerationConfig(config, { ...node, metadata: { ...node.metadata, videoSeed: "" } }, "video").videoSeed).toBe("");
    const saved = snapshotVideoRequest({ text: "one video", config: { ...config }, references: [], videoReferences: [], audioReferences: [] });
    const recovered = JSON.parse(JSON.stringify(saved));
    expect(recovered.config).toMatchObject({ videoSeed: "0", videoOutputFormat: "mov" });
});

test("stored MOV history uses original MIME and bytes while retaining the server preview identity", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]); let saved: Blob | undefined;
    const stored = await storeGeneratedVideo({ url: "/api/assets/10000000-0000-4000-8000-000000000001/content", mimeType: "video/mp4" }, {
        fetch: async () => new Response(bytes, { headers: { "content-type": "video/quicktime" } }),
        saveBlob: async blob => { saved = blob; return { url: "blob:original-mov", storageKey: "video-original", bytes: blob.size, mimeType: blob.type }; },
    });
    expect(saved?.type).toBe("video/quicktime");
    expect(new Uint8Array(await saved!.arrayBuffer())).toEqual(bytes);
    expect(stored).toMatchObject({ mimeType: "video/quicktime", storageKey: "video-original", serverAssetId: "10000000-0000-4000-8000-000000000001" });
});
