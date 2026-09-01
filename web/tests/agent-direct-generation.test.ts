import { expect, test } from "bun:test";

import {
    buildAgentGeneratedMediaOps,
    buildAgentReferenceImageContent,
    createAgentVideoConfirmation,
    normalizeAgentVideoSettings,
    resolveAgentGeneratedMediaPosition,
    selectAgentVideoReferences,
} from "../src/lib/agent-direct-generation";
import { CanvasNodeType } from "../src/types/canvas";

test("converts Agent reference images to data URLs before a multimodal chat request", async () => {
    const references = [{ id: "dress", dataUrl: "blob:canvas-dress" }];
    const content = await buildAgentReferenceImageContent(references, async (reference) =>
        reference.dataUrl === "blob:canvas-dress" ? "data:image/png;base64,aW1hZ2U=" : "",
    );

    expect(content).toEqual([
        { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
    ]);
});

test("uses only the first selected image for a MiniMax H3 Agent video", () => {
    const references = [{ id: "garment" }, { id: "model" }];

    expect(selectAgentVideoReferences("MiniMax-H3", references)).toEqual([{ id: "garment" }]);
    expect(selectAgentVideoReferences("doubao-seedance-2.5", references)).toEqual(references);
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
