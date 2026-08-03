import { expect, test } from "bun:test";

import { getCanvasAgentMediaWorkflowCardContract, getCanvasAgentMediaWorkflowCardState } from "../src/components/canvas/canvas-agent-media-workflow-card";
import { canGenerateWorkflowVideo, classifyAgentMediaIntent, createAgentMediaWorkflow, selectWorkflowCandidate } from "../src/lib/canvas/agent-media-workflow";
import type { CanvasAssistantSession } from "../src/types/canvas";

test("routes runway motion requests to video even when clothing is mentioned", () => {
    expect(classifyAgentMediaIntent("让模特穿这件衣服在秀场走秀")).toBe("video");
});

test("keeps an explicit first-generate-image-then-video request in staged mode", () => {
    expect(classifyAgentMediaIntent("先生成图片，再选一张生成走秀视频")).toBe("image_to_video");
});

test("requires one successful candidate before video is enabled", () => {
    const workflow = createAgentMediaWorkflow({ intent: "image_to_video", prompt: "走秀", imageModel: "gpt-image-2", videoModel: "happyhorse-1.0" });

    expect(canGenerateWorkflowVideo(workflow)).toBe(false);
    expect(canGenerateWorkflowVideo(selectWorkflowCandidate({ ...workflow, candidates: [{ nodeId: "image-1", status: "success" }] }, "image-1"))).toBe(true);
});

test("does not select failed candidates for image-to-video", () => {
    const workflow = createAgentMediaWorkflow({
        intent: "image_to_video",
        prompt: "走秀",
        imageModel: "gpt-image-2",
        videoModel: "happyhorse-1.0",
        candidates: [{ nodeId: "image-failed", status: "failed" }],
    });

    expect(selectWorkflowCandidate(workflow, "image-failed").selectedCandidateNodeId).toBeUndefined();
});

test("keeps video disabled when there are no candidates", () => {
    expect(canGenerateWorkflowVideo(createAgentMediaWorkflow({ intent: "image_to_video", prompt: "走秀", imageModel: "gpt-image-2", videoModel: "happyhorse-1.0" }))).toBe(false);
});

test("keeps the card video action disabled with a selection prompt until a successful candidate is selected", () => {
    const workflow = createAgentMediaWorkflow({
        intent: "image_to_video",
        prompt: "lookbook",
        imageModel: "gpt-image-2",
        videoModel: "happyhorse-1.0",
        candidates: [{ nodeId: "image-1", status: "success" }],
    });

    expect(getCanvasAgentMediaWorkflowCardState(workflow, { hasVideoAction: true })).toMatchObject({
        canGenerateVideo: false,
        videoDisabledMessage: "请选择一张成功候选图",
    });
    expect(getCanvasAgentMediaWorkflowCardState(selectWorkflowCandidate(workflow, "image-1"), { hasVideoAction: true })).toMatchObject({
        canGenerateVideo: true,
        videoDisabledMessage: undefined,
    });
});

test("card contract hides unavailable models and disables both stage submissions", () => {
    const workflow = selectWorkflowCandidate(
        createAgentMediaWorkflow({
            intent: "image_to_video",
            prompt: "lookbook",
            imageModel: "stale-image-model",
            videoModel: "stale-video-model",
            candidates: [{ nodeId: "image-1", status: "success" }],
        }),
        "image-1",
    );

    expect(getCanvasAgentMediaWorkflowCardContract(workflow, {
        imageModels: ["available-image-model"],
        videoModels: ["available-video-model"],
        hasImageAction: true,
        hasVideoAction: true,
        hasCandidateAction: true,
        hasRetryAction: true,
    })).toMatchObject({
        imageModel: undefined,
        videoModel: undefined,
        canGenerateImages: false,
        canGenerateVideo: false,
    });
});

test("card contract exposes uniquely named native radio candidates and keeps them disabled without a handler", () => {
    const workflow = createAgentMediaWorkflow({
        id: "workflow-choices",
        intent: "image_to_video",
        prompt: "lookbook",
        imageModel: "image-model",
        videoModel: "video-model",
        candidates: [
            { nodeId: "image-1", status: "success" },
            { nodeId: "image-2", status: "success" },
        ],
    });

    expect(getCanvasAgentMediaWorkflowCardContract(workflow, {
        imageModels: ["image-model"],
        videoModels: ["video-model"],
        hasImageAction: false,
        hasVideoAction: false,
        hasCandidateAction: false,
        hasRetryAction: false,
    })).toMatchObject({
        canGenerateImages: false,
        canGenerateVideo: false,
        candidates: [
            { nodeId: "image-1", name: "workflow-choices-candidate", label: "候选图 1", disabled: true },
            { nodeId: "image-2", name: "workflow-choices-candidate", label: "候选图 2", disabled: true },
        ],
    });
});

test("card contract retains selected image and model state while exposing stage errors as alerts", () => {
    const workflow = selectWorkflowCandidate(
        createAgentMediaWorkflow({
            id: "workflow-failed",
            intent: "image_to_video",
            prompt: "lookbook",
            imageModel: "image-model",
            videoModel: "video-model",
            candidates: [{ nodeId: "image-1", status: "success" }],
            imageStatus: "failed",
            error: "generation failed",
        }),
        "image-1",
    );

    expect(getCanvasAgentMediaWorkflowCardContract(workflow, {
        imageModels: ["image-model"],
        videoModels: ["video-model"],
        hasImageAction: true,
        hasVideoAction: true,
        hasCandidateAction: true,
        hasRetryAction: false,
    })).toMatchObject({
        imageModel: "image-model",
        videoModel: "video-model",
        selectedCandidateNodeId: "image-1",
        imageError: { message: "generation failed", role: "alert", canRetry: false },
    });
});

test("preserves selected candidate and model choices through serialization", () => {
    const workflow = selectWorkflowCandidate(
        {
            ...createAgentMediaWorkflow({ intent: "image_to_video", prompt: "走秀", imageModel: "gpt-image-2", videoModel: "happyhorse-1.0" }),
            candidates: [{ nodeId: "image-2", status: "success" }],
        },
        "image-2",
    );

    expect(JSON.parse(JSON.stringify(workflow))).toMatchObject({
        selectedCandidateNodeId: "image-2",
        imageModel: "gpt-image-2",
        videoModel: "happyhorse-1.0",
    });
});

test("restores a factory-built failed workflow from an assistant session", () => {
    const workflow = selectWorkflowCandidate(
        createAgentMediaWorkflow({
            id: "workflow-1",
            intent: "image_to_video",
            prompt: "走秀",
            imageModel: "gpt-image-2",
            videoModel: "happyhorse-1.0",
            candidates: [{ nodeId: "image-2", status: "success", url: "https://example.test/image-2.png" }],
            imageStatus: "failed",
            videoStatus: "idle",
            error: "证书校验失败",
        }),
        "image-2",
    );
    const session: CanvasAssistantSession = {
        id: "session-1",
        title: "走秀工作流",
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
        messages: [
            {
                id: "message-1",
                role: "assistant",
                text: "图片生成失败，可重试。",
                detail: {
                    toolCalls: [{ name: "canvas_generate_image" }],
                    mediaWorkflow: workflow,
                },
            },
        ],
    };

    const restored = JSON.parse(JSON.stringify(session)) as CanvasAssistantSession;
    const detail = restored.messages[0]?.detail;

    expect(detail?.toolCalls).toEqual([{ name: "canvas_generate_image" }]);
    expect(detail?.mediaWorkflow).toEqual({
        id: "workflow-1",
        intent: "image_to_video",
        prompt: "走秀",
        imageModel: "gpt-image-2",
        videoModel: "happyhorse-1.0",
        candidates: [{ nodeId: "image-2", status: "success", url: "https://example.test/image-2.png" }],
        selectedCandidateNodeId: "image-2",
        imageStatus: "failed",
        videoStatus: "idle",
        error: "证书校验失败",
    });
});
