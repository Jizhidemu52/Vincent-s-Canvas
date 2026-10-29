import { uiText } from "@/lib/i18n";
import type { CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import type { CanvasImageCropRect } from "@/components/canvas/canvas-node-crop-dialog";
import type { CanvasImageMaskEditPayload } from "@/components/canvas/canvas-node-mask-edit-dialog";
import type { CanvasImageSplitParams } from "@/components/canvas/canvas-node-split-dialog";
import type { CanvasImageUpscaleParams } from "@/components/canvas/canvas-node-upscale-dialog";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { currentToolConfig } from "@/hooks/use-tool-config";
import { mapCanvasAsyncPool } from "@/lib/canvas/canvas-async-pool";
import { canvasCompareSource } from "@/lib/canvas/canvas-image-compare-source";
import { canvasImageBaseName, canvasImageVersion, originalCanvasImageFileName } from "@/lib/canvas/canvas-image-filename";
import { createCanvasImageOperationRunner } from "@/lib/canvas/canvas-image-operation";
import { loadCanvasImageTools } from "@/lib/canvas/canvas-image-tool-loader";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { deploymentFeatures } from "@/lib/deployment-features";
import { imageModelProfile } from "@/lib/image-model-settings";
import { uploadImage, type UploadedImage } from "@/services/image-storage";
import { useCanvasGraphSetter } from "@/stores/canvas/canvas-graph-store";
import { flushCanvasPersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { modelOptionName, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType, type CanvasNodeData, type ContextMenuState } from "@/types/canvas";
import { App } from "antd";
import { nanoid } from "nanoid";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useMemo } from "react";
import { buildAngleLabel, buildAnglePrompt, buildGenerationConfig, buildImageGenerationMetadata, createCanvasNode, imageMetadata, isGenerationCanceled } from "./canvas-project-utils";
import { useCanvasDialogs } from "./use-canvas-dialogs";
import { useCanvasGenerationRuntime } from "./use-canvas-generation-runtime";
type CanvasImageActionsOptions = {
    projectId: string;
    nodesRef: RefObject<CanvasNodeData[]>;
    designProjectIdRef: RefObject<string>;
    savedProjectIdRef: RefObject<string>;
    projectSaveQueueRef: RefObject<{ flush(): void } | null>;
    runtime: ReturnType<typeof useCanvasGenerationRuntime>;
    dialogs: ReturnType<typeof useCanvasDialogs>;
    setDialogNodeId: Dispatch<SetStateAction<string | null>>;
    setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
    handleMissingModelConfig: () => void;
    isAiConfigReady: (...args: unknown[]) => boolean;
};

export function useCanvasImageActions({ projectId, nodesRef, designProjectIdRef, savedProjectIdRef, projectSaveQueueRef, runtime, dialogs, setDialogNodeId, setContextMenu, handleMissingModelConfig, isAiConfigReady }: CanvasImageActionsOptions) {
    const { message } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const estimateUsage = useBusinessConfigStore(state => state.estimate);
    const addAsset = useAssetStore(state => state.addAsset);
    const updateProject = useCanvasStore(state => state.updateProject);
    const setNodes = useCanvasGraphSetter("nodes");
    const setConnections = useCanvasGraphSetter("connections");
    const setSelectedNodeIds = useCanvasGraphSetter("selectedNodeIds");
    const setSelectedConnectionId = useCanvasGraphSetter("selectedConnectionId");
    const { createOptions, generationDispatchLocksRef, startGenerationRequest, finishGenerationRequest, setRunningNodeId } = runtime;
    const { manualEditNode, setCropNodeId, setSplitNodeId, setMaskEditNodeId, setUpscaleNodeId, setAngleNodeId } = dialogs;
    const NODE_STATUS_LOADING = "loading" as const;
    const NODE_STATUS_SUCCESS = "success" as const;
    const NODE_STATUS_ERROR = "error" as const;
    const imageOperationRunner = useMemo(() => createCanvasImageOperationRunner(), [projectId]);
    useEffect(() => () => imageOperationRunner.cancelAll(), [imageOperationRunner]);
    const runLocalImageOperation = useCallback((key: string, label: string, task: (signal: AbortSignal) => Promise<void>) => {
        const messageKey = `canvas-image:${projectId}:${key}`;
        return imageOperationRunner.run(key, task, {
            start: () => { void message.loading({ key: messageKey, content: uiText("{value1}中…", { value1: uiText(label) }), duration: 0 }); },
            error: (error) => { void message.error(uiText("{value1}失败：{value2}", { value1: uiText(label), value2: error instanceof Error ? error.message : uiText("请重试") })); },
            finish: () => message.destroy(messageKey),
        });
    }, [imageOperationRunner, message, projectId]);

    const createImageReversePromptNodes = useCallback(
        async (node: CanvasNodeData) => {
            if (node.type !== CanvasNodeType.Image || !(node.metadata?.content || node.metadata?.storageKey)) { message.warning(uiText("图片节点为空，无法反推提示词")); return; }
            const key = `reverse-prompt:${node.id}`;
            if (generationDispatchLocksRef.current.has(key)) return;
            generationDispatchLocksRef.current.add(key);
            const pending = nodesRef.current.find(item => item.id === node.id)?.metadata?.reversePrompt;
            const requestId = pending?.requestId || nanoid();
            const textNode = pending ? nodesRef.current.find(item => item.id === pending.outputNodeId) : {
                ...createCanvasNode(CanvasNodeType.Text, { x: node.position.x + node.width + 96 + NODE_DEFAULT_SIZE[CanvasNodeType.Text].width / 2, y: node.position.y + node.height / 2 }, { content: "正在分析图片并优化提示词…", status: NODE_STATUS_LOADING, fontSize: 14 }),
                title: "反推提示词",
            };
            if (!textNode) { generationDispatchLocksRef.current.delete(key); message.error(uiText("原反推结果节点已移除，请先恢复该节点")); return; }
            const ownerId = useUserStore.getState().user?.id;
            const current = () => designProjectIdRef.current === projectId && useUserStore.getState().user?.id === ownerId;
            if (!pending) setNodes(prev => [...prev.map(item => item.id === node.id ? { ...item, metadata: { ...item.metadata, reversePrompt: { requestId, outputNodeId: textNode.id } } } : item), textNode]);
            setContextMenu(null); setSelectedNodeIds(new Set([textNode.id]));
            try {
                const { optimizeImagePrompt } = await import("@/services/api/image");
                const { completedPromptCompilation, getPromptCompilation } = await import("@/services/api/prompt-compilations");
                const result = pending ? completedPromptCompilation(await getPromptCompilation(requestId), requestId)
                    : await optimizeImagePrompt({ ...effectiveConfig, model: effectiveConfig.imageModel || effectiveConfig.model }, { scene: "reverse-prompt", fields: {}, userText: "", referenceRoles: ["待反推图片"], mode: "edit" }, [{ id: node.id, name: node.title, dataUrl: node.metadata?.content || "", storageKey: node.metadata?.storageKey, type: node.metadata?.mimeType || "image/png" }], { requestId, toolKey: "canvas-edit" });
                if (!current()) return;
                setNodes(prev => prev.map(item => item.id === textNode.id ? { ...item, metadata: { ...item.metadata, content: [result.prompt, result.summaryZh].filter(Boolean).join("\n\n"), prompt: result.prompt, optimized: result.optimized, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : item));
                setDialogNodeId(textNode.id);
            } catch (error) {
                if (current()) { const detail = error instanceof Error ? error.message : "反推提示词失败"; message.error(detail); setNodes(prev => prev.map(item => item.id === textNode.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: detail, content: detail } } : item)); }
            } finally { generationDispatchLocksRef.current.delete(key); }
        },
        [effectiveConfig, message, projectId],
    );

    const saveManualImageEdit = async (image: UploadedImage) => {
        if (!manualEditNode || savedProjectIdRef.current !== projectId) throw new Error("画布已切换，请重新打开图片编辑");
        const { applyCanvasImageEdit, rollbackCanvasImageEdit } = await import("@/lib/canvas/canvas-image-edit");
        if (savedProjectIdRef.current !== projectId) throw new Error("画布已切换，请重新打开图片编辑");
        const before = nodesRef.current;
        const next = applyCanvasImageEdit(before, manualEditNode, image);
        projectSaveQueueRef.current?.flush();
        nodesRef.current = next;
        setNodes(next);
        updateProject(projectId, { nodes: next });
        try { await flushCanvasPersistence(); }
        catch (error) {
            if (savedProjectIdRef.current === projectId) {
                const restored = rollbackCanvasImageEdit(nodesRef.current, before, image.storageKey);
                projectSaveQueueRef.current?.flush();
                nodesRef.current = restored;
                setNodes(restored);
                updateProject(projectId, { nodes: restored });
            }
            throw error;
        }
    };

    const cropImageNode = useCallback(async (node: CanvasNodeData, crop: CanvasImageCropRect) => {
        if (!node.metadata?.content) return;
        const source = node.metadata.content;
        await runLocalImageOperation(`crop:${node.id}`, "裁剪图片", async (signal) => {
            const { cropImageBlob } = await loadCanvasImageTools();
            const cropped = await cropImageBlob(source, crop, { signal });
            signal.throwIfAborted();
            const image = await uploadImage(cropped);
            signal.throwIfAborted();
            const width = Math.min(node.width, Math.max(220, image.width));
            const childId = nanoid();
            const child: CanvasNodeData = {
                id: childId,
                type: CanvasNodeType.Image,
                title: "Cropped Image",
                position: { x: node.position.x + node.width + 96, y: node.position.y },
                width,
                height: width * (image.height / image.width),
                metadata: {
                    ...imageMetadata(image),
                    compareSources: [canvasCompareSource(node.metadata || {})],
                    originalFileName: originalCanvasImageFileName(node),
                    imageName: canvasImageBaseName(node), imageVersion: canvasImageVersion(node) + 1,
                    prompt: node.metadata?.prompt,
                },
            };
            setNodes((prev) => [...prev, child]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
            setCropNodeId(null);
        });
    }, [runLocalImageOperation]);

    const splitImageNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageSplitParams) => {
            if (!node.metadata?.content) return;
            const source = node.metadata.content;
            await runLocalImageOperation(`split:${node.id}`, "切分图片", async (signal) => {
                setSplitNodeId(null);
                const { splitImageBlobs } = await loadCanvasImageTools();
                const pieces = await splitImageBlobs(source, params, { signal });
                signal.throwIfAborted();
                const gap = 16;
                const cellWidth = node.width / params.columns;
                const cellHeight = node.height / params.rows;
                const startX = node.position.x + node.width + 96;
                const startY = node.position.y;
                const childNodes = await mapCanvasAsyncPool(
                    pieces, 4, async (piece) => {
                        signal.throwIfAborted();
                        const image = await uploadImage(piece.blob);
                        signal.throwIfAborted();
                        const id = nanoid();
                        return {
                            id,
                            type: CanvasNodeType.Image,
                            title: `${node.title || "图片"} ${piece.row + 1}-${piece.column + 1}`,
                            position: { x: startX + piece.column * (cellWidth + gap), y: startY + piece.row * (cellHeight + gap) },
                            width: cellWidth,
                            height: cellHeight,
                            metadata: {
                                ...imageMetadata(image),
                                compareSources: [canvasCompareSource(node.metadata || {})],
                                originalFileName: originalCanvasImageFileName(node),
                                imageName: `${canvasImageBaseName(node)} ${piece.row + 1}-${piece.column + 1}`, imageVersion: canvasImageVersion(node) + 1,
                                prompt: node.metadata?.prompt,
                            },
                        } satisfies CanvasNodeData;
                    },
                );
                signal.throwIfAborted();
                setNodes((prev) => [...prev, ...childNodes]);
                setConnections((prev) => [...prev, ...childNodes.map((child) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: child.id }))]);
                setSelectedNodeIds(new Set(childNodes.map((child) => child.id)));
                setSelectedConnectionId(null);
                setDialogNodeId(null);
                message.success(uiText("已切分为 {value1} 个子节点", { value1: childNodes.length }));
            });
        },
        [message, runLocalImageOperation],
    );

    const maskEditImageNode = useCallback(
        async (node: CanvasNodeData, payload: CanvasImageMaskEditPayload) => {
            if (!node.metadata?.content) return;
            const user = useUserStore.getState().user;
            const selectedModel = currentToolConfig({ ...effectiveConfig, model: payload.model || effectiveConfig.imageModel || effectiveConfig.model }, "canvas-mask-edit").model;
            const usage = estimateUsage({ operationType: "inpaint", toolKey: "canvas-mask-edit", modelId: modelOptionName(selectedModel), quantity: 1 });
            let generationConfig: AiConfig;
            try {
                const { canvasMaskEditImageSettings, readCanvasMaskImageSize } = await import("@/components/canvas/canvas-node-mask-edit-dialog");
                const [sourceSize, maskSize] = await Promise.all([readCanvasMaskImageSize(node.metadata.content), readCanvasMaskImageSize(payload.maskDataUrl)]);
                if (sourceSize.width !== maskSize.width || sourceSize.height !== maskSize.height) throw new Error("蒙版尺寸与当前原图不一致，请重新绘制；尚未提交生成，不会自动拉伸。");
                const baseConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), ...payload.imageSettings };
                generationConfig = { ...baseConfig, ...canvasMaskEditImageSettings(baseConfig, sourceSize, imageModelProfile(selectedModel)), model: selectedModel, imageModel: selectedModel, count: "1" };
            } catch (error) {
                message.error(error instanceof Error ? error.message : uiText("无法确认原图与蒙版尺寸，尚未提交生成"));
                return;
            }
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                handleMissingModelConfig();
                return;
            }
            if (!usage.configured) {
                message.error(uiText("管理员尚未为该局部编辑模型启用价格或接口"));
                return;
            }
            if (!user || user.status !== "active") {
                message.error(uiText("当前设计师账号不可用"));
                return;
            }
            if (deploymentFeatures.creditsEnabled && user.creditBalance < usage.credits) {
                message.error(uiText("额度不足：本次局部编辑需要 {value1} 积分，当前剩余 {value2} 积分", { value1: usage.credits, value2: user.creditBalance }));
                return;
            }
            const userPrompt = payload.prompt.trim();
            const prompt = `只修改蒙版透明区域，其他区域保持不变。${userPrompt}`;
            const childId = nanoid();
            const source = { id: node.id, name: node.title || node.id, originalFileName: originalCanvasImageFileName(node), imageName: canvasImageBaseName(node), imageVersion: canvasImageVersion(node), type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey };
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [source]);
            setMaskEditNodeId(null);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: userPrompt.slice(0, 32) || "局部编辑结果",
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: node.width,
                    height: node.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const imageTask = await createOptions(childId, controller, undefined, "canvas-mask-edit");
                const { metadata, uploaded } = await imageTask.generate(generationConfig, prompt, [source], { id: `${node.id}-mask`, name: "mask.png", type: "image/png", dataUrl: payload.maskDataUrl });
                const size = fitNodeSize(uploaded.width, uploaded.height, node.width, node.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...metadata, prompt, ...generationMetadata } } : item)));
                addAsset({
                    kind: "image",
                    title: userPrompt.slice(0, 24) || "局部编辑结果",
                    coverUrl: uploaded.url,
                    tags: ["无线画布", "局部编辑"],
                    source: "无线画布-局部编辑",
                    data: { dataUrl: uploaded.url, storageKey: uploaded.storageKey, width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType },
                    metadata: {
                        source: "canvas",
                        module: "局部编辑",
                        imageName: generationMetadata.imageName, imageVersion: generationMetadata.imageVersion,
                        nodeId: childId,
                        prompt,
                        model: generationConfig.model,
                        projectId,
                        recreatePath: `/image?tool=image-edit&prompt=${encodeURIComponent(prompt)}&model=${encodeURIComponent(generationConfig.model)}`,
                    },
                });
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : "局部修改失败";
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [addAsset, createOptions, effectiveConfig, estimateUsage, finishGenerationRequest, handleMissingModelConfig, isAiConfigReady, message, projectId, startGenerationRequest],
    );

    const upscaleImageNode = useCallback(async (node: CanvasNodeData, params: CanvasImageUpscaleParams) => {
        if (!node.metadata?.content) return;
        const source = node.metadata.content;
        await runLocalImageOperation(`upscale:${node.id}`, "放大图片", async (signal) => {
            setUpscaleNodeId(null);
            const { upscaleImageBlob } = await loadCanvasImageTools();
            const upscaled = await upscaleImageBlob(source, params, { signal });
            signal.throwIfAborted();
            const image = await uploadImage(upscaled);
            signal.throwIfAborted();
            const size = fitNodeSize(image.width, image.height);
            const childId = nanoid();
            const child: CanvasNodeData = {
                id: childId,
                type: CanvasNodeType.Image,
                title: "Upscaled Image",
                position: { x: node.position.x + node.width + 96, y: node.position.y },
                width: size.width,
                height: size.height,
                metadata: {
                    ...imageMetadata(image),
                    compareSources: [canvasCompareSource(node.metadata || {})],
                    originalFileName: originalCanvasImageFileName(node),
                    imageName: canvasImageBaseName(node), imageVersion: canvasImageVersion(node) + 1,
                    prompt: node.metadata?.prompt,
                },
            };
            setNodes((prev) => [...prev, child]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
        });
    }, [runLocalImageOperation]);

    const generateAngleNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageAngleParams) => {
            if (!node.metadata?.content) return;
            const generationConfig = currentToolConfig({ ...buildGenerationConfig(effectiveConfig, node, "image"), ...params.imageSettings, ...(params.model ? { model: params.model } : {}), count: "1" }, "canvas-angle");
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                handleMissingModelConfig();
                return;
            }
            const childId = nanoid();
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const title = buildAngleLabel(params);
            const prompt = buildAnglePrompt(params);
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [
                { id: node.id, name: node.title || node.id, originalFileName: originalCanvasImageFileName(node), imageName: canvasImageBaseName(node), imageVersion: canvasImageVersion(node), type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey },
            ]);
            setAngleNodeId(null);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const imageTask = await createOptions(childId, controller, undefined, "canvas-angle");
                const { metadata, uploaded } = await imageTask.generate(
                    generationConfig,
                    prompt,
                    [{ id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey }],
                );
                const size = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...metadata, prompt, ...generationMetadata } } : item)));
                addAsset({
                    kind: "image",
                    title: `${title}结果`,
                    coverUrl: uploaded.url,
                    tags: ["无线画布", "角度控制"],
                    source: "无线画布-角度控制",
                    data: { dataUrl: uploaded.url, storageKey: uploaded.storageKey, width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType },
                    metadata: {
                        source: "canvas",
                        module: "角度控制",
                        imageName: generationMetadata.imageName, imageVersion: generationMetadata.imageVersion,
                        nodeId: childId,
                        prompt,
                        model: generationConfig.model,
                        projectId,
                        recreatePath: `/image?tool=angle-control&prompt=${encodeURIComponent(prompt)}&model=${encodeURIComponent(generationConfig.model)}`,
                    },
                });
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : "生成失败";
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [addAsset, createOptions, effectiveConfig, finishGenerationRequest, handleMissingModelConfig, projectId, startGenerationRequest],
    );

    return { createImageReversePromptNodes, saveManualImageEdit, cropImageNode, splitImageNode, maskEditImageNode, upscaleImageNode, generateAngleNode, runLocalImageOperation };
}
