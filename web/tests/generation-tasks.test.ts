import { describe, expect, test } from "bun:test";

import { createImageTaskRequests, createQueuedMediaTaskPayloads, restoreBatchItemIndices } from "../src/services/api/generation-tasks";
import { imageTaskParameters } from "../src/services/api/image";

describe("canvas batch item mapping", () => {
    test("uses the identical request id and source payload for video preflight and submit", () => {
        expect(createQueuedMediaTaskPayloads({
            requestId: "video-request",
            projectId: "canvas-1",
            operationType: "video_generation",
            modelConfigId: "video-model",
            prompt: "make the dress move",
            parameters: { seconds: 5, size: "9:16" },
            sourceUrls: ["/api/assets/image-1/content"],
        })).toEqual([
            {
                requestId: "video-request",
                projectId: "canvas-1",
                operationType: "video_generation",
                modelConfigId: "video-model",
                prompt: "make the dress move",
                parameters: { seconds: 5, size: "9:16" },
                sourceUrls: ["/api/assets/image-1/content"],
                priority: "normal",
            },
            {
                requestId: "video-request",
                projectId: "canvas-1",
                operationType: "video_generation",
                modelConfigId: "video-model",
                prompt: "make the dress move",
                parameters: { seconds: 5, size: "9:16" },
                sourceUrls: ["/api/assets/image-1/content"],
                priority: "normal",
            },
        ]);
    });

    test("submits every multi-image request through the supported single-task endpoint", () => {
        expect(createImageTaskRequests({
            requestId: "agent-request",
            projectId: "canvas-1",
            operationType: "image_generation",
            modelConfigId: "model-1",
            prompt: "a product photo",
            parameters: { size: "1:1", count: 3 },
            sourceUrls: [],
            count: 3,
        })).toEqual([
            {
                requestId: "agent-request:0",
                projectId: "canvas-1",
                operationType: "image_generation",
                modelConfigId: "model-1",
                prompt: "a product photo",
                parameters: { size: "1:1", count: 1 },
                sourceUrls: [],
                priority: "normal",
            },
            {
                requestId: "agent-request:1",
                projectId: "canvas-1",
                operationType: "image_generation",
                modelConfigId: "model-1",
                prompt: "a product photo",
                parameters: { size: "1:1", count: 1 },
                sourceUrls: [],
                priority: "normal",
            },
            {
                requestId: "agent-request:2",
                projectId: "canvas-1",
                operationType: "image_generation",
                modelConfigId: "model-1",
                prompt: "a product photo",
                parameters: { size: "1:1", count: 1 },
                sourceUrls: [],
                priority: "normal",
            },
        ]);
    });

    test("maps image sizes to GPT-Image-2 ratios and resolutions", () => {
        expect(imageTaskParameters({ size: "2048x1152" } as never)).toEqual({ size: "16:9", resolution: "2k" });
        expect(imageTaskParameters({ size: "2160x3840" } as never)).toEqual({ size: "9:16", resolution: "4k" });
        expect(imageTaskParameters({ size: "auto" } as never)).toEqual({ size: "auto", resolution: "1k" });
    });

    test("keeps original file positions after an earlier upload fails", () => {
        const result = restoreBatchItemIndices(
            [{ itemIndex: 0 }, { itemIndex: 2 }, { itemIndex: 3 }],
            [
                { id: "task-a", itemIndex: 0 },
                { id: "task-c", itemIndex: 1 },
            ],
            [{ index: 2, reason: "任务创建失败" }],
        );

        expect(result.tasks).toEqual([
            { id: "task-a", itemIndex: 0 },
            { id: "task-c", itemIndex: 2 },
        ]);
        expect(result.failures).toEqual([{ index: 3, reason: "任务创建失败" }]);
    });
});
