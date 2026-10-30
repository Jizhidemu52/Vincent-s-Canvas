import { uiText } from "@/lib/i18n";
import { buildWorkflowVideoStageDispatch, completeAgentMediaWorkflowStage, selectWorkflowCandidate } from "@/lib/canvas/agent-media-workflow";
import type { CanvasMediaWorkflowAction } from "@/lib/canvas/canvas-assistant-panel-render-stability";
import type { CanvasAgentMediaWorkflow, CanvasAssistantSession } from "@/types/canvas";
import type { Dispatch, SetStateAction } from "react";
import type { App } from "antd";
import { workflowImageCandidatesFromResult, type CanvasGenerationResult } from "./canvas-project-utils";
import type { CanvasMediaWorkflowOptions } from "./use-canvas-media-workflow";

const loadWorkflowStage = () => import("@/lib/canvas/agent-media-workflow-stage");

export function createCanvasMediaWorkflowActions({ projectId, nodesRef, chatSessions, setChatSessions, applyAgentOps, handleGenerateNode, focusCanvasArea, stageScope, message, setSelectedNodeIds }: CanvasMediaWorkflowOptions & {
    stageScope: { active: boolean };
    message: ReturnType<typeof App.useApp>["message"];
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
}) {
    const updateMediaWorkflow = (messageId: string, updater: (workflow: CanvasAgentMediaWorkflow) => CanvasAgentMediaWorkflow) => {
        setChatSessions((sessions) =>
            sessions.map((session) => ({
                ...session,
                messages: session.messages.map((item) => {
                    const workflow = item.id === messageId ? item.detail?.mediaWorkflow : undefined;
                    return workflow ? { ...item, detail: { ...item.detail, mediaWorkflow: updater(workflow) } } : item;
                }),
            })),
        );
    };

    const runWorkflowImageStage = async (messageId: string, workflow: CanvasAgentMediaWorkflow) => {
            if (workflow.intent === "video") return;
            updateMediaWorkflow(messageId, (current) => completeAgentMediaWorkflowStage(current, "image", { status: "running" }));
            try {
                const { buildAgentMediaWorkflowStageOps } = await loadWorkflowStage();
                if (!stageScope.active) return;
                const { configId, ops } = buildAgentMediaWorkflowStageOps(workflow, "image", nodesRef.current);
                applyAgentOps(ops);
                let result: CanvasGenerationResult | undefined;
                await handleGenerateNode(configId, "image", workflow.prompt, (nextResult) => {
                    result = nextResult;
                });
                if (!stageScope.active) return;
                const candidates = workflowImageCandidatesFromResult(result);
                const firstFailure = result?.outputs.find((output) => output.status === "failed");
                updateMediaWorkflow(messageId, (current) =>
                    completeAgentMediaWorkflowStage(current, "image", {
                        status: candidates.some((candidate) => candidate.status === "success") ? "success" : "failed",
                        candidates,
                        error: firstFailure?.error || "图片生成失败，请重试。",
                    }),
                );
            } catch (error) {
                if (!stageScope.active) return;
                updateMediaWorkflow(messageId, (current) => completeAgentMediaWorkflowStage(current, "image", { status: "failed", error }));
            }
        };

    const runWorkflowVideoStage = async (messageId: string, workflow: CanvasAgentMediaWorkflow) => {
            const dispatch = buildWorkflowVideoStageDispatch(workflow);
            if (!dispatch) {
                message.warning(uiText("请先选择一张成功候选图"));
                return;
            }
            updateMediaWorkflow(messageId, (current) => completeAgentMediaWorkflowStage(current, "video", { status: "running" }));
            try {
                const { buildAgentMediaWorkflowStageOps } = await loadWorkflowStage();
                if (!stageScope.active) return;
                const { configId, ops } = buildAgentMediaWorkflowStageOps(workflow, "video", nodesRef.current, dispatch.referenceNodeIds[0]);
                applyAgentOps(ops);
                let result: CanvasGenerationResult | undefined;
                await handleGenerateNode(configId, "video", workflow.prompt, (nextResult) => {
                    result = nextResult;
                });
                if (!stageScope.active) return;
                const output = result?.outputs[0];
                const status = output?.status === "success" && output.url ? "success" : "failed";
                updateMediaWorkflow(messageId, (current) =>
                    completeAgentMediaWorkflowStage(current, "video", {
                        status,
                        ...(status === "success" && output ? { videoResult: { nodeId: output.nodeId, url: output.url!, ...(output.storageKey ? { storageKey: output.storageKey } : {}) } } : {}),
                        error: output?.error || "视频生成失败，请重试。",
                    }),
                );
            } catch (error) {
                if (!stageScope.active) return;
                updateMediaWorkflow(messageId, (current) => completeAgentMediaWorkflowStage(current, "video", { status: "failed", error }));
            }
        };

    const handleMediaWorkflowAction = (action: CanvasMediaWorkflowAction) => {
            const workflow = chatSessions.flatMap((session) => session.messages).find((item) => item.id === action.messageId)?.detail?.mediaWorkflow;
            if (!workflow) return;
            if (action.type === "image_model_change") {
                updateMediaWorkflow(action.messageId, (current) => ({ ...current, imageModel: action.model }));
                return;
            }
            if (action.type === "video_model_change") {
                updateMediaWorkflow(action.messageId, (current) => ({ ...current, videoModel: action.model }));
                return;
            }
            if (action.type === "image_count_change") {
                updateMediaWorkflow(action.messageId, (current) => ({ ...current, imageCount: 1 }));
                return;
            }
            if (action.type === "image_settings_change") {
                updateMediaWorkflow(action.messageId, (current) => ({ ...current, [action.key === "quality" ? "imageQuality" : "imageOptions"]: action.value }));
                return;
            }
            if (action.type === "video_seconds_change") {
                updateMediaWorkflow(action.messageId, (current) => ({ ...current, videoSeconds: action.seconds }));
                return;
            }
            if (action.type === "aspect_ratio_change") {
                updateMediaWorkflow(action.messageId, (current) => ({ ...current, aspectRatio: action.ratio }));
                return;
            }
            if (action.type === "select_candidate") {
                updateMediaWorkflow(action.messageId, (current) => selectWorkflowCandidate(current, action.nodeId));
                return;
            }
            if (action.type === "generate_images" || (action.type === "retry" && action.stage === "image")) {
                void runWorkflowImageStage(action.messageId, workflow);
                return;
            }
            if (action.type === "open_result") {
                const node = workflow.videoResult ? nodesRef.current.find((item) => item.id === workflow.videoResult?.nodeId) : undefined;
                if (!node) return;
                setSelectedNodeIds(new Set([node.id]));
                focusCanvasArea(node.position, node.width, node.height);
                return;
            }
            if (action.type === "generate_video" || (action.type === "retry" && action.stage === "video")) void runWorkflowVideoStage(action.messageId, workflow);
        };
    return { handleMediaWorkflowAction };
}
