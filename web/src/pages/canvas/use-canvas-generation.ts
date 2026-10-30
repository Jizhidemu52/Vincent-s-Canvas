import { uiText } from "@/lib/i18n";
import { buildNodeGenerationContext, buildNodeResponseMessages, hydrateNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { NODE_DEFAULT_SIZE, getNodeSpec } from "@/constant/canvas";
import { canvasToolKey, currentToolConfig } from "@/hooks/use-tool-config";
import { placeCanvasImageOutputs } from "@/lib/canvas/canvas-image-output-placement";
import { canvasGenerationRecordConfig, canvasGenerationRecordReferences, canvasNodeGenerationReferences, createCanvasGenerationRecord, hasIncompleteCanvasGenerationReferences } from "@/lib/canvas/canvas-generation-record";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { imageModelProfile, normalizeImageModelSettings } from "@/lib/image-model-settings";
import { validateImageReferences } from "@/lib/image-reference-policy";
import { requestImageQuestion } from "@/services/api/image";
import { useCanvasGraphSetter } from "@/stores/canvas/canvas-graph-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { modelOptionName, useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationRecord, type CanvasNodeData, type Position } from "@/types/canvas";
import { App } from "antd";
import { nanoid } from "nanoid";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { audioMetadata, buildAudioGenerationMetadata, buildGenerationConfig, buildImageGenerationMetadata, createCanvasNode, getGenerationCount, isGenerationCanceled, videoMetadata, videoTaskErrorMetadata, type CanvasGenerationOutput, type CanvasGenerationResult } from "./canvas-project-utils";
import type { SharedGenerationExecution } from "./canvas-shared-generation-runtime";
import { useCanvasGenerationRuntime } from "./use-canvas-generation-runtime";
type CanvasGenerationOptions = {
    projectId: string;
    nodesRef: RefObject<CanvasNodeData[]>;
    connectionsRef: RefObject<CanvasConnection[]>;
    designProjectIdRef: RefObject<string>;
    projectSaveQueueRef: RefObject<{ flush(): void } | null>;
    runtime: ReturnType<typeof useCanvasGenerationRuntime>;
    setDialogNodeId: Dispatch<SetStateAction<string | null>>;
    focusCanvasArea: (position: Position, width: number, height: number) => void;
    handleMissingModelConfig: () => void;
    isAiConfigReady: (...args: unknown[]) => boolean;
    flushPendingHistory?: () => unknown;
};

export function useCanvasGeneration({ projectId, nodesRef, connectionsRef, designProjectIdRef, projectSaveQueueRef, runtime, setDialogNodeId, focusCanvasArea, handleMissingModelConfig, isAiConfigReady, flushPendingHistory }: CanvasGenerationOptions) {
    const { message, modal } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const addAsset = useAssetStore(state => state.addAsset);
    const setNodes = useCanvasGraphSetter("nodes");
    const setConnections = useCanvasGraphSetter("connections");
    const setSelectedNodeIds = useCanvasGraphSetter("selectedNodeIds");
    const setSelectedConnectionId = useCanvasGraphSetter("selectedConnectionId");
    const { createOptions, recoverPending, setRunningNodeId, generationDispatchLocksRef, textStreamBufferRef, startGenerationRequest, finishGenerationRequest } = runtime;
    const NODE_STATUS_IDLE = "idle" as const;
    const NODE_STATUS_LOADING = "loading" as const;
    const NODE_STATUS_SUCCESS = "success" as const;
    const NODE_STATUS_ERROR = "error" as const;
    const retryScope = useMemo(() => ({ active: true }), [projectId]);
    useEffect(() => {
        retryScope.active = true;
        return () => { retryScope.active = false; };
    }, [retryScope]);
    const restoringGenerationRef = useRef(false);

    const restoreNodeGenerationInput = async (node: CanvasNodeData) => {
        if (!node.metadata?.sourceTaskId || restoringGenerationRef.current) return;
        restoringGenerationRef.current = true;
        const dismiss = message.loading(uiText("正在校验历史参数和参考原图…"), 0);
        try {
            const [{ restoreGenerationDraft }, { createCanvasRestoredGenerationNode }] = await Promise.all([import("@/services/api/generation-history"), import("@/lib/canvas/canvas-generation-draft")]);
            const draft = await restoreGenerationDraft(node.metadata.sourceTaskId);
            if (designProjectIdRef.current !== projectId) return;
            if (nodesRef.current.find(item => item.id === node.id) !== node) { message.warning(uiText("图片已变化，未应用历史输入，请重新打开")); return; }
            const position = { x: Math.max(...nodesRef.current.map(item => item.position.x + item.width)) + 120, y: node.position.y };
            const restored = createCanvasRestoredGenerationNode(draft, position);
            setNodes(current => [...current, restored]);
            setSelectedNodeIds(new Set([restored.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(restored.id);
            focusCanvasArea(restored.position, restored.width, restored.height);
            message.success(uiText("已新增恢复配置，原图和现有草稿保持不变；尚未生成"));
        } catch (error) { message.error(error instanceof Error ? error.message : uiText("历史输入恢复失败，画布未改变")); }
        finally { restoringGenerationRef.current = false; dismiss(); }
    };

    const executeGenerateNode = useCallback(
        async (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, onResult?: (result: CanvasGenerationResult) => void, shared?: SharedGenerationExecution, replay?: CanvasGenerationRecord) => {
            const ownerId = useUserStore.getState().user?.id;
            const snapshotNodes = nodesRef.current;
            const snapshotConnections = connectionsRef.current;
            const isCurrent = () => retryScope.active && designProjectIdRef.current === projectId && useUserStore.getState().user?.id === ownerId;
            const sourceNode = shared?.plan.targetNode || snapshotNodes.find((node) => node.id === nodeId);
            const usesSavedInputs = Boolean(sourceNode?.metadata?.generationRecord || sourceNode?.metadata?.draftImageReferences !== undefined
                || (sourceNode?.type === CanvasNodeType.Image && (sourceNode.metadata?.generationType || sourceNode.metadata?.sourceTaskId)));
            // Capture editable inputs before hydration/imports. Later edits belong to the next run.
            const savedReferences = mode === "image" && !shared && sourceNode ? replay ? canvasGenerationRecordReferences(replay) : canvasNodeGenerationReferences(sourceNode, snapshotNodes, snapshotConnections) : [];
            let reported = false;
            const reportResult = (outputs: CanvasGenerationOutput[]) => {
                if (reported) return;
                reported = true;
                onResult?.({ mode, outputs });
            };
            const recovered = mode === "image" ? await recoverPending(nodeId) : null;
            if (!isCurrent()) return;
            if (recovered) {
                reportResult(recovered);
                return;
            }
            if (!sourceNode || !nodesRef.current.some(node => node.id === nodeId)) {
                reportResult([{ nodeId, status: "failed", error: "来源节点已删除，未提交生成" }]);
                return;
            }
            if (mode === "image" && !shared && sourceNode.metadata?.draftImageReferences === undefined && hasIncompleteCanvasGenerationReferences(sourceNode)) {
                const error = "旧版记录参考信息不完整，可恢复历史输入";
                message.warning(uiText(error));
                reportResult([{ nodeId, status: "failed", error }]);
                return;
            }
            let generationConfig = replay ? canvasGenerationRecordConfig(replay, effectiveConfig) : shared?.config || buildGenerationConfig(effectiveConfig, sourceNode, mode);
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                handleMissingModelConfig();
                reportResult([{ nodeId, status: "failed", error: "模型配置不可用" }]);
                return;
            }

            const runningId = shared?.runningId || nodeId;
            setRunningNodeId(runningId);
            const runController = startGenerationRequest(nodeId, nodeId, runningId, shared?.controller);
            const generationOrigin = { configNodeId: shared?.plan.configNode.id, sourceNodeId: nodeId, runId: shared?.runId || nanoid(), mode };
            const sourceTextContent = sourceNode?.type === CanvasNodeType.Text ? sourceNode.metadata?.content?.trim() || "" : "";
            const editingTextNode = mode === "text" && Boolean(sourceTextContent);
            let generationContext;
            try {
                const context = shared?.plan.context || (mode === "image" && usesSavedInputs
                    ? { prompt: replay?.prompt ?? prompt, referenceImages: savedReferences, referenceVideos: [], referenceAudios: [], textCount: 0, imageCount: savedReferences.length, videoCount: 0, audioCount: 0 }
                    : buildNodeGenerationContext(nodeId, snapshotNodes, snapshotConnections, editingTextNode ? `请根据要求修改以下文本。\n\n原文：\n${sourceTextContent}\n\n修改要求：\n${prompt}` : prompt, mode));
                generationContext = await hydrateNodeGenerationContext(context);
                if (!isCurrent()) throw new DOMException("画布所属账号已变化", "AbortError");
            } catch (error) {
                finishGenerationRequest(nodeId, runController);
                if (!shared) setRunningNodeId(null);
                const detail = error instanceof Error ? error.message : "无法读取输入素材";
                if (isCurrent()) message.error(detail);
                reportResult([{ nodeId, status: "failed", error: detail }]);
                return;
            }
            const effectivePrompt = generationContext.prompt.trim();
            if (runController.signal.aborted) {
                finishGenerationRequest(nodeId, runController);
                if (!shared) setRunningNodeId(null);
                reportResult([{ nodeId, status: "failed", error: "生成已取消" }]);
                return;
            }
            const markSourceStatus = mode !== "image" && !shared && sourceNode?.type !== CanvasNodeType.Image && !editingTextNode;
            const statusPrompt = sourceNode?.type === CanvasNodeType.Config ? effectivePrompt : prompt;
            if (!effectivePrompt && (mode === "text" || mode === "audio")) {
                finishGenerationRequest(nodeId, runController);
                if (!shared) setRunningNodeId(null);
                reportResult([{ nodeId, status: "failed", error: "缺少生成提示词" }]);
                return;
            }
            let pendingChildIds: string[] = [];
            if (markSourceStatus) setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt: statusPrompt, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));

            try {
                if (mode === "image") {
                    const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                    const isImageNode = sourceNode?.type === CanvasNodeType.Image;
                    const referenceImages = !shared && (usesSavedInputs || savedReferences.length) ? savedReferences : generationContext.referenceImages;
                    let toolKey = shared?.toolKey;
                    if (!shared) {
                        const { resolveCanvasImageConfig } = await import("@/lib/canvas/canvas-generation-model");
                        const resolved = resolveCanvasImageConfig(generationConfig, useBusinessConfigStore.getState(), referenceImages.length > 0);
                        generationConfig = resolved.config;
                        toolKey = resolved.toolKey;
                        if (replay && generationConfig.model !== replay.parameters.model) throw new Error("原生成模型当前不可用，未替换模型或提交任务");
                    }
                    if (!isCurrent() || runController.signal.aborted || !nodesRef.current.some(node => node.id === nodeId)) throw new DOMException("画布或任务已变化", "AbortError");
                    const profile = imageModelProfile(generationConfig.model);
                    const effectivePrompt = profile.requiresPrompt ? generationContext.prompt.trim() : "";
                    generationConfig = { ...generationConfig, ...normalizeImageModelSettings(generationConfig, profile), canvasImageCount: "1" };
                    const count = 1;
                    const referenceValidation = validateImageReferences(modelOptionName(generationConfig.model), referenceImages, profile);
                    if (!referenceValidation.valid) {
                        message.error(referenceValidation.message);
                        finishGenerationRequest(nodeId, runController);
                        if (!shared) setRunningNodeId(null);
                        reportResult([{ nodeId, status: "failed", error: referenceValidation.message }]);
                        return;
                    }
                    const generationType = referenceImages.length && profile.kind !== "midjourney-blend" ? ("edit" as const) : ("generation" as const);
                    const recipeNode = shared?.plan.configNode || sourceNode;
                    const recipeInput = recipeNode?.metadata?.promptInput;
                    const recipeWorkflowStep = snapshotConnections.some(edge => edge.kind === "config-sequence" && (edge.fromNodeId === recipeNode?.id || edge.toNodeId === recipeNode?.id));
                    const promptInput = replay ? undefined : recipeInput?.scene === "free-optimize" && recipeNode?.metadata?.compiledPrompt !== effectivePrompt ? undefined : recipeInput || (recipeWorkflowStep ? { scene: "workflow-step" as const, fields: { step_type: "custom", instruction: effectivePrompt }, userText: effectivePrompt, mode: "edit" as const, referenceRoles: ["上游步骤输出图"] } : undefined);
                    const generationRecord = createCanvasGenerationRecord({ id: generationOrigin.runId, sourceNodeId: nodeId, configNodeId: generationOrigin.configNodeId,
                        prompt: effectivePrompt, inputPrompt: replay?.inputPrompt ?? prompt, references: referenceImages, nodes: snapshotNodes, config: generationConfig, generationType, promptInput });
                    // Replay keeps source identities even when the original nodes were deleted.
                    if (replay) generationRecord.references = structuredClone(replay.references);
                    const generationMetadata = { ...buildImageGenerationMetadata(generationType, generationConfig, count, referenceImages), generationOrigin, generationRecord, systemPrompt: generationConfig.systemPrompt };
                    const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : isImageNode ? CanvasNodeType.Image : CanvasNodeType.Text];
                    const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                    const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                    const workflowStep = isConfigNode && connectionsRef.current.some(edge => edge.kind === "config-sequence" && (edge.fromNodeId === nodeId || edge.toNodeId === nodeId));
                    const gap = 96;
                    const rowGap = 36;
                    const outputPosition = placeCanvasImageOutputs(
                        nodesRef.current,
                        workflowStep ? [] : shared ? [shared.plan.configNode, shared.plan.targetNode] : sourceNode ? [sourceNode] : [],
                        imageConfig,
                        workflowStep ? { x: parentPosition.x + parentConfig.width / 2, y: parentPosition.y + parentConfig.height + gap + imageConfig.height / 2 }
                            : { x: parentPosition.x + parentConfig.width + gap + imageConfig.width / 2, y: parentPosition.y + parentConfig.height / 2 },
                        gap,
                    );
                    const rootId = nanoid();
                    const childIds = count > 1 ? Array.from({ length: count }, () => nanoid()) : [];
                    const targetIds = count > 1 ? childIds : [rootId];
                    pendingChildIds = [rootId, ...childIds];
                    const rootNode: CanvasNodeData = {
                        id: rootId,
                        type: CanvasNodeType.Image,
                        title: effectivePrompt.slice(0, 32) || "Generated Image",
                        position: outputPosition,
                        width: imageConfig.width,
                        height: imageConfig.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            isBatchRoot: count > 1,
                            batchChildIds: count > 1 ? childIds : undefined,
                            batchUsesReferenceImages: referenceImages.length > 0,
                            ...generationMetadata,
                            imageBatchExpanded: count > 1 ? true : undefined,
                        },
                    };
                    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
                        id,
                        type: CanvasNodeType.Image,
                        title: effectivePrompt.slice(0, 32) || "Generated Image",
                        position: {
                            x: rootNode.position.x + rootNode.width + 120 + (index % 2) * (imageConfig.width + 36),
                            y: rootNode.position.y + Math.floor(index / 2) * (imageConfig.height + rowGap),
                        },
                        width: imageConfig.width,
                        height: imageConfig.height,
                        metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, batchRootId: count > 1 ? rootId : undefined, ...generationMetadata },
                    }));
                    const batchConnections = [{ id: nanoid(), fromNodeId: nodeId, toNodeId: rootId, kind: "generation-output" as const }, ...childIds.map((childId) => ({ id: nanoid(), fromNodeId: rootId, toNodeId: childId, kind: "generation-output" as const }))];

                    flushPendingHistory?.();
                    setNodes((prev) => [
                        ...prev,
                        rootNode,
                        ...childNodes,
                    ]);
                    setConnections((prev) => [...prev, ...batchConnections]);
                    setSelectedNodeIds(new Set([nodeId]));
                    setSelectedConnectionId(null);
                    setDialogNodeId(nodeId);

                    const controller = runController;
                    targetIds.forEach((targetId) => startGenerationRequest(targetId, nodeId, runningId, controller));
                    if (count > 1) startGenerationRequest(rootId, nodeId, runningId, controller);
                    let hasSuccess = false;
                    let hasFailure = false;
                    const imageOutputs: CanvasGenerationOutput[] = [];
                    await Promise.all(
                        targetIds.map(async (targetId) => {
                            try {
                                const imageTask = await createOptions(targetId, controller, undefined, toolKey);
                                const { metadata, uploaded } = await imageTask.generate({ ...generationConfig, count: "1" }, effectivePrompt, referenceImages.length ? referenceImages : undefined, undefined, generationType === "edit", promptInput, Boolean(replay));
                                if (!isCurrent() || controller.signal.aborted) return false;
                                const imageSize = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                                setNodes((prev) => {
                                    const root = prev.find((node) => node.id === rootId);
                                    return prev.map((node) => {
                                        if (node.id !== targetId && node.id !== rootId) return node;
                                        const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
                                        if (node.id === rootId && (targetId === rootId || !root?.metadata?.primaryImageId))
                                            return {
                                                ...node,
                                                position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                                                width: imageSize.width,
                                                height: imageSize.height,
                                                metadata: { ...node.metadata, ...metadata, primaryImageId: targetId },
                                            };
                                        if (node.id === targetId)
                                            return {
                                                ...node,
                                                position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                                                width: imageSize.width,
                                                height: imageSize.height,
                                                metadata: { ...node.metadata, ...metadata },
                                            };
                                        return node;
                                    });
                                });
                                // Keep the first completed result in view, including Agent-created edit flows.
                                if (!workflowStep && (targetId === rootId || !hasSuccess)) {
                                    const target = targetId === rootId ? rootNode : childNodes.find((node) => node.id === targetId) || rootNode;
                                    focusCanvasArea(target.position, imageSize.width, imageSize.height);
                                }
                                addAsset({
                                    kind: "image",
                                    title: effectivePrompt.slice(0, 24) || "画布生成图片",
                                    coverUrl: uploaded.url,
                                    tags: ["无线画布"],
                                    source: "无线画布",
                                    data: { dataUrl: uploaded.url, storageKey: uploaded.storageKey, width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType },
                                    metadata: {
                                        source: "canvas",
                                        module: "无线画布",
                                        nodeId: targetId,
                                        imageName: generationMetadata.imageName, imageVersion: generationMetadata.imageVersion,
                                        prompt: effectivePrompt,
                                        model: generationConfig.model,
                                        toolMode: generationType,
                                        projectId,
                                        recreatePath: `/image?tool=${generationType === "edit" ? "image-edit" : "image-generation"}&prompt=${encodeURIComponent(effectivePrompt)}&model=${encodeURIComponent(generationConfig.model)}`,
                                    },
                                });
                                hasSuccess = true;
                                imageOutputs.push({ nodeId: targetId, status: "success", url: uploaded.url, storageKey: uploaded.storageKey });
                                return true;
                            } catch (error) {
                                if (!isCurrent() || isGenerationCanceled(error)) return false;
                                const errorDetails = error instanceof Error ? error.message : "生成失败";
                                hasFailure = true;
                                imageOutputs.push({ nodeId: targetId, status: "failed", error: errorDetails });
                                setNodes((prev) => prev.map((node) => (node.id === targetId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node)));
                            } finally {
                                finishGenerationRequest(targetId, controller);
                            }
                            return false;
                        }),
                    );
                    if (count > 1) finishGenerationRequest(rootId, controller);
                    if (!isCurrent() || controller.signal.aborted) {
                        reportResult(imageOutputs.length ? imageOutputs : [{ nodeId, status: "failed", error: "生成已取消" }]);
                        return;
                    }
                    const failureDetails = imageOutputs.find((output) => output.status === "failed")?.error || "全部图片生成失败";
                    if (hasFailure) message.error(hasSuccess ? uiText("部分图片生成失败：{value1}", { value1: failureDetails }) : failureDetails);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === rootId && !hasSuccess
                                    ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails: failureDetails } }
                                    : node,
                        ),
                    );
                    reportResult(imageOutputs);
                    return;
                }

                if (!shared) generationConfig = currentToolConfig(generationConfig, canvasToolKey(mode));
                if (mode === "video" || mode === "audio") {
                    const { runCanvasMediaGeneration } = await import("./canvas-media-generation-runtime");
                    const output = await runCanvasMediaGeneration({ nodeId, mode, source: sourceNode, shared: Boolean(shared), config: generationConfig, context: generationContext, origin: generationOrigin,
                        controller: runController, runningId, projectId, nodes: nodesRef, setNodes, setConnections, flushSave: () => projectSaveQueueRef.current?.flush(), isCurrent: () => designProjectIdRef.current === projectId, start: startGenerationRequest, finish: finishGenerationRequest });
                    if (output.status === "failed" && !runController.signal.aborted) message.error(output.error);
                    reportResult([output]);
                    return;
                }

                let streamed = "";
                const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                const textCount = !shared && isConfigNode ? getGenerationCount(generationConfig.count) : 1;
                const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : CanvasNodeType.Text];
                const textConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
                const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                const childIds = shared || isConfigNode || editingTextNode ? Array.from({ length: textCount }, () => nanoid()) : [];
                pendingChildIds = childIds;
                if (shared || isConfigNode || editingTextNode) {
                    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
                        id,
                        type: CanvasNodeType.Text,
                        title: effectivePrompt.slice(0, 32) || "Generated Text",
                        position: {
                            x: parentPosition.x + parentConfig.width + 96,
                            y: parentPosition.y + parentConfig.height / 2 - textConfig.height / 2 + (index - (textCount - 1) / 2) * (textConfig.height + 36),
                        },
                        width: textConfig.width,
                        height: textConfig.height,
                        metadata: { prompt: effectivePrompt, generationOrigin, status: NODE_STATUS_LOADING, fontSize: 14 },
                    }));
                    setNodes((prev) => [...prev.map((node) => (node.id === nodeId && isConfigNode ? { ...node, metadata: { ...node.metadata, prompt: effectivePrompt, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)), ...childNodes]);
                    setConnections((prev) => [...prev, ...childIds.map((childId) => ({ id: nanoid(), fromNodeId: nodeId, toNodeId: childId, kind: "generation-output" as const }))]);
                }

                const controller = runController;
                const textTargetIds = childIds.length ? childIds : [nodeId];
                textTargetIds.forEach((targetNodeId) => startGenerationRequest(targetNodeId, nodeId, runningId, controller));
                const answers = await Promise.all(
                    textTargetIds.map((targetNodeId) => {
                        let localStreamed = "";
                        return requestImageQuestion(
                            generationConfig,
                            buildNodeResponseMessages({ ...generationContext, prompt: effectivePrompt }),
                            (text) => {
                                localStreamed = text;
                                streamed = text;
                                if (isConfigNode) return;
                                textStreamBufferRef.current?.push({ nodeId: targetNodeId, content: text });
                            },
                            { signal: controller.signal, tool: "canvas-chat", onChatSubmissionStarted: shared ? (textRequestId) => {
                                setNodes(previous => previous.map(node => node.id === targetNodeId ? { ...node, metadata: { ...node.metadata, textRequestId, generationSubmissionUncertain: true } } : node));
                            } : undefined },
                        )
                            .then((answer) => ({ nodeId: targetNodeId, content: answer || localStreamed }))
                            .finally(() => finishGenerationRequest(targetNodeId, controller));
                    }),
                );
                if (controller.signal.aborted) {
                    textTargetIds.forEach((targetNodeId) => textStreamBufferRef.current?.clear(targetNodeId));
                    reportResult(textTargetIds.map((targetNodeId) => ({ nodeId: targetNodeId, status: "failed", error: "生成已取消" })));
                    return;
                }
                const answerByNodeId = new Map(answers.map((item) => [item.nodeId, item.content]));
                textTargetIds.forEach((targetNodeId) => textStreamBufferRef.current?.clear(targetNodeId));
                setNodes((prev) =>
                    prev.map((node) =>
                        childIds.includes(node.id)
                            ? { ...node, metadata: { ...node.metadata, content: answerByNodeId.get(node.id) || streamed, status: NODE_STATUS_SUCCESS, generationSubmissionUncertain: undefined } }
                            : node.id === nodeId && isConfigNode
                              ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } }
                              : node.id === nodeId && !editingTextNode && !shared
                                ? { ...node, type: CanvasNodeType.Text, title: prompt.slice(0, 32) || "Generated Text", metadata: { ...node.metadata, content: answerByNodeId.get(node.id) || streamed, status: NODE_STATUS_SUCCESS } }
                                : node,
                    ),
                );
                reportResult(answers.map((answer) => ({ nodeId: answer.nodeId, status: "success" })));
            } catch (error) {
                (pendingChildIds.length ? pendingChildIds : [nodeId]).forEach((targetNodeId) => textStreamBufferRef.current?.clear(targetNodeId));
                if (!isCurrent() || isGenerationCanceled(error)) {
                    reportResult((pendingChildIds.length ? pendingChildIds : [nodeId]).map((outputNodeId) => ({ nodeId: outputNodeId, status: "failed", error: "生成已取消" })));
                    return;
                }
                const errorDetails = error instanceof Error ? error.message : "生成失败";
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((node) => (node.id === nodeId || pendingChildIds.includes(node.id) ? (node.id === nodeId && !markSourceStatus ? node : { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails, ...(node.type === CanvasNodeType.Video ? videoTaskErrorMetadata(error) : {}) } }) : node)),
                );
                reportResult((pendingChildIds.length ? pendingChildIds : [nodeId]).map((outputNodeId) => ({ nodeId: outputNodeId, status: "failed", error: errorDetails })));
            } finally {
                finishGenerationRequest(nodeId, runController);
                if (!shared && isCurrent()) setRunningNodeId(null);
            }
        },
        [createOptions, effectiveConfig, finishGenerationRequest, flushPendingHistory, handleMissingModelConfig, isAiConfigReady, message, projectId, recoverPending, retryScope, startGenerationRequest],
    );
    const handleGenerateNode = useCallback(async (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, onResult?: (result: CanvasGenerationResult) => void, sequenceLock?: string, sequenceSignal?: AbortSignal) => {
        if (!sequenceLock && connectionsRef.current.some(edge => edge.kind === "config-sequence" && (edge.fromNodeId === nodeId || edge.toNodeId === nodeId))) {
            message.info(uiText("请从配置节点的“运行工作流”按钮启动相连步骤")); return;
        }
        // Lock before the lazy import: rapid double clicks must not submit twice.
        const ownsSequenceLock = sequenceLock && generationDispatchLocksRef.current.size === 1 && generationDispatchLocksRef.current.has(sequenceLock);
        if (generationDispatchLocksRef.current.size && !ownsSequenceLock) {
            message.info(uiText("请先完成或停止当前任务"));
            return;
        }
        if (!ownsSequenceLock) generationDispatchLocksRef.current.add(nodeId);
        const snapshot = { nodes: nodesRef.current, connections: connectionsRef.current };
        try {
            const { runCanvasGeneration } = await import("./canvas-shared-generation-runtime");
            if (sequenceSignal?.aborted) return;
            await runCanvasGeneration(nodeId, mode, prompt, onResult, {
                snapshot, getSnapshot: () => ({ nodes: nodesRef.current, connections: connectionsRef.current }),
                buildConfig: (node, selectedMode) => buildGenerationConfig(effectiveConfig, node, selectedMode),
                isAiConfigReady, execute: executeGenerateNode, recover: recoverPending, start: startGenerationRequest, finish: finishGenerationRequest,
                setRunning: setRunningNodeId, setNodes, message,
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : "加载失败";
            message.error(detail);
            onResult?.({ mode, outputs: [{ nodeId, status: "failed", error: detail }] });
        } finally {
            if (!ownsSequenceLock) generationDispatchLocksRef.current.delete(nodeId);
        }
    }, [effectiveConfig, executeGenerateNode, finishGenerationRequest, isAiConfigReady, message, recoverPending, startGenerationRequest]);

    const handleRegenerateNode = useCallback(async (node: CanvasNodeData) => {
        const record = node.metadata?.generationRecord;
        if (!record || node.type !== CanvasNodeType.Image) { message.info(uiText("这张图片没有完整生成档案，请先恢复历史输入")); return; }
        if (generationDispatchLocksRef.current.size) { message.info(uiText("请先完成或停止当前任务")); return; }
        if (nodesRef.current.find(item => item.id === node.id) !== node) { message.warning(uiText("图片已变化，请重新选择后生成")); return; }
        generationDispatchLocksRef.current.add(node.id);
        try {
            await executeGenerateNode(node.id, "image", record.prompt, undefined, undefined, record);
        } catch (error) {
            if (retryScope.active && designProjectIdRef.current === projectId) message.error(error instanceof Error ? error.message : uiText("重新生成失败"));
        } finally { generationDispatchLocksRef.current.delete(node.id); }
    }, [executeGenerateNode, message, projectId, retryScope]);

const handleRetryNode = useCallback(async (node: CanvasNodeData) => {
        const ownerId = useUserStore.getState().user?.id;
        const isCurrent = () => retryScope.active && designProjectIdRef.current === projectId && useUserStore.getState().user?.id === ownerId;
        try {
            if (node.type === CanvasNodeType.Image && node.metadata?.generationRecord && !node.metadata.imageTask) {
                await handleRegenerateNode(node);
                return;
            }
            const { retryCanvasNode } = await import("./canvas-node-retry-runtime");
            if (!isCurrent() || nodesRef.current.find(item => item.id === node.id) !== node) return;
            await retryCanvasNode(node, {
                createOptions, recoverPending, setRunningNodeId, startGenerationRequest, finishGenerationRequest, generationDispatchLocksRef, textStreamBufferRef,
                projectId, nodesRef, connectionsRef, setNodes, effectiveConfig, handleGenerateNode, handleMissingModelConfig, isAiConfigReady, message, modal,
                flushSave: () => projectSaveQueueRef.current?.flush(), isCurrent, buildGenerationConfig, buildImageGenerationMetadata,
                buildAudioGenerationMetadata, videoMetadata, audioMetadata, videoTaskErrorMetadata, isGenerationCanceled,
            });
        } catch (error) {
            if (isCurrent()) message.error(error instanceof Error ? error.message : uiText("重试操作加载失败，请重试"));
        }
    }, [createOptions, effectiveConfig, finishGenerationRequest, handleGenerateNode, handleRegenerateNode, handleMissingModelConfig, isAiConfigReady, message, modal, projectId, recoverPending, retryScope, startGenerationRequest]);

    const generateImageFromTextNode = useCallback(
        (node: CanvasNodeData) => {
            const prompt = (node.metadata?.content || node.metadata?.prompt || "").trim();
            if (!prompt) {
                message.warning(uiText("文本节点为空，无法生图"));
                return;
            }
            const sourceNode = nodesRef.current.find((item) => item.id === node.id);
            if (!sourceNode) return;
            const nodeSize = getNodeSpec(CanvasNodeType.Config);
            const configNode = createCanvasNode(
                CanvasNodeType.Config,
                {
                    x: sourceNode.position.x + sourceNode.width + 96 + nodeSize.width / 2,
                    y: sourceNode.position.y + sourceNode.height / 2,
                },
                {
                    prompt: "",
                    model: effectiveConfig.imageModel || effectiveConfig.model,
                    size: effectiveConfig.size,
                    count: 1,
                },
            );
            const connection = { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: configNode.id };
            flushPendingHistory?.();
            const nextNodes = nodesRef.current.concat(configNode);
            const nextConnections = [...connectionsRef.current, connection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, flushPendingHistory, message],
    );

    return { handleGenerateNode, handleRegenerateNode, handleRetryNode, generateImageFromTextNode, restoreNodeGenerationInput };
}
