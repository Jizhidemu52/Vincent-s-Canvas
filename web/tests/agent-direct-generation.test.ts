import { expect, test } from "bun:test";

import {
    buildAgentGeneratedMediaOps,
    buildAgentGenerationPlan,
    buildAgentGenerationBrief,
    buildAgentVideoPrompt,
    buildAgentReferenceImageContent,
    createAgentVideoConfirmation,
    normalizeAgentVideoSettings,
    normalizeAgentImageSettings,
    resolveAgentGeneratedMediaPosition,
    selectAgentVideoReferences,
    type AgentGenerationSettings,
} from "../src/lib/agent-direct-generation";
import { CanvasNodeType } from "../src/types/canvas";

const imageSettings = (imageModel = "vcen-gpt2"): AgentGenerationSettings => ({ mode: "image", imageModel, videoModel: "wan2.7", size: "3:4", quality: "2k", imageCount: "7", videoSeconds: "5", videoQuality: "1080P", afterImage: "images_only" });

test("Agent image requests and brief retain all seven requested outputs when the model supports them", () => {
    expect(buildAgentGenerationPlan(imageSettings(), "红色花瓶", [])).toMatchObject({ size: "3:4", quality: "2k", count: 7, requiresPrompt: true });
    expect(buildAgentGenerationBrief(imageSettings(), "红色花瓶", false)).toContain("数量：7");
    expect(normalizeAgentImageSettings({ ...imageSettings(), imageCount: "20" }).imageCount).toBe("10");
});

test("Agent uses actual standard, Gemini and Midjourney parameter profiles", () => {
    expect(normalizeAgentImageSettings(imageSettings("gpt-image-2"))).toMatchObject({ size: "1024x1024", quality: "auto", imageCount: "7" });
    expect(normalizeAgentImageSettings({ ...imageSettings("nano-banana-2"), quality: "0.5k" })).toMatchObject({ size: "3:4", quality: "0.5k", imageCount: "7" });
    expect(normalizeAgentImageSettings(imageSettings("midjourney-v7"))).toMatchObject({ size: "3:4", quality: "relax", imageCount: "1" });
});

test("Midjourney references are validated before any image generation", () => {
    expect(buildAgentGenerationPlan(imageSettings("midjourney-v7"), "海报", [{ id: "reference" }])).toMatchObject({ kind: "image", requiresPrompt: true });
    expect(() => buildAgentGenerationPlan(imageSettings("midjourney-blend"), "", [{ id: "reference" }])).toThrow("2 至 4");
    expect(() => buildAgentGenerationPlan(imageSettings("midjourney-blend"), "", Array.from({ length: 5 }, (_, id) => ({ id: String(id) })))).toThrow("2 至 4");
    expect(buildAgentGenerationPlan(imageSettings("midjourney-blend"), "", [{ id: "one" }, { id: "two" }])).toMatchObject({ count: 1, quality: "relax", requiresPrompt: false });
});

test("Seedance intelligent duration is retained by the Agent video controls", () => {
    expect(normalizeAgentVideoSettings({ ...imageSettings(), mode: "video", videoModel: "doubao-seedance-2.5", videoSeconds: "-1" }, { seconds: [4, 30], resolutions: ["480p", "720p"], sizes: ["adaptive", "16:9"], supportsAudio: true }).videoSeconds).toBe("-1");
});

test("keeps the optimized video prompt without injecting an unrelated garment preset", () => {
    const prompt = "只将红色花瓶变蓝，雏菊轻微摆动。";
    expect(buildAgentVideoPrompt(prompt, true)).toBe(prompt);
    expect(buildAgentVideoPrompt(prompt, false)).toBe(prompt);
});

test("converts Agent reference images to data URLs before a multimodal chat request", async () => {
    const references = [{ id: "dress", dataUrl: "blob:canvas-dress" }];
    const content = await buildAgentReferenceImageContent(references, async (reference) =>
        reference.dataUrl === "blob:canvas-dress" ? "data:image/png;base64,aW1hZ2U=" : "",
    );

    expect(content).toEqual([
        { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
    ]);
});

test("keeps all MiniMax H3 references and rejects excess images instead of dropping them", () => {
    const references = [{ id: "garment" }, { id: "model" }];

    expect(selectAgentVideoReferences("MiniMax-H3", references)).toEqual(references);
    expect(selectAgentVideoReferences("doubao-seedance-2.5", references)).toEqual(references);
    expect(() => selectAgentVideoReferences("MiniMax-H3", Array.from({ length: 10 }, (_, id) => ({ id: String(id) })))).toThrow("最多支持 9 张");
});

test("creates a video confirmation from the image the user selected", () => {
    const confirmation = createAgentVideoConfirmation(
        { id: "image-3", name: "生成图片 3", url: "data:image/png;base64,abc", mediaType: "image" },
        { mode: "video", imageModel: "gpt-image-2", videoModel: "happyhorse-1.1", size: "16:9", quality: "2k", imageCount: "3", videoSeconds: "5", videoQuality: "1080P", afterImage: "select_then_video" },
        "让模特自然向前走",
    );

    expect(confirmation.selectedImage.id).toBe("image-3");
    expect(confirmation.prompt).toContain("让模特自然向前走");
});

test("normalizes invalid video controls when the selected model changes", () => {
    expect(
        normalizeAgentVideoSettings(
            { mode: "video", imageModel: "gpt-image-2", videoModel: "happyhorse-1.1", size: "auto", quality: "2k", imageCount: "3", videoSeconds: "20", videoQuality: "2K", afterImage: "select_then_video" },
            { seconds: [3, 15], resolutions: ["720P", "1080P"], sizes: ["16:9", "9:16"] },
        ),
    ).toMatchObject({ videoSeconds: "15", videoQuality: "1080P", size: "16:9" });
});

test("turns Agent image and video results into visible canvas media nodes", () => {
    const ops = buildAgentGeneratedMediaOps(
        [
            { id: "image-result", name: "生成图片 1", url: "data:image/png;base64,abc", mediaType: "image" },
            { id: "video-result", name: "生成视频", url: "https://cdn.example.com/result.mp4", mediaType: "video" },
        ],
        { prompt: "让模特展示这条裙子", model: "gpt-image-2", x: 480, y: 120 },
    );

    expect(ops).toEqual([
        {
            type: "add_node",
            id: "image-result",
            nodeType: CanvasNodeType.Image,
            title: "生成图片 1",
            position: { x: 480, y: 120 },
            metadata: { content: "data:image/png;base64,abc", prompt: "让模特展示这条裙子", model: "gpt-image-2", status: "success", mimeType: "image/png" },
        },
        {
            type: "add_node",
            id: "video-result",
            nodeType: CanvasNodeType.Video,
            title: "生成视频",
            position: { x: 860, y: 120 },
            metadata: { content: "https://cdn.example.com/result.mp4", prompt: "让模特展示这条裙子", model: "gpt-image-2", status: "success", mimeType: "video/mp4" },
        },
        { type: "select_nodes", ids: ["image-result", "video-result"] },
    ]);
});

test("video audio is only enabled for models that actually support it", () => {
    const settings = { mode: "video" as const, imageModel: "gpt-image-2", videoModel: "wan2.7", size: "16:9", quality: "1k", imageCount: "1", videoSeconds: "5", videoQuality: "720P", videoGenerateAudio: "true", afterImage: "images_only" as const };
    const capability = { seconds: [3, 15] as const, resolutions: ["720P"], sizes: ["16:9"] };
    expect(normalizeAgentVideoSettings(settings, capability).videoGenerateAudio).toBe("false");
    expect(normalizeAgentVideoSettings(settings, { ...capability, supportsAudio: true }).videoGenerateAudio).toBe("true");
});

test("keeps Agent media storage keys on the canvas node for reload-safe previews", () => {
    const [operation] = buildAgentGeneratedMediaOps(
        [{ id: "stored-image", name: "stored", url: "blob:local-image", storageKey: "image:durable", mediaType: "image" }],
        { prompt: "durable media", model: "gpt-image-2", x: 0, y: 0 },
    );

    expect(operation).toMatchObject({
        type: "add_node",
        metadata: { content: "blob:local-image", storageKey: "image:durable", mimeType: "image/png" },
    });
});

test("fits Agent media nodes to the real square and portrait image dimensions", () => {
    const ops = buildAgentGeneratedMediaOps(
        [
            { id: "square", name: "square", url: "blob:square", mediaType: "image", width: 1024, height: 1024 },
            { id: "portrait", name: "portrait", url: "blob:portrait", mediaType: "image", width: 768, height: 1024 },
        ],
        { prompt: "vase", model: "gpt-image-2", x: 80, y: 120 },
    );
    expect(ops[0]).toMatchObject({ type: "add_node", width: 340, height: 340, position: { x: 80, y: 120 } });
    expect(ops[1]).toMatchObject({ type: "add_node", width: 255, height: 340, position: { x: 460, y: 120 } });
});

test("places Agent results beside the selected node so they remain in the working area", () => {
    expect(
        resolveAgentGeneratedMediaPosition({
            projectId: "project",
            title: "画布",
            nodes: [{ id: "dress", type: CanvasNodeType.Image, title: "裙子", position: { x: 100, y: 220 }, width: 340, height: 480 }],
            connections: [],
            selectedNodeIds: ["dress"],
            viewport: { x: -600, y: -400, k: 1 },
        }),
    ).toEqual({ x: 520, y: 220 });
});
