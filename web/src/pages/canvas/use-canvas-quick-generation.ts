import { uiText } from "@/lib/i18n";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { canvasToolKey, currentToolConfig } from "@/hooks/use-tool-config";
import { canvasImageReferenceIdentity } from "@/lib/canvas/canvas-image-filename";
import { placeCanvasImageOutputs } from "@/lib/canvas/canvas-image-output-placement";
import { assertCanvasImageUploadSize } from "@/lib/canvas/canvas-image-upload-limit";
import { canvasImageUsageInput } from "@/lib/canvas/canvas-image-usage";
import { canvasGenerationEditorState, storeCanvasEditorReferences } from "@/lib/canvas/canvas-generation-editor";
import type { CanvasQuickGenerateSettings } from "@/lib/canvas/canvas-quick-generate-render-stability";
import { createCanvasGenerationRecord, hasIncompleteCanvasGenerationReferences } from "@/lib/canvas/canvas-generation-record";
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
import { useCanvasPanelStore } from "@/stores/canvas/use-canvas-panel-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { defaultConfig, modelOptionName, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType, type CanvasConnection, type CanvasImageGenerationType, type CanvasNodeData, type CanvasNodeMetadata, type Position } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import { App } from "antd";
import { nanoid } from "nanoid";
import type { Dispatch, ChangeEvent as ReactChangeEvent, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { buildImageGenerationMetadata, isGenerationCanceled } from "./canvas-project-utils";
import { useCanvasBatchEdit } from "./use-canvas-batch-edit";
import { useCanvasGenerationRuntime } from "./use-canvas-generation-runtime";
type CanvasQuickGenerationOptions = {
    projectId: string;
    projectLoaded: boolean;
    nodesRef: RefObject<CanvasNodeData[]>;
    connectionsRef?: RefObject<CanvasConnection[]>;
    flushPendingHistoryRef?: RefObject<(() => void) | null>;
    runtime: ReturnType<typeof useCanvasGenerationRuntime>;
    batchEdit: Pick<ReturnType<typeof useCanvasBatchEdit>, "setBatchEditPrompt" | "setBatchImageSettings" | "setBatchEditOpen">;
    setDialogNodeId: Dispatch<SetStateAction<string | null>>;
    getCanvasCenter: () => Position;
    handleMissingModelConfig: () => void;
    isAiConfigReady: (...args: unknown[]) => boolean;
};

export function useCanvasQuickGeneration({ projectId, projectLoaded, nodesRef, connectionsRef, flushPendingHistoryRef, runtime, batchEdit, setDialogNodeId, getCanvasCenter, handleMissingModelConfig, isAiConfigReady }: CanvasQuickGenerationOptions) {
    const { message, modal } = App.useApp();
    const [searchParams] = useSearchParams();
    const effectiveConfig = useEffectiveConfig();
    const estimateUsage = useBusinessConfigStore(state => state.estimate);
    const addAsset = useAssetStore(state => state.addAsset);
    const setNodes = useCanvasGraphSetter("nodes");
    const setConnections = useCanvasGraphSetter("connections");
    const setSelectedNodeIds = useCanvasGraphSetter("selectedNodeIds");
    const setSelectedConnectionId = useCanvasGraphSetter("selectedConnectionId");
    const { createOptions, startGenerationRequest, finishGenerationRequest, setRunningNodeId } = runtime;
    const { setBatchEditPrompt, setBatchImageSettings, setBatchEditOpen } = batchEdit;
    const NODE_STATUS_LOADING = "loading" as const;
    const NODE_STATUS_ERROR = "error" as const;
    const quickGenerateOpen = useCanvasPanelStore(state => state.creationOpen);
    const setQuickGenerateOpen = useCanvasPanelStore(state => state.setCreationOpen);
    const referenceOwner = useUserStore(state => `${state.status}:${state.user?.id || ""}`);
    const draftScope = `${projectId}:${referenceOwner}`;
    const currentDraftScopeRef = useRef(draftScope);
    currentDraftScopeRef.current = draftScope;
    const nodeDraftBindingRef = useRef<{ nodeId: string; scope: string } | null>(null);
    const pendingNodePromptRef = useRef<{ nodeId: string; scope: string; prompt: string; timer: ReturnType<typeof setTimeout> } | null>(null);
    const [quickGenerateNodeId, setQuickGenerateNodeId] = useState<string | null>(null);
    const patchNodeDraft = useCallback((patch: Partial<CanvasNodeMetadata>, binding = nodeDraftBindingRef.current) => {
        if (!binding || binding.scope !== currentDraftScopeRef.current) return;
        const account = useUserStore.getState();
        if (binding.scope !== `${projectId}:${account.status}:${account.user?.id || ""}`) return;
        setNodes(current => {
            let changed = false;
            const next = current.map(node => {
                if (node.id !== binding.nodeId || !Object.entries(patch).some(([key, value]) => node.metadata?.[key as keyof CanvasNodeMetadata] !== value)) return node;
                changed = true;
                return { ...node, metadata: { ...node.metadata, ...patch } };
            });
            if (changed) nodesRef.current = next;
            return changed ? next : current;
        });
    }, [nodesRef, projectId, setNodes]);
    const flushQuickNodeDraft = useCallback(() => {
        const pending = pendingNodePromptRef.current;
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingNodePromptRef.current = null;
        patchNodeDraft({ draftPrompt: pending.prompt }, pending);
    }, [patchNodeDraft]);
    const quickGeneratePromptRef = useRef("");
    const [quickGeneratePromptRevision, setQuickGeneratePromptRevision] = useState(0);
    const setQuickGeneratePrompt = useCallback((value: string) => {
        quickGeneratePromptRef.current = value;
        setQuickGeneratePromptRevision((revision) => revision + 1);
    }, []);
    const [quickGeneratePosition, setQuickGeneratePosition] = useState<Position | null>(null);
    const [quickGenerateModel, setQuickGenerateModelState] = useState(effectiveConfig.imageModel || effectiveConfig.model);
    const [quickGenerateSize, setQuickGenerateSizeState] = useState(effectiveConfig.size || defaultConfig.size);
    const [quickGenerateQuality, setQuickGenerateQualityState] = useState(effectiveConfig.quality || defaultConfig.quality);
    const [quickGenerateCount, setQuickGenerateCountState] = useState(2);
    const [quickGenerateImageOptions, setQuickGenerateImageOptionsState] = useState(effectiveConfig.imageOptions || "");
    const [quickGenerateReferences, setQuickGenerateReferencesState] = useState<CanvasSelectionReference[]>([]);
    const quickReferencesRef = useRef(quickGenerateReferences);
    const setQuickGenerateModel = useCallback((value: string) => { setQuickGenerateModelState(value); patchNodeDraft({ model: value }); }, [patchNodeDraft]);
    const setQuickGenerateSize = useCallback((value: string) => { setQuickGenerateSizeState(value); patchNodeDraft({ size: value }); }, [patchNodeDraft]);
    const setQuickGenerateQuality = useCallback((value: string) => { setQuickGenerateQualityState(value); patchNodeDraft({ quality: value }); }, [patchNodeDraft]);
    const setQuickGenerateCount = useCallback((value: number) => { setQuickGenerateCountState(value); patchNodeDraft({ count: value }); }, [patchNodeDraft]);
    const setQuickGenerateImageOptions = useCallback((value: string) => { setQuickGenerateImageOptionsState(value); patchNodeDraft({ imageOptions: value }); }, [patchNodeDraft]);
    // Normalization only adapts the live form. Loading a historical node must not
    // fill missing metadata or rewrite its saved inputs. Reject effects from an
    // earlier binding, including A -> B -> A switches before effects finish.
    const normalizationBinding = nodeDraftBindingRef.current;
    const normalizeQuickGenerateSettings = useCallback((settings: Partial<CanvasQuickGenerateSettings>) => {
        if (normalizationBinding !== nodeDraftBindingRef.current || draftScope !== currentDraftScopeRef.current) return;
        const account = useUserStore.getState();
        if (draftScope !== `${projectId}:${account.status}:${account.user?.id || ""}`) return;
        if (settings.model !== undefined) setQuickGenerateModelState(settings.model);
        if (settings.size !== undefined) setQuickGenerateSizeState(settings.size);
        if (settings.quality !== undefined) setQuickGenerateQualityState(settings.quality);
        if (settings.count !== undefined) setQuickGenerateCountState(settings.count);
        if (settings.imageOptions !== undefined) setQuickGenerateImageOptionsState(settings.imageOptions);
    }, [draftScope, normalizationBinding, projectId]);
    const setQuickGenerateReferences = useCallback((update: SetStateAction<CanvasSelectionReference[]>) => {
        const next = typeof update === "function" ? update(quickReferencesRef.current) : update;
        if (next === quickReferencesRef.current) return;
        quickReferencesRef.current = next;
        setQuickGenerateReferencesState(next);
        patchNodeDraft({ draftImageReferences: storeCanvasEditorReferences(next) });
    }, [patchNodeDraft]);
    const onQuickPromptChange = useCallback((prompt: string) => {
        quickGeneratePromptRef.current = prompt;
        const binding = nodeDraftBindingRef.current;
        const pending = pendingNodePromptRef.current;
        if (pending) clearTimeout(pending.timer);
        pendingNodePromptRef.current = binding ? { ...binding, prompt, timer: setTimeout(flushQuickNodeDraft, 180) } : null;
    }, [flushQuickNodeDraft]);
    const loadQuickGenerationNode = useCallback((node: CanvasNodeData | null) => {
        // Commit the old node before rebinding; rapid selection must never move a draft to its neighbor.
        const pending = pendingNodePromptRef.current;
        flushQuickNodeDraft();
        referenceRead.current = null;
        setQuickReferencesLoading(false);
        nodeDraftBindingRef.current = node ? { nodeId: node.id, scope: currentDraftScopeRef.current } : null;
        setQuickGenerateNodeId(node?.id || null);
        if (!node) return;
        const state = canvasGenerationEditorState(node, nodesRef.current, connectionsRef?.current || [], effectiveConfig);
        setQuickGeneratePrompt(pending?.nodeId === node.id && pending.scope === currentDraftScopeRef.current ? pending.prompt : state.prompt);
        setQuickGenerateModelState(state.model);
        setQuickGenerateSizeState(state.size);
        setQuickGenerateQualityState(state.quality);
        setQuickGenerateCountState(state.count);
        setQuickGenerateImageOptionsState(state.imageOptions);
        quickReferencesRef.current = state.references;
        setQuickGenerateReferencesState(state.references);
    }, [connectionsRef, effectiveConfig, flushQuickNodeDraft, nodesRef, setQuickGeneratePrompt]);
    useEffect(() => () => flushQuickNodeDraft(), [flushQuickNodeDraft]);
    useLayoutEffect(() => {
        nodeDraftBindingRef.current = null;
        if (pendingNodePromptRef.current) clearTimeout(pendingNodePromptRef.current.timer);
        pendingNodePromptRef.current = null;
        setQuickGenerateNodeId(null);
    }, [draftScope]);
    const [quickGenerateRunning, setQuickGenerateRunning] = useState(false);
    const [quickReferencesLoading, setQuickReferencesLoading] = useState(false);
    const referenceScope = `${draftScope}:${quickGenerateNodeId || "creation"}`;
    const referenceRead = useRef<symbol | null>(null);
    const referenceContext = useRef({ scope: referenceScope, running: quickGenerateRunning, model: quickGenerateModel, references: quickGenerateReferences });
    useLayoutEffect(() => { referenceContext.current = { scope: referenceScope, running: quickGenerateRunning, model: quickGenerateModel, references: quickGenerateReferences }; });
    useLayoutEffect(() => {
        referenceRead.current = null;
        setQuickReferencesLoading(false);
        return () => { referenceRead.current = null; };
    }, [referenceScope]);
    const quickSubmissionRef = useRef<symbol | null>(null);
    const quickOptimizedDraft = useRef<{ prompt: string; input: import("../../../../shared/prompt-contracts").PromptInputData; references: ReferenceImage[] } | undefined>(undefined);
    const onQuickOptimizedPrompt = useCallback((prompt: string, input: import("../../../../shared/prompt-contracts").PromptInputData, references: ReferenceImage[]) => { quickOptimizedDraft.current = { prompt, input, references: [...references] }; }, []);
    const loadedReuseTokenRef = useRef(new Set<string>());
    const quickGenerateRef = useRef<() => Promise<void>>(async () => undefined);

    useEffect(() => {
        setQuickGenerateModelState((current) => current || effectiveConfig.imageModel || effectiveConfig.model);
        setQuickGenerateSizeState((current) => current || effectiveConfig.size || defaultConfig.size);
    }, [effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size]);

    const quickGenerateEstimate = useMemo(
        () => estimateUsage(canvasImageUsageInput(quickGenerateModel || effectiveConfig.imageModel || effectiveConfig.model, quickGenerateReferences.length)),
        [effectiveConfig.imageModel, effectiveConfig.model, estimateUsage, quickGenerateModel, quickGenerateReferences.length],
    );

    const addQuickReferenceFiles = useCallback(
        async (input: File[]) => {
            if (quickGenerateRunning || referenceRead.current) return;
            const maximum = validateImageReferences(modelOptionName(quickGenerateModel), quickGenerateReferences).maximum;
            const remaining = Math.max(0, maximum - quickGenerateReferences.length);
            const files = input
                .filter((file) => file.type.startsWith("image/"))
                .slice(0, remaining);
            if (!files.length) {
                message.warning(remaining ? uiText("请选择图片文件") : maximum ? uiText("当前模型最多添加 {value1} 张参考图", { value1: maximum }) : uiText("当前模型不支持参考图"));
                return;
            }

            const token = Symbol();
            referenceRead.current = token;
            setQuickReferencesLoading(true);
            const current = () => {
                const account = useUserStore.getState();
                return referenceRead.current === token && referenceContext.current.scope === referenceScope && !referenceContext.current.running
                    && `${account.status}:${account.user?.id || ""}` === referenceOwner;
            };
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
                if (!current()) return;
                const latest = referenceContext.current;
                const slots = Math.max(0, validateImageReferences(modelOptionName(latest.model), latest.references).maximum - latest.references.length);
                setQuickGenerateReferences((references) => [...references, ...uploaded.slice(0, slots)]);
            } catch (error) {
                if (current()) message.error(error instanceof Error ? error.message : uiText("参考图上传失败"));
            } finally {
                if (referenceRead.current === token) { referenceRead.current = null; setQuickReferencesLoading(false); }
            }
        },
        [message, quickGenerateModel, quickGenerateReferences, quickGenerateRunning, referenceOwner, referenceScope],
    );
    const handleQuickReferenceInputChange = useCallback((event: ReactChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files || []);
        event.target.value = "";
        void addQuickReferenceFiles(files);
    }, [addQuickReferenceFiles]);

    const runQuickCanvasGeneration = useCallback(async () => {
        if (quickSubmissionRef.current || referenceRead.current) return;
        flushQuickNodeDraft();
        const user = useUserStore.getState().user;
        const sourceNode = nodeDraftBindingRef.current?.scope === currentDraftScopeRef.current ? nodesRef.current.find(node => node.id === nodeDraftBindingRef.current?.nodeId) : undefined;
        if (sourceNode && sourceNode.metadata?.draftImageReferences === undefined && hasIncompleteCanvasGenerationReferences(sourceNode)) {
            message.warning(uiText("旧版记录参考信息不完整，请先恢复历史输入或明确设置新的参考图"));
            return;
        }
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
            systemPrompt: sourceNode?.metadata?.systemPrompt ?? sourceNode?.metadata?.generationRecord?.parameters.systemPrompt ?? effectiveConfig.systemPrompt,
            model,
            imageModel: model,
            ...settings,
            imageOptions: quickGenerateImageOptions,
            count: "1",
            canvasImageCount: String(count),
        };
        const usage = estimateUsage({ operationType, toolKey, modelId, quantity: count });

        if (!prompt && profile.requiresPrompt) {
            message.error(uiText("请输入生图提示词"));
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
            message.error(uiText("当前设计师账号不可用"));
            return;
        }
        if (deploymentFeatures.creditsEnabled && usage.configured && user.creditBalance < usage.credits) {
            message.error(uiText("额度不足：预计需要 {value1} 积分，当前剩余 {value2} 积分", { value1: usage.credits, value2: user.creditBalance }));
            return;
        }

        const origin = getCanvasCenter();
        const imageSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        const nodeSize = nodeSizeFromRatio(generationConfig.size, imageSpec.width, imageSpec.height) || imageSpec;
        const gap = 36;
        const columns = Math.min(2, count);
        const rows = Math.ceil(count / columns);
        const sourceNodes = sourceNode ? [sourceNode] : references.flatMap((reference) => reference.canvasNodeId ? nodesRef.current.filter((node) => node.id === reference.canvasNodeId) : []);
        const { x: startX, y: startY } = placeCanvasImageOutputs(nodesRef.current, sourceNodes, {
            width: columns * nodeSize.width + (columns - 1) * gap,
            height: rows * nodeSize.height + (rows - 1) * gap,
        }, origin, gap, quickGeneratePosition);
        const targetIds = Array.from({ length: count }, () => `quick-image-${nanoid()}`);
        const runId = nanoid();
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
                generationRecord: createCanvasGenerationRecord({ id: `${runId}:${index}`, sourceNodeId: sourceNode?.id || sourceNodes[0]?.id || "", prompt, inputPrompt: prompt, references, nodes: nodesRef.current, config: generationConfig, generationType }),
                ...(sourceNode ? { generationOrigin: { sourceNodeId: sourceNode.id, runId, mode: "image" as const } } : {}),
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
        flushPendingHistoryRef?.current?.();
        setNodes((current) => [...current, ...placeholders]);
        if (sourceNode) setConnections(current => [...current, ...targetIds.map(targetId => ({ id: `conn-${nanoid()}`, kind: "generation-output" as const, fromNodeId: sourceNode.id, toNodeId: targetId }))]);
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
                                          prompt: metadata.prompt ?? prompt,
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
            message.warning(uiText("画布生图完成，成功 {value1} 张，失败 {value2} 张", { value1: successCount, value2: failureCount }));
        } else {
            message.success(uiText("画布生图完成：{value1} 张", { value1: successCount }));
        }
    }, [
        addAsset,
        createOptions,
        effectiveConfig,
        estimateUsage,
        finishGenerationRequest,
        flushPendingHistoryRef,
        flushQuickNodeDraft,
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
                    loadQuickGenerationNode(null);
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
                if (payload.pricing.modelChanged) message.warning(payload.pricing.selectedModel ? uiText("模型已变更，当前使用 {value1}", { value1: payload.pricing.selectedModel.name }) : uiText("模型已变更，请选择管理员当前启用的模型"));
                const cost = !deploymentFeatures.creditsEnabled ? "不计积分" : (payload.pricing.estimate ? `${payload.pricing.estimate.totalCredits} 积分` : "以当前选择为准");
                if (payload.mode === "fill_and_generate" && !isBatch) {
                    modal.confirm({ title: uiText("确认在画布生成？"), content: uiText("当前实际预计消耗 {value1}。确认后才会提交任务并扣费。", { value1: cost }), okText: uiText("确认生成"), cancelText: uiText("仅保留填入"), onOk: () => quickGenerateRef.current() });
                } else if (payload.mode === "fill_and_generate" && isBatch) {
                    message.info(uiText("模板已填入，当前预计 {value1}。请先选择文件夹，再确认批量生成。", { value1: cost }));
                } else message.success(uiText("模板已填入，当前预计 {value1}", { value1: cost }));
            })
            .catch((error) => {
                loadedReuseTokenRef.current.delete(token);
                message.error(error instanceof Error ? error.message : uiText("模板复用失败"));
            });
    }, [message, modal, projectLoaded, searchParams]);

    return {
        quickGenerateOpen, setQuickGenerateOpen, quickGeneratePromptRef, quickGeneratePromptRevision,
        quickGenerateNodeId, loadQuickGenerationNode, onQuickPromptChange, flushQuickNodeDraft,
        setQuickGeneratePrompt, quickGeneratePosition, setQuickGeneratePosition, quickGenerateModel,
        setQuickGenerateModel, quickGenerateSize, setQuickGenerateSize, quickGenerateQuality,
        setQuickGenerateQuality, quickGenerateCount, setQuickGenerateCount, quickGenerateImageOptions,
        setQuickGenerateImageOptions, quickGenerateReferences, setQuickGenerateReferences, quickGenerateRunning,
        normalizeQuickGenerateSettings,
        setQuickGenerateRunning, quickGenerateEstimate, onQuickOptimizedPrompt, handleQuickReferenceInputChange, addQuickReferenceFiles, quickReferencesLoading,
        runQuickCanvasGeneration,
    };
}
