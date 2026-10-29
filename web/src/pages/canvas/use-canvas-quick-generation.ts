import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { canvasToolKey, currentToolConfig } from "@/hooks/use-tool-config";
import { canvasImageReferenceIdentity } from "@/lib/canvas/canvas-image-filename";
import { placeCanvasImageOutputs } from "@/lib/canvas/canvas-image-output-placement";
import { assertCanvasImageUploadSize } from "@/lib/canvas/canvas-image-upload-limit";
import { canvasImageUsageInput } from "@/lib/canvas/canvas-image-usage";
import { fitNodeSize, nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { type CanvasSelectionReference } from "@/lib/canvas/canvas-selection-references";
import { deploymentFeatures } from "@/lib/deployment-features";
import { imageModelProfile, normalizeImageModelSettings } from "@/lib/image-model-settings";
import { validateImageReferences } from "@/lib/image-reference-policy";
import { promptImageSettings } from "@/lib/prompt-editor-parameters";
import { hydratePromptReuse } from "@/services/api/prompts";
import { fetchServerAssetContent } from "@/services/api/server-assets";
import { uploadImage } from "@/services/image-storage";
import { useCanvasGraphSetter } from "@/stores/canvas/canvas-graph-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { defaultConfig, modelOptionName, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType, type CanvasImageGenerationType, type CanvasNodeData, type Position } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import { App } from "antd";
import { nanoid } from "nanoid";
import type { Dispatch, ChangeEvent as ReactChangeEvent, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { buildImageGenerationMetadata, isGenerationCanceled } from "./canvas-project-utils";
import { useCanvasBatchEdit } from "./use-canvas-batch-edit";
import { useCanvasGenerationRuntime } from "./use-canvas-generation-runtime";
type CanvasQuickGenerationOptions = {
    projectId: string;
    projectLoaded: boolean;
    nodesRef: RefObject<CanvasNodeData[]>;
    runtime: ReturnType<typeof useCanvasGenerationRuntime>;
    batchEdit: Pick<ReturnType<typeof useCanvasBatchEdit>, "setBatchEditPrompt" | "setBatchImageSettings" | "setBatchEditOpen">;
    setDialogNodeId: Dispatch<SetStateAction<string | null>>;
    getCanvasCenter: () => Position;
    handleMissingModelConfig: () => void;
    isAiConfigReady: (...args: unknown[]) => boolean;
};

export function useCanvasQuickGeneration({ projectId, projectLoaded, nodesRef, runtime, batchEdit, setDialogNodeId, getCanvasCenter, handleMissingModelConfig, isAiConfigReady }: CanvasQuickGenerationOptions) {
    const { message, modal } = App.useApp();
    const [searchParams] = useSearchParams();
    const effectiveConfig = useEffectiveConfig();
    const estimateUsage = useBusinessConfigStore(state => state.estimate);
    const addAsset = useAssetStore(state => state.addAsset);
    const setNodes = useCanvasGraphSetter("nodes");
    const setSelectedNodeIds = useCanvasGraphSetter("selectedNodeIds");
    const setSelectedConnectionId = useCanvasGraphSetter("selectedConnectionId");
    const { createOptions, startGenerationRequest, finishGenerationRequest, setRunningNodeId } = runtime;
    const { setBatchEditPrompt, setBatchImageSettings, setBatchEditOpen } = batchEdit;
    const NODE_STATUS_LOADING = "loading" as const;
    const NODE_STATUS_ERROR = "error" as const;
    const [quickGenerateOpen, setQuickGenerateOpen] = useState(false);
    const quickGeneratePromptRef = useRef("");
    const [quickGeneratePromptRevision, setQuickGeneratePromptRevision] = useState(0);
    const setQuickGeneratePrompt = useCallback((value: string) => {
        quickGeneratePromptRef.current = value;
        setQuickGeneratePromptRevision((revision) => revision + 1);
    }, []);
    const [quickGeneratePosition, setQuickGeneratePosition] = useState<Position | null>(null);
    const [quickGenerateModel, setQuickGenerateModel] = useState(effectiveConfig.imageModel || effectiveConfig.model);
    const [quickGenerateSize, setQuickGenerateSize] = useState(effectiveConfig.size || defaultConfig.size);
    const [quickGenerateQuality, setQuickGenerateQuality] = useState(effectiveConfig.quality || defaultConfig.quality);
    const [quickGenerateCount, setQuickGenerateCount] = useState(2);
    const [quickGenerateImageOptions, setQuickGenerateImageOptions] = useState(effectiveConfig.imageOptions || "");
    const [quickGenerateReferences, setQuickGenerateReferences] = useState<CanvasSelectionReference[]>([]);
    const [quickGenerateRunning, setQuickGenerateRunning] = useState(false);
    const quickSubmissionRef = useRef<symbol | null>(null);
    const quickOptimizedDraft = useRef<{ prompt: string; input: import("../../../../shared/prompt-contracts").PromptInputData; references: ReferenceImage[] } | undefined>(undefined);
    const onQuickOptimizedPrompt = useCallback((prompt: string, input: import("../../../../shared/prompt-contracts").PromptInputData, references: ReferenceImage[]) => { quickOptimizedDraft.current = { prompt, input, references: [...references] }; }, []);
    const loadedReuseTokenRef = useRef(new Set<string>());
    const quickGenerateRef = useRef<() => Promise<void>>(async () => undefined);

    useEffect(() => {
        setQuickGenerateModel((current) => current || effectiveConfig.imageModel || effectiveConfig.model);
        setQuickGenerateSize((current) => current || effectiveConfig.size || defaultConfig.size);
    }, [effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size]);

    const quickGenerateEstimate = useMemo(
        () => estimateUsage(canvasImageUsageInput(quickGenerateModel || effectiveConfig.imageModel || effectiveConfig.model, quickGenerateReferences.length)),
        [effectiveConfig.imageModel, effectiveConfig.model, estimateUsage, quickGenerateModel, quickGenerateReferences.length],
    );

    const handleQuickReferenceInputChange = useCallback(
        async (event: ReactChangeEvent<HTMLInputElement>) => {
            const maximum = validateImageReferences(modelOptionName(quickGenerateModel), quickGenerateReferences).maximum;
            const remaining = Math.max(0, maximum - quickGenerateReferences.length);
            const files = Array.from(event.target.files || [])
                .filter((file) => file.type.startsWith("image/"))
                .slice(0, remaining);
            event.target.value = "";
            if (!files.length) {
                message.warning(remaining ? "请选择图片文件" : maximum ? `当前模型最多添加 ${maximum} 张参考图` : "当前模型不支持参考图");
                return;
            }

            try {
                files.forEach(assertCanvasImageUploadSize);
                const uploaded = await Promise.all(
                    files.map(async (file) => {
                        const image = await uploadImage(file);
                        return {
                            id: nanoid(),
                            name: file.name,
                            originalFileName: file.name,
                            type: image.mimeType,
                            dataUrl: image.url,
                            url: image.url,
                            storageKey: image.storageKey,
                        } satisfies ReferenceImage;
                    }),
                );
                setQuickGenerateReferences((current) => [...current, ...uploaded]);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "参考图上传失败");
            }
        },
        [message, quickGenerateModel, quickGenerateReferences],
    );

    const runQuickCanvasGeneration = useCallback(async () => {
        if (quickSubmissionRef.current) return;
        const user = useUserStore.getState().user;
        const selectedModel = quickGenerateModel || effectiveConfig.imageModel || effectiveConfig.model;
        const toolKey = canvasToolKey("image", quickGenerateReferences.length > 0, imageModelProfile(selectedModel).kind);
        const model = currentToolConfig({ ...effectiveConfig, model: selectedModel }, toolKey).model;
        const modelId = modelOptionName(model);
        const profile = imageModelProfile(model);
        const prompt = profile.requiresPrompt ? quickGeneratePromptRef.current.trim() : "";
        const settings = normalizeImageModelSettings({ size: quickGenerateSize, quality: quickGenerateQuality, count: String(quickGenerateCount) }, profile);
        const count = Number(settings.count);
        const references = [...quickGenerateReferences];
        const operationType = references.length && profile.kind !== "midjourney-blend" ? "inpaint" : "image_generation";
        const toolMode = operationType === "inpaint" ? "image-edit" : "image-generation";
        const generationConfig: AiConfig = {
            ...effectiveConfig,
            model,
            imageModel: model,
            ...settings,
            imageOptions: quickGenerateImageOptions,
            count: "1",
            canvasImageCount: String(count),
        };
        const usage = estimateUsage({ operationType, toolKey, modelId, quantity: count });

        if (!prompt && profile.requiresPrompt) {
            message.error("请输入生图提示词");
            return;
        }
        const referenceValidation = validateImageReferences(modelId, references, profile);
        if (!referenceValidation.valid) {
            message.error(referenceValidation.message);
            return;
        }
        if (!isAiConfigReady(generationConfig, model)) {
            handleMissingModelConfig();
            return;
        }
        if (!user || user.status !== "active") {
            message.error("当前设计师账号不可用");
            return;
        }
        if (deploymentFeatures.creditsEnabled && usage.configured && user.creditBalance < usage.credits) {
            message.error(`额度不足：预计需要 ${usage.credits} 积分，当前剩余 ${user.creditBalance} 积分`);
            return;
        }

        const origin = getCanvasCenter();
        const imageSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        const nodeSize = nodeSizeFromRatio(generationConfig.size, imageSpec.width, imageSpec.height) || imageSpec;
        const gap = 36;
        const columns = Math.min(2, count);
        const rows = Math.ceil(count / columns);
        const sourceNodes = references.flatMap((reference) => reference.canvasNodeId ? nodesRef.current.filter((node) => node.id === reference.canvasNodeId) : []);
        const { x: startX, y: startY } = placeCanvasImageOutputs(nodesRef.current, sourceNodes, {
            width: columns * nodeSize.width + (columns - 1) * gap,
            height: rows * nodeSize.height + (rows - 1) * gap,
        }, origin, gap, quickGeneratePosition);
        const targetIds = Array.from({ length: count }, () => `quick-image-${nanoid()}`);
        const generationType: CanvasImageGenerationType = operationType === "inpaint" ? "edit" : "generation";
        const placeholders: CanvasNodeData[] = targetIds.map((id, index) => ({
            id,
            type: CanvasNodeType.Image,
            title: prompt.slice(0, 32) || "画布生图",
            position: {
                x: startX + (index % columns) * (nodeSize.width + gap),
                y: startY + Math.floor(index / columns) * (nodeSize.height + gap),
            },
            width: nodeSize.width,
            height: nodeSize.height,
            metadata: {
                prompt,
                status: NODE_STATUS_LOADING,
                ...buildImageGenerationMetadata(generationType, generationConfig, count, references),
            },
        }));
        const controller = new AbortController();
        const sourceUrls = references.map((reference) => reference.url || reference.dataUrl).filter(Boolean);
        let successCount = 0;
        let failureCount = 0;

        const submission = Symbol();
        quickSubmissionRef.current = submission;
        const awaitingSubmission = new Set(targetIds);
        const finishSubmission = (targetId: string) => {
            awaitingSubmission.delete(targetId);
            if (!awaitingSubmission.size && quickSubmissionRef.current === submission) {
                quickSubmissionRef.current = null;
                setQuickGenerateRunning(false);
            }
        };
        setQuickGenerateRunning(true);
        setNodes((current) => [...current, ...placeholders]);
        setQuickGeneratePosition(null);
        if (!sourceNodes.length) setSelectedNodeIds(new Set(targetIds));
        setSelectedConnectionId(null);
        setDialogNodeId(null);
        setRunningNodeId(targetIds[0]);
        targetIds.forEach((targetId) => startGenerationRequest(targetId, targetId, targetIds[0], controller));

        await Promise.all(
            targetIds.map(async (targetId, index) => {
                try {
                    const options = await createOptions(targetId, controller, () => finishSubmission(targetId), toolKey);
                    const optimized = quickOptimizedDraft.current;
                    const sameReferences = optimized?.references.length === references.length && optimized.references.every((image, index) => image.id === references[index]?.id && image.dataUrl === references[index]?.dataUrl && image.storageKey === references[index]?.storageKey);
                    const { metadata, uploaded } = await options.generate(generationConfig, prompt, references, undefined, operationType === "inpaint", optimized?.prompt === prompt && sameReferences ? optimized.input : undefined);
                    const resultSize = fitNodeSize(uploaded.width, uploaded.height, nodeSize.width, nodeSize.height);
                    setNodes((current) =>
                        current.map((node) =>
                            node.id === targetId
                                ? {
                                      ...node,
                                      position: quickGeneratePosition ? node.position : {
                                          x: node.position.x + node.width / 2 - resultSize.width / 2,
                                          y: node.position.y + node.height / 2 - resultSize.height / 2,
                                      },
                                      width: resultSize.width,
                                      height: resultSize.height,
                                      metadata: {
                                          ...node.metadata,
                                          ...metadata,
                                          prompt,
                                          ...buildImageGenerationMetadata(generationType, generationConfig, count, references),
                                      },
                                  }
                                : node,
                        ),
                    );
                    addAsset({
                        kind: "image",
                        title: count > 1 ? `${prompt.slice(0, 24) || "画布生图"} ${index + 1}` : prompt.slice(0, 28) || "画布生图",
                        coverUrl: uploaded.url,
                        tags: ["无线画布", references.length ? "参考图编辑" : "画布生图"],
                        source: "无线画布-画布生图",
                        data: { dataUrl: uploaded.url, storageKey: uploaded.storageKey, width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType },
                        metadata: {
                            source: "canvas",
                            module: "画布生图",
                            ...canvasImageReferenceIdentity(references[0]),
                            prompt,
                            model,
                            modelId,
                            projectId,
                            nodeId: targetId,
                            size: generationConfig.size,
                            referenceUrls: sourceUrls,
                            toolMode,
                            recreatePath: `/image${references.length ? "?tool=image-edit&" : "?"}prompt=${encodeURIComponent(prompt)}&model=${encodeURIComponent(model)}`,
                        },
                    });
                    successCount += 1;
                } catch (error) {
                    const reason = error instanceof Error ? error.message : "画布生图失败";
                    if (!isGenerationCanceled(error)) {
                        failureCount += 1;
                        setNodes((current) => current.map((node) => (node.id === targetId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails: reason } } : node)));
                    }
                } finally {
                    finishSubmission(targetId);
                    finishGenerationRequest(targetId, controller);
                }
            }),
        );

        setRunningNodeId((current) => current === targetIds[0] ? null : current);
        if (failureCount) {
            message.warning(`画布生图完成，成功 ${successCount} 张，失败 ${failureCount} 张`);
        } else {
            message.success(`画布生图完成：${successCount} 张`);
        }
    }, [
        addAsset,
        createOptions,
        effectiveConfig,
        estimateUsage,
        finishGenerationRequest,
        getCanvasCenter,
        handleMissingModelConfig,
        isAiConfigReady,
        message,
        projectId,
        quickGenerateCount,
        quickGenerateImageOptions,
        quickGenerateModel,
        quickGeneratePosition,
        quickGenerateReferences,
        quickGenerateSize,
        quickGenerateQuality,
        startGenerationRequest,
    ]);
    quickGenerateRef.current = runQuickCanvasGeneration;

    useEffect(() => {
        const token = searchParams.get("reuseToken");
        if (!projectLoaded || !token || loadedReuseTokenRef.current.has(token)) return;
        loadedReuseTokenRef.current.add(token);
        void hydratePromptReuse(token)
            .then(async (payload) => {
                const parameters = payload.template.parameters;
                const isBatch = payload.template.targetTool === "batch-edit" || searchParams.get("promptTool") === "batch-edit";
                const selectedModel = payload.pricing.selectedModel?.modelId || effectiveConfig.imageModel || effectiveConfig.model;
                const settings = promptImageSettings(parameters, selectedModel);
                if (isBatch) {
                    setBatchEditPrompt(payload.template.prompt);
                    setBatchImageSettings({ model: selectedModel, imageModel: selectedModel, ...settings });
                    setBatchEditOpen(true);
                } else {
                    setQuickGeneratePrompt(payload.template.prompt);
                    setQuickGenerateModel(selectedModel);
                    setQuickGenerateSize(settings.size);
                    setQuickGenerateQuality(settings.quality);
                    setQuickGenerateImageOptions(settings.imageOptions);
                    setQuickGenerateCount(Math.min(4, Number(settings.count)));
                    const nextReferences = await Promise.all(
                        payload.template.referenceAssetIds.map(async (assetId) => {
                            const blob = await fetchServerAssetContent(assetId);
                            const image = await uploadImage(blob);
                            return { id: nanoid(), name: "模板参考图.png", type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, sourceAssetId: assetId };
                        }),
                    );
                    setQuickGenerateReferences(nextReferences);
                    setQuickGenerateOpen(true);
                }
                payload.warnings.forEach((warning) => message.warning(warning));
                if (payload.pricing.modelChanged) message.warning(payload.pricing.selectedModel ? `模型已变更，当前使用 ${payload.pricing.selectedModel.name}` : "模型已变更，请选择管理员当前启用的模型");
                const cost = !deploymentFeatures.creditsEnabled ? "不计积分" : (payload.pricing.estimate ? `${payload.pricing.estimate.totalCredits} 积分` : "以当前选择为准");
                if (payload.mode === "fill_and_generate" && !isBatch) {
                    modal.confirm({ title: "确认在画布生成？", content: `当前实际预计消耗 ${cost}。确认后才会提交任务并扣费。`, okText: "确认生成", cancelText: "仅保留填入", onOk: () => quickGenerateRef.current() });
                } else if (payload.mode === "fill_and_generate" && isBatch) {
                    message.info(`模板已填入，当前预计 ${cost}。请先选择文件夹，再确认批量生成。`);
                } else message.success(`模板已填入，当前预计 ${cost}`);
            })
            .catch((error) => {
                loadedReuseTokenRef.current.delete(token);
                message.error(error instanceof Error ? error.message : "模板复用失败");
            });
    }, [message, modal, projectLoaded, searchParams]);

    return {
        quickGenerateOpen, setQuickGenerateOpen, quickGeneratePromptRef, quickGeneratePromptRevision,
        setQuickGeneratePrompt, quickGeneratePosition, setQuickGeneratePosition, quickGenerateModel,
        setQuickGenerateModel, quickGenerateSize, setQuickGenerateSize, quickGenerateQuality,
        setQuickGenerateQuality, quickGenerateCount, setQuickGenerateCount, quickGenerateImageOptions,
        setQuickGenerateImageOptions, quickGenerateReferences, setQuickGenerateReferences, quickGenerateRunning,
        setQuickGenerateRunning, quickGenerateEstimate, onQuickOptimizedPrompt, handleQuickReferenceInputChange,
        runQuickCanvasGeneration,
    };
}
