import { expect, test } from "bun:test";

import { getCanvasAgentMediaWorkflowCardContract, getCanvasAgentMediaWorkflowCardState } from "../src/components/canvas/canvas-agent-media-workflow-card";
import {
    buildWorkflowVideoStageDispatch,
    canGenerateWorkflowVideo,
    classifyAgentMediaIntent,
    completeAgentMediaWorkflowStage,
    createAgentMediaWorkflow,
    createAgentMediaWorkflowForPrompt,
    resolveAgentMediaToolDispatch,
    selectWorkflowCandidate,
    videoReferenceNodeIds,
} from "../src/lib/canvas/agent-media-workflow";
import type { CanvasAssistantSession } from "../src/types/canvas";

test("routes runway motion requests to video even when clothing is mentioned", () => {
    expect(classifyAgentMediaIntent("让模特穿这件衣服在秀场走秀")).toBe("video");
});

test("builds a video workflow for a runway request without an image run", () => {
    const workflow = createAgentMediaWorkflowForPrompt("让模特在秀场走秀", { imageModel: "gpt-image-2", videoModel: "happyhorse-1.0" });

    expect(workflow.intent).toBe("video");
    expect(workflow.imageStatus).toBe("idle");
});

test("routes an image tool for a runway prompt to a video generation dispatch", () => {
    expect(
        resolveAgentMediaToolDispatch({
            userPrompt: "让模特在秀场走秀",
            toolName: "canvas_generate_image",
            toolPrompt: "模特穿礼服",
            models: { imageModel: "gpt-image-2", videoModel: "happyhorse-1.0" },
        }),
    ).toMatchObject({ kind: "generation", mode: "video" });
});

test("routes an explicit image-then-video request to a staged workflow without a video run", () => {
    expect(
        resolveAgentMediaToolDispatch({
            userPrompt: "先生成图片，再选一张生成走秀视频",
            toolName: "canvas_generate_video",
            toolPrompt: "秀场礼服模特",
            models: { imageModel: "gpt-image-2", videoModel: "happyhorse-1.0" },
        }),
    ).toMatchObject({ kind: "workflow", workflow: { intent: "image_to_video", imageStatus: "idle", videoStatus: "idle" } });
});

test("keeps direct video as a direct video dispatch", () => {
    expect(
        resolveAgentMediaToolDispatch({
            userPrompt: "生成一段走秀视频",
            toolName: "canvas_generate_video",
            toolPrompt: "高级时装秀",
            models: { imageModel: "gpt-image-2", videoModel: "happyhorse-1.0" },
        }),
    ).toEqual({ kind: "generation", mode: "video" });
});

test("builds video input from only the selected image node", () => {
    expect(
        videoReferenceNodeIds({
            selectedCandidateNodeId: "image-2",
            candidates: [
                { nodeId: "image-1", status: "success" },
                { nodeId: "image-2", status: "success" },
            ],
        }),
    ).toEqual(["image-2"]);
});

test("refuses video input when no successful image candidate is selected", () => {
    expect(videoReferenceNodeIds({ candidates: [{ nodeId: "image-1", status: "success" }] })).toEqual([]);
});

test("builds a workflow video dispatch from exactly one selected successful node", () => {
    const workflow = selectWorkflowCandidate(
        createAgentMediaWorkflow({
            intent: "image_to_video",
            prompt: "lookbook",
            imageModel: "gpt-image-2",
            videoModel: "happyhorse-1.0",
            candidates: [
                { nodeId: "image-1", status: "success" },
                { nodeId: "image-2", status: "success" },
            ],
        }),
        "image-2",
    );

    expect(buildWorkflowVideoStageDispatch(workflow)).toEqual({ mode: "video", referenceNodeIds: ["image-2"] });
});

test("maps certificate failures to the current stage without losing the selected image or models", () => {
    const workflow = selectWorkflowCandidate(
        createAgentMediaWorkflow({
            intent: "image_to_video",
            prompt: "lookbook",
            imageModel: "gpt-image-2",
            videoModel: "happyhorse-1.0",
            candidates: [{ nodeId: "image-1", status: "success" }],
            imageStatus: "success",
        }),
        "image-1",
    );

    expect(completeAgentMediaWorkflowStage(workflow, "video", { status: "failed", error: "certificate verify failed" })).toMatchObject({
        imageModel: "gpt-image-2",
        videoModel: "happyhorse-1.0",
        selectedCandidateNodeId: "image-1",
        imageStatus: "success",
        videoStatus: "failed",
        error: "连接证书校验失败，请检查 API 地址、证书链或网络代理后重试。",
    });
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

    expect(
        getCanvasAgentMediaWorkflowCardContract(workflow, {
            imageModels: ["available-image-model"],
            videoModels: ["available-video-model"],
            hasImageAction: true,
            hasVideoAction: true,
            hasCandidateAction: true,
            hasRetryAction: true,
        }),
    ).toMatchObject({
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

    expect(
        getCanvasAgentMediaWorkflowCardContract(workflow, {
            imageModels: ["image-model"],
            videoModels: ["video-model"],
            hasImageAction: false,
            hasVideoAction: false,
            hasCandidateAction: false,
            hasRetryAction: false,
        }),
    ).toMatchObject({
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

    expect(
        getCanvasAgentMediaWorkflowCardContract(workflow, {
            imageModels: ["image-model"],
            videoModels: ["video-model"],
            hasImageAction: true,
            hasVideoAction: true,
            hasCandidateAction: true,
            hasRetryAction: false,
        }),
    ).toMatchObject({
        imageModel: "image-model",
        videoModel: "video-model",
        selectedCandidateNodeId: "image-1",
        imageError: { message: "generation failed", role: "alert", canRetry: false },
    });
});

test("card view model carries the JSX control props for selection, handlers, and retries", () => {
    const workflow = selectWorkflowCandidate(
        createAgentMediaWorkflow({
            id: "workflow-view-model",
            intent: "image_to_video",
            prompt: "lookbook",
            imageModel: "image-model",
            videoModel: "video-model",
            candidates: [
                { nodeId: "image-1", status: "success" },
                { nodeId: "image-2", status: "success" },
            ],
            imageStatus: "failed",
            error: "generation failed",
        }),
        "image-2",
    );
    const withoutHandlers = getCanvasAgentMediaWorkflowCardContract(workflow, {
        imageModels: ["image-model"],
        videoModels: ["video-model"],
        hasImageModelChange: false,
        hasImageAction: false,
        hasVideoModelChange: false,
        hasVideoAction: false,
        hasCandidateAction: false,
        hasRetryAction: false,
    });
    const withHandlers = getCanvasAgentMediaWorkflowCardContract(workflow, {
        imageModels: ["image-model"],
        videoModels: ["video-model"],
        hasImageModelChange: true,
        hasImageAction: true,
        hasVideoModelChange: true,
        hasVideoAction: true,
        hasCandidateAction: true,
        hasRetryAction: true,
    });

    expect(withoutHandlers).toMatchObject({
        imageModelSelect: { value: "image-model", disabled: true },
        videoModelSelect: { value: "video-model", disabled: true },
        imageGenerateButton: { disabled: true },
        videoGenerateButton: { disabled: true },
        candidates: [
            { nodeId: "image-1", id: "workflow-view-model-candidate-1", label: "候选图 1", checked: false, disabled: true },
            { nodeId: "image-2", id: "workflow-view-model-candidate-2", label: "候选图 2", checked: true, disabled: true },
        ],
        imageError: { retryVisible: false },
    });
    expect(withHandlers).toMatchObject({
        imageModelSelect: { value: "image-model", disabled: false },
        videoModelSelect: { value: "video-model", disabled: false },
        imageGenerateButton: { disabled: false },
        videoGenerateButton: { disabled: false },
        candidates: [
            { nodeId: "image-1", checked: false, disabled: false },
            { nodeId: "image-2", checked: true, disabled: false },
        ],
        selectedCandidateNodeId: "image-2",
        imageError: { retryVisible: true },
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
