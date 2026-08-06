import { expect, test } from "bun:test";

import { getCanvasAgentMediaWorkflowCardContract, getCanvasAgentMediaWorkflowCardState } from "../src/components/canvas/canvas-agent-media-workflow-card";
import { onlineToolToOps, resolveOnlineToolExecution } from "../src/components/canvas/canvas-assistant-panel";
import { applyCanvasAgentOps, type CanvasAgentSnapshot } from "../src/lib/canvas/canvas-agent-ops";
import {
    buildWorkflowVideoStageDispatch,
    canGenerateWorkflowVideo,
    classifyAgentMediaIntent,
    completeAgentMediaWorkflowStage,
    createAgentMediaWorkflow,
    createAgentMediaWorkflowForPrompt,
    resolveAgentMediaToolDispatch,
    restoreAgentMediaWorkflow,
    selectWorkflowCandidate,
    videoReferenceNodeIds,
} from "../src/lib/canvas/agent-media-workflow";
import { buildAgentMediaWorkflowStageOps } from "../src/lib/canvas/agent-media-workflow-stage";
import type { CanvasAssistantSession } from "../src/types/canvas";
import { CanvasNodeType } from "../src/types/canvas";
import { defaultConfig } from "../src/stores/use-config-store";

const emptyAgentSnapshot: CanvasAgentSnapshot = {
    projectId: "project-1",
    title: "Canvas",
    nodes: [],
    connections: [],
    selectedNodeIds: [],
    viewport: { x: 0, y: 0, k: 1 },
};

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

test("routes every auto-running Agent generation entry through the media dispatcher", () => {
    const models = { imageModel: "gpt-image-2", videoModel: "happyhorse-1.0" };
    const entries = [
        { toolName: "canvas_create_config_node", toolPrompt: "fashion still", requestedMode: "image", autoRun: true },
        { toolName: "canvas_run_generation", toolPrompt: "fashion still", requestedMode: "image" },
        {
            toolName: "canvas_apply_ops",
            toolPrompt: "fashion still",
            ops: [{ type: "run_generation", nodeId: "config-1", mode: "image", prompt: "fashion still" }],
        },
    ] as const;

    for (const entry of entries) {
        expect(resolveAgentMediaToolDispatch({ userPrompt: "make the model walk a runway", models, ...entry })).toEqual({ kind: "generation", mode: "video" });
    }
});

test("uses a target Config mode when canvas_run_generation omits mode, but forces direct-video to video", () => {
    const snapshot: CanvasAgentSnapshot = {
        ...emptyAgentSnapshot,
        nodes: [
            {
                id: "config-1",
                type: CanvasNodeType.Config,
                title: "Image config",
                position: { x: 0, y: 0 },
                width: 320,
                height: 240,
                metadata: { generationMode: "image", model: defaultConfig.imageModel },
            },
        ],
    };

    expect(onlineToolToOps("canvas_run_generation", { nodeId: "config-1" }, snapshot, defaultConfig)).toEqual([{ type: "run_generation", nodeId: "config-1", mode: "image", prompt: "" }]);
    const execution = resolveOnlineToolExecution("canvas_run_generation", { nodeId: "config-1" }, "make the model walk a runway video", snapshot, defaultConfig);
    expect(execution.kind).toBe("ops");
    if (execution.kind !== "ops") throw new Error("direct-video must remain a direct canvas execution");
    expect(execution.ops.filter((op) => op.type === "run_generation")).toEqual([{ type: "run_generation", nodeId: "config-1", mode: "video", prompt: "" }]);
});

test("synchronizes an existing Config to the video model before direct-video canvas_run_generation", () => {
    const snapshot: CanvasAgentSnapshot = {
        ...emptyAgentSnapshot,
        nodes: [
            {
                id: "config-1",
                type: CanvasNodeType.Config,
                title: "Image config",
                position: { x: 0, y: 0 },
                width: 320,
                height: 240,
                metadata: { generationMode: "image", model: defaultConfig.imageModel },
            },
        ],
    };

    const execution = resolveOnlineToolExecution("canvas_run_generation", { nodeId: "config-1" }, "make the model walk a runway video", snapshot, defaultConfig);
    expect(execution.kind).toBe("ops");
    if (execution.kind !== "ops") throw new Error("direct-video must remain a direct canvas execution");
    const { ops } = execution;
    const configNode = applyCanvasAgentOps(snapshot, ops.filter((op) => op.type !== "run_generation")).nodes.find((node) => node.id === "config-1");

    expect(configNode?.metadata).toMatchObject({ generationMode: "video", model: defaultConfig.videoModel });
    expect(ops.filter((op) => op.type === "run_generation")).toEqual([{ type: "run_generation", nodeId: "config-1", mode: "video", prompt: "" }]);
});

test("converts a same-batch image Config to the selected video model before direct-video generation", () => {
    const execution = resolveOnlineToolExecution(
        "canvas_apply_ops",
        {
            ops: [
                {
                    type: "add_node",
                    id: "config-1",
                    nodeType: "config",
                    title: "Image config",
                    position: { x: 0, y: 0 },
                    metadata: { generationMode: "image", model: defaultConfig.imageModel },
                },
                { type: "run_generation", nodeId: "config-1", mode: "image", prompt: "runway model" },
            ],
        },
        "make the model walk a runway video",
        emptyAgentSnapshot,
        defaultConfig,
    );
    expect(execution.kind).toBe("ops");
    if (execution.kind !== "ops") throw new Error("direct-video must remain a direct canvas execution");
    const { ops } = execution;

    const configNode = applyCanvasAgentOps(emptyAgentSnapshot, ops.filter((op) => op.type !== "run_generation")).nodes.find((node) => node.id === "config-1");
    expect(configNode?.metadata).toMatchObject({ generationMode: "video", model: defaultConfig.videoModel });
    expect(ops.filter((op) => op.type === "run_generation")).toEqual([{ type: "run_generation", nodeId: "config-1", mode: "video", prompt: "runway model" }]);
});

test("routes a direct-video apply-ops generation with omitted mode and synchronizes its Config", () => {
    const input = {
        ops: [
            {
                type: "add_node",
                id: "config-1",
                nodeType: "config",
                title: "Image config",
                position: { x: 0, y: 0 },
                metadata: { generationMode: "image", model: defaultConfig.imageModel },
            },
            { type: "run_generation", nodeId: "config-1", prompt: "runway model" },
        ],
    };
    const execution = resolveOnlineToolExecution("canvas_apply_ops", input, "make the model walk a runway video", emptyAgentSnapshot, defaultConfig);
    expect(execution.kind).toBe("ops");
    if (execution.kind !== "ops") throw new Error("direct-video must remain a direct canvas execution");
    const { ops } = execution;
    const configNode = applyCanvasAgentOps(emptyAgentSnapshot, ops.filter((op) => op.type !== "run_generation")).nodes.find((node) => node.id === "config-1");

    expect(configNode?.metadata).toMatchObject({ generationMode: "video", model: defaultConfig.videoModel });
    expect(ops.filter((op) => op.type === "run_generation")).toEqual([{ type: "run_generation", nodeId: "config-1", mode: "video", prompt: "runway model" }]);
});

test("creates a gated image-to-video workflow when apply-ops run mode is omitted", () => {
    const execution = resolveOnlineToolExecution(
        "canvas_apply_ops",
        {
            ops: [
                {
                    type: "add_node",
                    id: "config-1",
                    nodeType: "config",
                    title: "Image config",
                    position: { x: 0, y: 0 },
                    metadata: { generationMode: "image", model: defaultConfig.imageModel },
                },
                { type: "run_generation", nodeId: "config-1", prompt: "editorial fashion still" },
            ],
        },
        "image_to_video fashion runway",
        emptyAgentSnapshot,
        defaultConfig,
    );

    expect(execution).toMatchObject({
        kind: "workflow",
        workflow: { intent: "image_to_video", imageStatus: "idle", videoStatus: "idle", candidates: [] },
    });
    expect("ops" in execution).toBe(false);
    if (execution.kind !== "workflow") throw new Error("explicit image-to-video must create a workflow");
    expect(buildWorkflowVideoStageDispatch(execution.workflow)).toBeNull();
});

test("turns explicit image-to-video requests from every auto-running Agent entry into a gated workflow", () => {
    const models = { imageModel: "gpt-image-2", videoModel: "happyhorse-1.0" };
    const entries = [
        { toolName: "canvas_create_config_node", toolPrompt: "fashion still", requestedMode: "image", autoRun: true },
        { toolName: "canvas_run_generation", toolPrompt: "fashion still", requestedMode: "image" },
        {
            toolName: "canvas_apply_ops",
            toolPrompt: "fashion still",
            ops: [{ type: "run_generation", nodeId: "config-1", mode: "image", prompt: "fashion still" }],
        },
    ] as const;

    for (const entry of entries) {
        expect(resolveAgentMediaToolDispatch({ userPrompt: "image_to_video fashion runway", models, ...entry })).toMatchObject({ kind: "workflow", workflow: { intent: "image_to_video", imageStatus: "idle", videoStatus: "idle" } });
    }
});

test("uses the nested run-generation prompt when an apply-ops image-to-video workflow has no top-level prompt", () => {
    expect(
        resolveAgentMediaToolDispatch({
            userPrompt: "image to video fashion runway",
            toolName: "canvas_apply_ops",
            toolPrompt: "",
            ops: [{ type: "run_generation", nodeId: "config-1", mode: "image", prompt: "editorial fashion still" }],
            models: { imageModel: "gpt-image-2", videoModel: "happyhorse-1.0" },
        }),
    ).toMatchObject({ kind: "workflow", workflow: { prompt: "editorial fashion still" } });
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
        imageCount: 3,
        videoSeconds: "6",
        aspectRatio: "1:1",
        referenceNodeIds: [],
        selectedCandidateNodeId: "image-1",
        imageStatus: "success",
        videoStatus: "failed",
        error: "连接证书校验失败，请检查 API 地址、证书链或网络代理后重试。",
    });
});

test("keeps an explicit first-generate-image-then-video request in staged mode", () => {
    expect(classifyAgentMediaIntent("先生成图片，再选一张生成走秀视频")).toBe("image_to_video");
});

test("classifies explicit image_to_video spellings before direct-video keywords", () => {
    expect(classifyAgentMediaIntent("image_to_video fashion runway")).toBe("image_to_video");
    expect(classifyAgentMediaIntent("image-to-video fashion runway")).toBe("image_to_video");
    expect(classifyAgentMediaIntent("image to video fashion runway")).toBe("image_to_video");
});

test("requires one successful candidate before video is enabled", () => {
    const workflow = createAgentMediaWorkflow({ intent: "image_to_video", prompt: "走秀", imageModel: "gpt-image-2", videoModel: "happyhorse-1.0" });

    expect(canGenerateWorkflowVideo(workflow)).toBe(false);
    expect(canGenerateWorkflowVideo(selectWorkflowCandidate({ ...workflow, imageStatus: "success", candidates: [{ nodeId: "image-1", status: "success" }] }, "image-1"))).toBe(true);
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

test("keeps image-to-video submission disabled while a new image stage is running", () => {
    const workflow = selectWorkflowCandidate(
        createAgentMediaWorkflow({
            intent: "image_to_video",
            prompt: "lookbook",
            imageModel: "gpt-image-2",
            videoModel: "happyhorse-1.0",
            imageStatus: "running",
            candidates: [{ nodeId: "previous-image", status: "success" }],
        }),
        "previous-image",
    );

    expect(canGenerateWorkflowVideo(workflow)).toBe(false);
});

test("clears an old candidate selection when starting a new image stage", () => {
    const workflow = selectWorkflowCandidate(
        createAgentMediaWorkflow({
            intent: "image_to_video",
            prompt: "lookbook",
            imageModel: "gpt-image-2",
            videoModel: "happyhorse-1.0",
            candidates: [{ nodeId: "previous-image", status: "success" }],
            videoStatus: "success",
            videoResult: { nodeId: "previous-video", url: "blob:previous-video" },
        }),
        "previous-image",
    );

    const running = completeAgentMediaWorkflowStage(workflow, "image", { status: "running" });
    expect(running).toMatchObject({
        imageStatus: "running",
        videoStatus: "idle",
        candidates: [],
        selectedCandidateNodeId: undefined,
    });
    expect(running.videoResult).toBeUndefined();
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
        videoGenerateButton: { disabled: true },
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
        imageCount: 3,
        videoSeconds: "6",
        aspectRatio: "1:1",
        referenceNodeIds: [],
        candidates: [{ nodeId: "image-2", status: "success", url: "https://example.test/image-2.png" }],
        selectedCandidateNodeId: "image-2",
        imageStatus: "failed",
        videoStatus: "idle",
        error: "证书校验失败",
    });
});

test("keeps text and audio runs unchanged when a mixed Agent batch is forced to direct video", () => {
    const snapshot: CanvasAgentSnapshot = {
        ...emptyAgentSnapshot,
        nodes: [
            { id: "text-config", type: CanvasNodeType.Config, title: "Text", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { generationMode: "text", model: defaultConfig.textModel } },
            { id: "audio-config", type: CanvasNodeType.Config, title: "Audio", position: { x: 360, y: 0 }, width: 320, height: 240, metadata: { generationMode: "audio", model: defaultConfig.audioModel } },
            { id: "image-config", type: CanvasNodeType.Config, title: "Image", position: { x: 720, y: 0 }, width: 320, height: 240, metadata: { generationMode: "image", model: defaultConfig.imageModel } },
        ],
    };
    const execution = resolveOnlineToolExecution(
        "canvas_apply_ops",
        {
            ops: [
                { type: "run_generation", nodeId: "text-config", mode: "text", prompt: "write copy" },
                { type: "run_generation", nodeId: "audio-config", mode: "audio", prompt: "read copy" },
                { type: "run_generation", nodeId: "image-config", mode: "image", prompt: "runway motion" },
            ],
        },
        "create a runway video and keep the copy and voice tasks",
        snapshot,
        defaultConfig,
    );
    expect(execution.kind).toBe("ops");
    if (execution.kind !== "ops") throw new Error("direct-video batch must execute canvas ops");

    expect(execution.ops.filter((op) => op.type === "run_generation")).toEqual([
        { type: "run_generation", nodeId: "text-config", mode: "text", prompt: "write copy" },
        { type: "run_generation", nodeId: "audio-config", mode: "audio", prompt: "read copy" },
        { type: "run_generation", nodeId: "image-config", mode: "video", prompt: "runway motion" },
    ]);
    expect(execution.ops.filter((op) => op.type === "update_node" && (op.id === "text-config" || op.id === "audio-config"))).toEqual([]);
});

test("keeps omitted-mode text and audio Config runs unchanged while forcing an omitted visual Config through the online bridge", () => {
    const snapshot: CanvasAgentSnapshot = {
        ...emptyAgentSnapshot,
        nodes: [
            { id: "text-config", type: CanvasNodeType.Config, title: "Text", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { generationMode: "text", model: defaultConfig.textModel } },
            { id: "audio-config", type: CanvasNodeType.Config, title: "Audio", position: { x: 360, y: 0 }, width: 320, height: 240, metadata: { generationMode: "audio", model: defaultConfig.audioModel } },
            { id: "image-config", type: CanvasNodeType.Config, title: "Image", position: { x: 720, y: 0 }, width: 320, height: 240, metadata: { generationMode: "image", model: defaultConfig.imageModel } },
        ],
    };
    const execution = resolveOnlineToolExecution(
        "canvas_apply_ops",
        {
            ops: [
                { type: "run_generation", nodeId: "text-config", prompt: "write copy" },
                { type: "run_generation", nodeId: "audio-config", prompt: "read copy" },
                { type: "run_generation", nodeId: "image-config", prompt: "runway motion" },
            ],
        },
        "create a runway video and keep the copy and voice tasks",
        snapshot,
        defaultConfig,
    );
    expect(execution.kind).toBe("ops");
    if (execution.kind !== "ops") throw new Error("direct-video batch must execute canvas ops");

    expect(execution.ops.filter((op) => op.type === "run_generation")).toEqual([
        { type: "run_generation", nodeId: "text-config", mode: undefined, prompt: "write copy" },
        { type: "run_generation", nodeId: "audio-config", mode: undefined, prompt: "read copy" },
        { type: "run_generation", nodeId: "image-config", mode: "video", prompt: "runway motion" },
    ]);
    expect(execution.ops.filter((op) => op.type === "update_node" && (op.id === "text-config" || op.id === "audio-config"))).toEqual([]);
});

test("recognizes explicit select-image-then-video Chinese phrasing as a staged workflow", () => {
    for (const prompt of ["选图后生成视频", "选一张后生成视频", "出图之后生成视频", "图片完成之后生成视频", "生成图片，选择一张后再生成视频"]) {
        expect(classifyAgentMediaIntent(prompt)).toBe("image_to_video");
    }
});

test("normalizes older persisted workflows that predate media controls", () => {
    const legacyWorkflow = {
        id: "workflow-legacy",
        intent: "image_to_video",
        prompt: "lookbook",
        imageModel: "image-model",
        videoModel: "video-model",
        candidates: [],
        imageStatus: "idle",
        videoStatus: "idle",
    } as unknown as ReturnType<typeof createAgentMediaWorkflow>;

    expect(restoreAgentMediaWorkflow(legacyWorkflow, [])).toMatchObject({ imageCount: 3, videoSeconds: "6", aspectRatio: "1:1", referenceNodeIds: [] });
});

test("persists initial image references and rebuilds them only for the image stage", () => {
    const workflow = createAgentMediaWorkflow({
        id: "workflow-references",
        intent: "image_to_video",
        prompt: "先改款，选图后生成视频",
        imageModel: "image-model",
        videoModel: "video-model",
        referenceNodeIds: ["reference-1", "reference-2"],
    });
    const nodes = [
        { id: "reference-1", type: CanvasNodeType.Image, title: "Reference 1", position: { x: 0, y: 0 }, width: 240, height: 240, metadata: { status: "success" as const, content: "blob:reference-1" } },
        { id: "reference-2", type: CanvasNodeType.Image, title: "Reference 2", position: { x: 260, y: 0 }, width: 240, height: 240, metadata: { content: "blob:reference-2" } },
    ];
    const imageStage = buildAgentMediaWorkflowStageOps(workflow, "image", nodes);
    const videoStage = buildAgentMediaWorkflowStageOps(workflow, "video", nodes, "candidate-1");

    expect(imageStage.ops.filter((op) => op.type === "connect_nodes" && op.toNodeId === imageStage.configId).map((op) => op.fromNodeId)).toEqual([imageStage.textId, "reference-1", "reference-2"]);
    expect(videoStage.ops.filter((op) => op.type === "connect_nodes" && op.toNodeId === videoStage.configId).map((op) => op.fromNodeId)).toEqual([videoStage.textId, "candidate-1"]);
});

test("writes serializable stage settings and generation mode into workflow Config nodes", () => {
    const workflow = createAgentMediaWorkflow({
        id: "workflow-settings",
        intent: "image_to_video",
        prompt: "lookbook",
        imageModel: "image-model",
        videoModel: "video-model",
        imageCount: 5,
        videoSeconds: "8",
        aspectRatio: "9:16",
    });
    const imageStage = buildAgentMediaWorkflowStageOps(workflow, "image", []);
    const videoStage = buildAgentMediaWorkflowStageOps(workflow, "video", [], "candidate-1");
    const imageConfig = imageStage.ops.find((op) => op.type === "add_node" && op.id === imageStage.configId);
    const videoConfig = videoStage.ops.find((op) => op.type === "add_node" && op.id === videoStage.configId);

    expect(imageConfig?.metadata).toMatchObject({ generationMode: "image", model: "image-model", count: 5, size: "9:16" });
    expect(videoConfig?.metadata).toMatchObject({ generationMode: "video", model: "video-model", seconds: "8", size: "9:16" });
    const persistedVideoSnapshot = applyCanvasAgentOps(emptyAgentSnapshot, videoStage.ops.filter((op) => op.type !== "select_nodes"));
    expect(onlineToolToOps("canvas_run_generation", { nodeId: videoStage.configId }, persistedVideoSnapshot, defaultConfig)).toEqual([{ type: "run_generation", nodeId: videoStage.configId, mode: "video", prompt: "" }]);
    expect(JSON.parse(JSON.stringify(workflow))).toMatchObject({ imageCount: 5, videoSeconds: "8", aspectRatio: "9:16" });
});

test("restores interrupted workflow stages as retryable failures and hydrates candidate/result URLs from canvas nodes", () => {
    const workflow = selectWorkflowCandidate(
        createAgentMediaWorkflow({
            id: "workflow-interrupted",
            intent: "image_to_video",
            prompt: "lookbook",
            imageModel: "image-model",
            videoModel: "video-model",
            candidates: [{ nodeId: "image-1", status: "success", url: "blob:stale-image", storageKey: "image:persisted" }],
            imageStatus: "success",
            videoStatus: "running",
            videoResult: { nodeId: "video-1", url: "blob:stale-video", storageKey: "video:persisted" },
        }),
        "image-1",
    );
    const restored = restoreAgentMediaWorkflow(workflow, [
        { id: "image-1", type: CanvasNodeType.Image, title: "Candidate", position: { x: 0, y: 0 }, width: 240, height: 240, metadata: { content: "blob:hydrated-image", storageKey: "image:persisted", status: "success" } },
        { id: "video-1", type: CanvasNodeType.Video, title: "Result", position: { x: 300, y: 0 }, width: 320, height: 180, metadata: { content: "blob:hydrated-video", storageKey: "video:persisted", status: "success" } },
    ]);

    expect(restored).toMatchObject({
        imageModel: "image-model",
        videoModel: "video-model",
        selectedCandidateNodeId: "image-1",
        imageStatus: "success",
        videoStatus: "failed",
        error: "页面刷新后视频生成已中断，请重试。",
        candidates: [{ nodeId: "image-1", status: "success", url: "blob:hydrated-image", storageKey: "image:persisted" }],
        videoResult: { nodeId: "video-1", url: "blob:hydrated-video", storageKey: "video:persisted" },
    });
});

test("card exposes image count, video duration, ratio, selected-image summary, and video result entry", () => {
    const workflow = selectWorkflowCandidate(
        createAgentMediaWorkflow({
            id: "workflow-card-settings",
            intent: "image_to_video",
            prompt: "lookbook",
            imageModel: "image-model",
            videoModel: "video-model",
            imageCount: 4,
            videoSeconds: "10",
            aspectRatio: "16:9",
            candidates: [{ nodeId: "image-2", status: "success", url: "blob:image-2", storageKey: "image:2" }],
            imageStatus: "success",
            videoStatus: "success",
            videoResult: { nodeId: "video-3", url: "blob:video-3", storageKey: "video:3" },
        }),
        "image-2",
    );
    const card = getCanvasAgentMediaWorkflowCardContract(workflow, {
        imageModels: ["image-model"],
        videoModels: ["video-model"],
        hasImageAction: true,
        hasVideoAction: true,
        hasCandidateAction: true,
        hasRetryAction: true,
        hasResultAction: true,
    });

    expect(card).toMatchObject({
        imageCount: 4,
        videoSeconds: "10",
        aspectRatio: "16:9",
        selectedCandidateSummary: "候选图 1 · image-2",
        videoResult: { nodeId: "video-3", url: "blob:video-3", canOpen: true },
    });
});

test("card exposes a separate readable initial-reference summary for the image stage", () => {
    const workflow = createAgentMediaWorkflow({
        id: "workflow-initial-references",
        intent: "image_to_video",
        prompt: "lookbook",
        imageModel: "image-model",
        videoModel: "video-model",
        referenceNodeIds: ["garment-front-reference-node", "logo-2"],
    });
    const card = getCanvasAgentMediaWorkflowCardContract(workflow, {
        imageModels: ["image-model"],
        videoModels: ["video-model"],
        hasImageAction: true,
        hasVideoAction: true,
        hasCandidateAction: true,
        hasRetryAction: true,
    });

    expect(card.initialReferenceSummary).toEqual({
        count: 2,
        label: "初始参考图 2 张",
        items: [
            { nodeId: "garment-front-reference-node", label: "参考图 1 · garment-…node" },
            { nodeId: "logo-2", label: "参考图 2 · logo-2" },
        ],
    });
    expect(card.selectedCandidateSummary).toBe("未选择候选图");
});

test("online execution persists reference IDs and media settings into the staged workflow", () => {
    const execution = resolveOnlineToolExecution(
        "canvas_generate_image",
        { prompt: "editorial still", referenceNodeIds: ["reference-1", "reference-2"] },
        "选图后生成视频",
        emptyAgentSnapshot,
        { ...defaultConfig, canvasImageCount: "5", videoSeconds: "8", size: "9:16", textModel: "agent-text-model" },
    );

    expect(execution).toMatchObject({
        kind: "workflow",
        workflow: {
            referenceNodeIds: ["reference-1", "reference-2"],
            imageCount: 5,
            videoSeconds: "8",
            aspectRatio: "9:16",
            imageModel: defaultConfig.imageModel,
            videoModel: defaultConfig.videoModel,
        },
    });
});

test("video-stage success persists the real canvas result node, URL, and storage key", () => {
    const workflow = createAgentMediaWorkflow({ intent: "image_to_video", prompt: "lookbook", imageModel: "image-model", videoModel: "video-model" });

    expect(
        completeAgentMediaWorkflowStage(workflow, "video", {
            status: "success",
            videoResult: { nodeId: "video-real-id", url: "blob:video", storageKey: "video:persisted" },
        }),
    ).toMatchObject({
        videoStatus: "success",
        videoResult: { nodeId: "video-real-id", url: "blob:video", storageKey: "video:persisted" },
    });
});
