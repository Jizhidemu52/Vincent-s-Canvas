import { uiText } from "@/lib/i18n";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { App } from "antd";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { canvasToolKey, currentToolConfig } from "@/hooks/use-tool-config";
import { buildNodeGenerationContext, buildNodeResponseMessages, hydrateNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { canvasCompareSource } from "@/lib/canvas/canvas-image-compare-source";
import { shouldCancelCanvasGeneration } from "@/lib/canvas/canvas-project-async-lifecycle";
import { imageModelProfile } from "@/lib/image-model-settings";
import { requestImageQuestion } from "@/services/api/image";
import { requestAudioGeneration, storeGeneratedAudio } from "@/services/api/audio";
import { recoverVideoGenerationTask, requestVideoGeneration, storeGeneratedVideo } from "@/services/api/video";
import { resolveImageUrl } from "@/services/image-storage";
import type { UploadedFile } from "@/services/file-storage";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type CanvasImageGenerationType } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import type { useCanvasGenerationRuntime } from "./use-canvas-generation-runtime";

type Runtime = ReturnType<typeof useCanvasGenerationRuntime>;
type Feedback = ReturnType<typeof App.useApp>;
type Context = Pick<Runtime, "createOptions" | "recoverPending" | "setRunningNodeId" | "startGenerationRequest" | "finishGenerationRequest" | "generationDispatchLocksRef" | "textStreamBufferRef"> & {
    projectId: string;
    nodesRef: RefObject<CanvasNodeData[]>;
    connectionsRef: RefObject<CanvasConnection[]>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    effectiveConfig: AiConfig;
    handleGenerateNode: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => Promise<void>;
    handleMissingModelConfig: () => void;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    message: Feedback["message"];
    modal: Feedback["modal"];
    flushSave: () => void;
    isCurrent: () => boolean;
    buildGenerationConfig: (config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasNodeGenerationMode) => AiConfig;
    buildImageGenerationMetadata: (type: CanvasImageGenerationType, config: AiConfig, count: number, references: ReferenceImage[]) => CanvasNodeMetadata;
    buildAudioGenerationMetadata: (config: AiConfig) => CanvasNodeMetadata;
    videoMetadata: (file: UploadedFile) => CanvasNodeMetadata;
    audioMetadata: (file: UploadedFile) => CanvasNodeMetadata;
    videoTaskErrorMetadata: (error: unknown) => Partial<CanvasNodeMetadata>;
    isGenerationCanceled: (error: unknown) => boolean;
};
const NODE_STATUS_LOADING = "loading", NODE_STATUS_SUCCESS = "success", NODE_STATUS_ERROR = "error";
const VIDEO_NODE_MAX_WIDTH = 420, VIDEO_NODE_MAX_HEIGHT = 420;

/** The existing node retry/recovery action is loaded only when explicitly invoked. */
export async function retryCanvasNode(node: CanvasNodeData, action: Context) {
    const { createOptions, recoverPending, setRunningNodeId, startGenerationRequest, finishGenerationRequest, generationDispatchLocksRef, textStreamBufferRef,
        projectId, nodesRef, connectionsRef, setNodes, effectiveConfig, handleGenerateNode, handleMissingModelConfig, isAiConfigReady, message, modal,
        flushSave, isCurrent, buildGenerationConfig, buildImageGenerationMetadata, buildAudioGenerationMetadata, videoMetadata, audioMetadata, videoTaskErrorMetadata, isGenerationCanceled } = action;
    if (!isCurrent()) return;
    if (node.type === CanvasNodeType.Image && await recoverPending(node.id)) return;
    if (!isCurrent()) return;
    if (node.type === CanvasNodeType.Text && node.metadata?.generationSubmissionUncertain) {
        const { confirmCanvasTextRetry } = await import("./canvas-media-generation-runtime");
        if (!isCurrent()) return;
        confirmCanvasTextRetry(node, { nodes: nodesRef, setNodes, locks: generationDispatchLocksRef.current, generate: handleGenerateNode, message, modal });
        return;
    }
    if (node.metadata?.mediaTask || node.metadata?.generationSubmissionUncertain) {
        const { retryCanvasMediaNode } = await import("./canvas-media-generation-runtime");
        if (!isCurrent()) return;
        await retryCanvasMediaNode(node.id, { projectId, nodes: nodesRef, setNodes, flushSave, isCurrent,
            locks: generationDispatchLocksRef.current, start: startGenerationRequest, finish: finishGenerationRequest, setRunning: setRunningNodeId, message });
        return;
    }
    if (node.type === CanvasNodeType.Video && node.metadata?.videoTaskId && node.metadata.status !== NODE_STATUS_SUCCESS) {
        if (node.metadata.videoTaskCanRecover === false) { message.warning(uiText("原视频任务提交状态待核查，请勿重复生成")); return; }
        const controller = startGenerationRequest(node.id, node.id, node.id);
        setRunningNodeId(node.id);
        setNodes((prev) => prev.map((item) => item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : item));
        try {
            const video = await storeGeneratedVideo(await recoverVideoGenerationTask({ id: node.metadata.videoTaskId, provider: "server", model: node.metadata.model || "" }, { signal: controller.signal }));
            if (!isCurrent()) return;
            const size = fitNodeSize(video.width || node.width, video.height || node.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
            setNodes((prev) => prev.map((item) => item.id === node.id ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...videoMetadata(video), errorDetails: undefined, videoTaskCanRecover: undefined } } : item));
            message.success(uiText("已取回原视频任务结果"));
        } catch (error) {
            if (!isCurrent() || isGenerationCanceled(error)) return;
            const errorDetails = error instanceof Error ? error.message : "原视频任务查询失败";
            message.error(errorDetails);
            setNodes((prev) => prev.map((item) => item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, ...videoTaskErrorMetadata(error) } } : item));
        } finally {
            finishGenerationRequest(node.id, controller);
            if (isCurrent()) setRunningNodeId(null);
        }
        return;
    }
    const origin = node.metadata?.generationOrigin;
    if (origin?.configNodeId && node.type !== CanvasNodeType.Image) {
        const config = nodesRef.current.find((item) => item.id === origin.configNodeId);
        if (!config || !nodesRef.current.some((item) => item.id === origin.sourceNodeId)) {
            message.warning(uiText("原公共配置或任务输入已删除，不能重建此任务"));
            return;
        }
        message.info(uiText("将按当前公共配置重新执行此任务，保留已有结果"));
        await handleGenerateNode(origin.sourceNodeId, origin.mode, config.metadata?.composerContent || config.metadata?.prompt || "");
        return;
    }
    const sourceNode = findRetrySourceNode(node.id, nodesRef.current, connectionsRef.current) || node;
    const batchRoot = node.metadata?.batchRootId ? nodesRef.current.find((item) => item.id === node.metadata?.batchRootId) : null;
    const savedImageMetadata = node.type === CanvasNodeType.Image ? { ...batchRoot?.metadata, ...node.metadata } : undefined;
    const hasSavedImageMetadata = Boolean(savedImageMetadata?.generationType);
    let generationConfig =
        hasSavedImageMetadata && savedImageMetadata
            ? {
                  ...effectiveConfig,
                  model: savedImageMetadata.model || effectiveConfig.imageModel || effectiveConfig.model,
                  quality: savedImageMetadata.quality || effectiveConfig.quality,
                  imageOptions: savedImageMetadata.imageOptions ?? effectiveConfig.imageOptions,
                  systemPrompt: savedImageMetadata.systemPrompt ?? effectiveConfig.systemPrompt,
                  size: savedImageMetadata.size || effectiveConfig.size,
                  count: "1",
              }
            : { ...buildGenerationConfig(effectiveConfig, sourceNode, node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image"), count: "1" };
    if (!isAiConfigReady(generationConfig, generationConfig.model)) {
        handleMissingModelConfig();
        return;
    }

    const context = hasSavedImageMetadata ? null : await hydrateNodeGenerationContext(buildNodeGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, sourceNode.metadata?.prompt || node.metadata?.prompt || ""));
    const blend = node.type === CanvasNodeType.Image && imageModelProfile(generationConfig.model).kind === "midjourney-blend";
    const prompt = blend ? "" : (savedImageMetadata?.prompt || context?.prompt || "").trim();
    if (!prompt && !blend) {
        message.warning(uiText("找不到提示词，无法重试"));
        return;
    }
    const generationType = savedImageMetadata?.generationType;
    const useReferenceImages = blend || (generationType ? generationType === "edit" : Boolean(context?.referenceImages.length));
    const retryReferenceImages =
        hasSavedImageMetadata && savedImageMetadata ? await resolveMetadataReferences(savedImageMetadata) : useReferenceImages ? (context?.referenceImages.length ? context.referenceImages : sourceNodeReferenceImages(batchRoot || sourceNode)) : [];
    if (!isCurrent()) return;
    if (useReferenceImages && !retryReferenceImages) {
        message.error(uiText("参考图片已丢失，无法继续重试"));
        setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: "参考图片已丢失，无法继续重试" } } : item)));
        return;
    }
    const retryImages = retryReferenceImages || [];
    generationConfig = currentToolConfig(generationConfig, canvasToolKey(node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image", useReferenceImages, imageModelProfile(generationConfig.model).kind));

    setRunningNodeId(node.id);
    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : item)));
    const controller = startGenerationRequest(node.id, sourceNode.id, node.id);

    try {
        if (node.type === CanvasNodeType.Text) {
            if (!context) return;
            let streamed = "";
            const answer = await requestImageQuestion(
                generationConfig,
                buildNodeResponseMessages({ ...context, prompt }),
                (text) => {
                    if (!isCurrent()) return;
                    streamed = text;
                    textStreamBufferRef.current?.push({ nodeId: node.id, content: text });
                },
                { signal: controller.signal, tool: "canvas-chat" },
            );
            if (!isCurrent()) return;
            textStreamBufferRef.current?.clear(node.id);
            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: answer || streamed, prompt, status: NODE_STATUS_SUCCESS } } : item)));
            return;
        }
        if (node.type === CanvasNodeType.Video) {
            const video = await storeGeneratedVideo(await requestVideoGeneration(generationConfig, prompt, retryImages, context?.referenceVideos || [], context?.referenceAudios || [], {
                toolKey: "canvas-video",
                signal: controller.signal,
                cancelOnAbort: () => shouldCancelCanvasGeneration(controller.signal),
                onSubmitted: (task) => { if (isCurrent()) setNodes((prev) => prev.map((item) => item.id === node.id ? { ...item, metadata: { ...item.metadata, videoTaskId: task.id, videoTaskCanRecover: true } } : item)); },
            }));
            if (!isCurrent()) return;
            const videoSize = fitNodeSize(video.width || node.width, video.height || node.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
            setNodes((prev) =>
                prev.map((item) =>
                    item.id === node.id
                        ? {
                              ...item,
                              width: videoSize.width,
                              height: videoSize.height,
                              position: { x: item.position.x + item.width / 2 - videoSize.width / 2, y: item.position.y + item.height / 2 - videoSize.height / 2 },
                              metadata: {
                                  ...item.metadata,
                                  ...videoMetadata(video),
                                  prompt,
                                  model: generationConfig.model,
                                  size: generationConfig.size,
                                  seconds: generationConfig.videoSeconds,
                                  videoMode: generationConfig.videoMode,
                                  vquality: generationConfig.vquality,
                                  generateAudio: generationConfig.videoGenerateAudio,
                                  watermark: generationConfig.videoWatermark,
                              },
                          }
                        : item,
                ),
            );
            return;
        }
        if (node.type === CanvasNodeType.Audio) {
            const audio = await storeGeneratedAudio(await requestAudioGeneration(generationConfig, prompt, { signal: controller.signal, cancelOnAbort: () => shouldCancelCanvasGeneration(controller.signal) }), generationConfig.audioFormat);
            if (!isCurrent()) return;
            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, ...audioMetadata(audio), prompt, ...buildAudioGenerationMetadata(generationConfig) } } : item)));
            return;
        }

        const imageTask = await createOptions(node.id, controller);
        const { metadata, uploaded: uploadedImage } = await imageTask.generate(generationConfig, prompt, useReferenceImages ? retryImages : undefined, undefined, useReferenceImages && !blend);
        if (!isCurrent()) return;
        const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        const imageSize = fitNodeSize(uploadedImage.width, uploadedImage.height, imageConfig.width, imageConfig.height);
        const generationMetadata = savedImageMetadata?.generationType
            ? { generationType: savedImageMetadata.generationType, model: generationConfig.model, size: generationConfig.size, quality: generationConfig.quality, count: 1, references: savedImageMetadata.references, compareSources: retryImages.map(canvasCompareSource) }
            : buildImageGenerationMetadata(useReferenceImages ? "edit" : "generation", generationConfig, 1, retryImages);
        setNodes((prev) =>
            prev.map((item) =>
                item.id === node.id
                    ? {
                          ...item,
                          type: CanvasNodeType.Image,
                          width: imageSize.width,
                          height: imageSize.height,
                          metadata: { ...item.metadata, ...metadata, prompt, ...generationMetadata },
                      }
                    : item,
            ),
        );
    } catch (error) {
        textStreamBufferRef.current?.clear(node.id);
        if (!isCurrent() || isGenerationCanceled(error)) return;
        const errorDetails = error instanceof Error ? error.message : "生成失败";
        message.error(errorDetails);
        setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, ...(item.type === CanvasNodeType.Video ? videoTaskErrorMetadata(error) : {}) } } : item)));
    } finally {
        finishGenerationRequest(node.id, controller);
        if (isCurrent()) setRunningNodeId(null);
    }
}

async function resolveMetadataReferences(metadata: CanvasNodeMetadata) {
    if (metadata.generationType !== "edit") return [];
    if (!metadata.references?.length) return null;
    const references = await Promise.all(
        metadata.references.map(async (url, index) => {
            const dataUrl = url.startsWith("image:") ? await resolveImageUrl(url, "") : url;
            return dataUrl ? { id: `${index}`, name: `reference-${index}.png`, type: "image/png", dataUrl, storageKey: url.startsWith("image:") ? url : undefined } : null;
        }),
    );
    return references.every(Boolean) ? (references as ReferenceImage[]) : null;
}

function findRetrySourceNode(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const queue = connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId);
    const visited = new Set<string>();
    while (queue.length) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const node = nodes.find((item) => item.id === id);
        if (node?.type === CanvasNodeType.Config) return node;
        connections.filter((connection) => connection.toNodeId === id).forEach((connection) => queue.push(connection.fromNodeId));
    }
    return null;
}

function sourceNodeReferenceImages(node: CanvasNodeData | null) {
    if (!node || node.type !== CanvasNodeType.Image || !node.metadata?.content) return [];
    return [
        {
            id: node.id,
            name: `${node.title || node.id}.png`,
            type: node.metadata.mimeType || "image/png",
            dataUrl: node.metadata.content,
            storageKey: node.metadata.storageKey,
        },
    ];
}
