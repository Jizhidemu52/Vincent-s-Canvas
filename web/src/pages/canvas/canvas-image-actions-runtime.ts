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
import { loadCanvasImageTools } from "@/lib/canvas/canvas-image-tool-loader";
import { fitNodeSize, nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { placeCanvasImageOutputs } from "@/lib/canvas/canvas-image-output-placement";
import { adaptCanvasMaskInputs, canvasMaskAdaptationPlan } from "@/lib/canvas/canvas-mask-adaptation";
import { ensureCanvasModelsReady, resolveCanvasToolModel } from "@/lib/canvas/canvas-generation-model";
import { deploymentFeatures } from "@/lib/deployment-features";
import { imageModelProfile } from "@/lib/image-model-settings";
import { uploadImage, type UploadedImage } from "@/services/image-storage";
import { flushCanvasPersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType, type CanvasNodeData, type ContextMenuState } from "@/types/canvas";
import { nanoid } from "nanoid";
import { createElement, type SetStateAction } from "react";
import { buildAngleLabel, buildAnglePrompt, buildGenerationConfig, buildImageGenerationMetadata, createCanvasNode, imageMetadata, isGenerationCanceled } from "./canvas-project-utils";
import type { App } from "antd";
import type { createCanvasGraphStore } from "@/stores/canvas/canvas-graph-store";
import type { CanvasImageActionsOptions } from "./use-canvas-image-actions";
import { createCanvasImageOperationRunner } from "@/lib/canvas/canvas-image-operation";
import { QUICK_IMAGE_MODEL, quickImageTitle, type QuickImageAction } from "@/lib/quick-image-tools";
import { createCanvasGenerationRecord } from "@/lib/canvas/canvas-generation-record";
import { isModuleAvailable, useModuleStore } from "@/stores/use-module-store";
import { requestEdit } from "@/services/api/image";

export type CanvasImageActionRuntimeContext = CanvasImageActionsOptions & {
    effectiveConfig: AiConfig;
    message: ReturnType<typeof App.useApp>["message"];
    setField: ReturnType<ReturnType<typeof createCanvasGraphStore>["getState"]>["setField"];
    runLocalImageOperation: (key: string, label: string, task: (signal: AbortSignal) => Promise<void>) => Promise<boolean>;
    isCurrent: () => boolean;
};

export function runCanvasLocalImageOperation({ scope, projectId, message, key, label, task }: {
    scope: { runner: ReturnType<typeof createCanvasImageOperationRunner> | null };
    projectId: string;
    message: CanvasImageActionRuntimeContext["message"];
    key: string;
    label: string;
    task: (signal: AbortSignal) => Promise<void>;
}) {
    const runner = scope.runner ||= createCanvasImageOperationRunner();
    const messageKey = `canvas-image:${projectId}:${key}`;
    return runner.run(key, task, {
        start: () => { void message.loading({ key: messageKey, content: createElement("span", null, uiText("{value1}中…", { value1: uiText(label) }), " ", createElement("button", { type: "button", className: "ml-2 cursor-pointer underline", onClick: () => runner.cancel(key) }, uiText("取消"))), duration: 0 }); },
        error: error => { void message.error(uiText("{value1}失败：{value2}", { value1: uiText(label), value2: error instanceof Error ? error.message : uiText("请重试") })); },
        finish: () => message.destroy(messageKey),
    });
}

/** Loaded only after an image action; the editor's first paint needs none of this work. */
export function createCanvasImageActionsRuntime(context: CanvasImageActionRuntimeContext) {
    const { projectId, nodesRef, designProjectIdRef, savedProjectIdRef, projectSaveQueueRef, runtime, dialogs, setDialogNodeId, setContextMenu, handleMissingModelConfig, isAiConfigReady, effectiveConfig, message, setField, runLocalImageOperation, isCurrent } = context;
    const estimateUsage = useBusinessConfigStore.getState().estimate;
    const addAsset = useAssetStore.getState().addAsset;
    const updateProject = useCanvasStore.getState().updateProject;
    const setNodes = (value: SetStateAction<CanvasNodeData[]>) => setField("nodes", value);
    const setConnections = (value: SetStateAction<import("@/types/canvas").CanvasConnection[]>) => setField("connections", value);
    const setSelectedNodeIds = (value: SetStateAction<Set<string>>) => setField("selectedNodeIds", value);
    const setSelectedConnectionId = (value: SetStateAction<string | null>) => setField("selectedConnectionId", value);
    const { createOptions, generationDispatchLocksRef, startGenerationRequest, finishGenerationRequest, setRunningNodeId, waitForWriteAccess } = runtime;
    const { manualEditNode, setCropNodeId, setSplitNodeId, setMaskEditNodeId, setUpscaleNodeId, setAngleNodeId } = dialogs;
    const NODE_STATUS_LOADING = "loading" as const;
    const NODE_STATUS_SUCCESS = "success" as const;
    const NODE_STATUS_ERROR = "error" as const;

    const createImageReversePromptNodes = async (node: CanvasNodeData) => {
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
            const current = () => isCurrent() && designProjectIdRef.current === projectId && useUserStore.getState().user?.id === ownerId;
            if (!pending) setNodes(prev => [...prev.map(item => item.id === node.id ? { ...item, metadata: { ...item.metadata, reversePrompt: { requestId, outputNodeId: textNode.id } } } : item), textNode]);
            setContextMenu(null); setSelectedNodeIds(new Set([textNode.id]));
            try {
                const { optimizeImagePrompt } = await import("@/services/api/image");
                const { completedPromptCompilation, getPromptCompilation } = await import("@/services/api/prompt-compilations");
                if (!await waitForWriteAccess() || !current()) return;
                const result = pending ? completedPromptCompilation(await getPromptCompilation(requestId), requestId)
                    : await optimizeImagePrompt({ ...effectiveConfig, model: effectiveConfig.imageModel || effectiveConfig.model }, { scene: "reverse-prompt", fields: {}, userText: "", referenceRoles: ["待反推图片"], mode: "edit" }, [{ id: node.id, name: node.title, dataUrl: node.metadata?.content || "", storageKey: node.metadata?.storageKey, type: node.metadata?.mimeType || "image/png" }], { requestId, toolKey: "canvas-edit" });
                if (!await waitForWriteAccess() || !current()) return;
                setNodes(prev => prev.map(item => item.id === textNode.id ? { ...item, metadata: { ...item.metadata, content: [result.prompt, result.summaryZh].filter(Boolean).join("\n\n"), prompt: result.prompt, optimized: result.optimized, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : item));
                setDialogNodeId(textNode.id);
            } catch (error) {
                if (await waitForWriteAccess() && current()) { const detail = error instanceof Error ? error.message : "反推提示词失败"; message.error(detail); setNodes(prev => prev.map(item => item.id === textNode.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: detail, content: detail } } : item)); }
            } finally { generationDispatchLocksRef.current.delete(key); }
        };

    const saveManualImageEdit = async (image: UploadedImage) => {
        if (!manualEditNode || !isCurrent() || savedProjectIdRef.current !== projectId) throw new Error("画布已切换，请重新打开图片编辑");
        const { createCanvasImageEditVersion } = await import("@/lib/canvas/canvas-image-edit");
        if (!await waitForWriteAccess() || !isCurrent() || savedProjectIdRef.current !== projectId) throw new Error("画布已切换，请重新打开图片编辑");
        const before = nodesRef.current;
        const existing = before.find(node => node.metadata?.storageKey === image.storageKey);
        if (existing) return;
        const size = fitNodeSize(image.width, image.height);
        const child = createCanvasImageEditVersion(before, manualEditNode, image, nanoid(), placeCanvasImageOutputs(before, [manualEditNode], size, manualEditNode.position, 96));
        const next = [...before, child];
        projectSaveQueueRef.current?.flush();
        nodesRef.current = next;
        setNodes(next);
        updateProject(projectId, { nodes: next });
        setConnections(previous => { const connections = [...previous, { id: nanoid(), fromNodeId: manualEditNode.id, toNodeId: child.id }]; updateProject(projectId, { connections }); return connections; });
        try { await flushCanvasPersistence(); }
        catch (error) {
            if (await waitForWriteAccess() && isCurrent() && savedProjectIdRef.current === projectId) {
                const restored = nodesRef.current.filter(node => node.id !== child.id || node.metadata?.storageKey !== image.storageKey);
                projectSaveQueueRef.current?.flush();
                nodesRef.current = restored;
                setNodes(restored);
                updateProject(projectId, { nodes: restored });
                setConnections(previous => { const connections = previous.filter(edge => edge.fromNodeId !== child.id && edge.toNodeId !== child.id); updateProject(projectId, { connections }); return connections; });
            }
            throw error;
        }
        if (!await waitForWriteAccess() || !isCurrent()) return;
        setSelectedNodeIds(new Set([child.id]));
        setDialogNodeId(child.id);
    };

    const cropImageNode = async (node: CanvasNodeData, crop: CanvasImageCropRect) => {
        if (!node.metadata?.content) return;
        const source = node.metadata.content;
        await runLocalImageOperation(`crop:${node.id}`, "裁剪图片", async (signal) => {
            const { cropImageBlob } = await loadCanvasImageTools();
            const cropped = await cropImageBlob(source, crop, { signal, sourceMimeType: node.metadata?.mimeType });
            signal.throwIfAborted();
            const image = await uploadImage(cropped);
            signal.throwIfAborted();
            if (!await waitForWriteAccess() || !isCurrent()) return;
            const width = Math.min(node.width, Math.max(220, image.width));
            const childId = nanoid();
            const child: CanvasNodeData = {
                id: childId,
                type: CanvasNodeType.Image,
                title: `${node.title || "图片"}_裁剪`,
                position: placeCanvasImageOutputs(nodesRef.current, [node], { width, height: width * (image.height / image.width) }, node.position, 96),
                width,
                height: width * (image.height / image.width),
                metadata: {
                    ...imageMetadata(image),
                    compareSources: [canvasCompareSource(node.metadata || {})],
                    originalFileName: originalCanvasImageFileName(node),
                    imageName: `${canvasImageBaseName(node)}_裁剪`, imageVersion: canvasImageVersion(node) + 1,
                    prompt: node.metadata?.prompt,
                },
            };
            setNodes((prev) => [...prev, child]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
            setCropNodeId(current => current === node.id ? null : current);
        });
    };

    const splitImageNode = async (node: CanvasNodeData, params: CanvasImageSplitParams) => {
            if (!node.metadata?.content) return;
            const source = node.metadata.content;
            await runLocalImageOperation(`split:${node.id}`, "切分图片", async (signal) => {
                const { splitImageBlobs } = await loadCanvasImageTools();
                const pieces = await splitImageBlobs(source, params, { signal, sourceMimeType: node.metadata?.mimeType });
                signal.throwIfAborted();
                const gap = 16;
                const cellWidth = node.width / params.columns;
                const cellHeight = node.height / params.rows;
                const start = placeCanvasImageOutputs(nodesRef.current, [node], { width: params.columns * (cellWidth + gap) - gap, height: params.rows * (cellHeight + gap) - gap }, node.position, 96);
                const startX = start.x;
                const startY = start.y;
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
                if (!await waitForWriteAccess() || !isCurrent()) return;
                setNodes((prev) => [...prev, ...childNodes]);
                setConnections((prev) => [...prev, ...childNodes.map((child) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: child.id }))]);
                setSelectedNodeIds(new Set(childNodes.map((child) => child.id)));
                setSelectedConnectionId(null);
                setDialogNodeId(null);
                setSplitNodeId(current => current === node.id ? null : current);
                message.success(uiText("已切分为 {value1} 个子节点", { value1: childNodes.length }));
            });
        };

    const maskEditImageNode = async (node: CanvasNodeData, payload: CanvasImageMaskEditPayload) => {
            if (!node.metadata?.content) return;
            const user = useUserStore.getState().user;
            const business = await ensureCanvasModelsReady();
            const selectedModel = resolveCanvasToolModel("canvas-mask-edit", { ...effectiveConfig, model: payload.model || effectiveConfig.imageModel || effectiveConfig.model }, business).model;
            const usage = estimateUsage({ operationType: "inpaint", toolKey: "canvas-mask-edit", modelId: modelOptionName(selectedModel), quantity: 1 });
            let generationConfig: AiConfig;
            let maskAdaptation: import("@/lib/canvas/canvas-mask-adaptation").CanvasMaskAdaptation;
            let adapted: Awaited<ReturnType<typeof adaptCanvasMaskInputs>>;
            try {
                const { canvasMaskEditImageSettings, readCanvasMaskImageSize } = await import("@/components/canvas/canvas-node-mask-edit-dialog");
                const [sourceSize, maskSize] = await Promise.all([readCanvasMaskImageSize(node.metadata.content), readCanvasMaskImageSize(payload.maskDataUrl)]);
                if (!await waitForWriteAccess() || !isCurrent()) return;
                if (sourceSize.width !== maskSize.width || sourceSize.height !== maskSize.height) throw new Error("蒙版尺寸与当前原图不一致，请重新绘制；尚未提交生成，不会自动拉伸。");
                const baseConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), ...payload.imageSettings };
                const plan = canvasMaskAdaptationPlan(sourceSize, imageModelProfile(selectedModel));
                generationConfig = { ...baseConfig, ...canvasMaskEditImageSettings(baseConfig, plan, imageModelProfile(selectedModel)), model: selectedModel, imageModel: selectedModel, count: "1" };
                const [original, mask] = await Promise.all([node.metadata.storageKey ? Promise.resolve({ storageKey: node.metadata.storageKey }) : uploadImage(node.metadata.content), uploadImage(payload.maskDataUrl)]);
                maskAdaptation = { ...plan, sourceStorageKey: original.storageKey, maskStorageKey: mask.storageKey };
                adapted = await adaptCanvasMaskInputs(node.metadata.content, payload.maskDataUrl, plan);
                if (!await waitForWriteAccess() || !isCurrent()) return;
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
            const source = { id: node.id, name: node.title || "编辑原图", originalFileName: originalCanvasImageFileName(node), imageName: canvasImageBaseName(node), imageVersion: canvasImageVersion(node), type: "image/png", dataUrl: adapted.sourceDataUrl };
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [source]);
            setMaskEditNodeId(null);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: userPrompt.slice(0, 32) || "局部编辑结果",
                    position: placeCanvasImageOutputs(nodesRef.current, [node], node, node.position, 96),
                    width: node.width,
                    height: node.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata, maskAdaptation },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const imageTask = await createOptions(childId, controller, undefined, "canvas-mask-edit");
                const { metadata, uploaded } = await imageTask.generate(generationConfig, prompt, [source], { id: `${node.id}-mask`, name: "mask.png", type: "image/png", dataUrl: adapted.maskDataUrl });
                if (!await waitForWriteAccess() || !isCurrent()) return;
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
                if (!await waitForWriteAccess() || !isCurrent() || isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : "局部修改失败";
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        };

    const upscaleImageNode = async (node: CanvasNodeData, params: CanvasImageUpscaleParams) => {
        if (!node.metadata?.content) return;
        const source = node.metadata.content;
        await runLocalImageOperation(`upscale:${node.id}`, "放大图片", async (signal) => {
            const { upscaleImageBlob } = await loadCanvasImageTools();
            const upscaled = await upscaleImageBlob(source, params, { signal, sourceMimeType: node.metadata?.mimeType });
            signal.throwIfAborted();
            const image = await uploadImage(upscaled);
            signal.throwIfAborted();
            if (!await waitForWriteAccess() || !isCurrent()) return;
            const size = fitNodeSize(image.width, image.height);
            const childId = nanoid();
            const child: CanvasNodeData = {
                id: childId,
                type: CanvasNodeType.Image,
                title: `${node.title || "图片"}_放大${Math.round(params.targetLongEdge / 1024)}K`,
                position: placeCanvasImageOutputs(nodesRef.current, [node], size, node.position, 96),
                width: size.width,
                height: size.height,
                metadata: {
                    ...imageMetadata(image),
                    compareSources: [canvasCompareSource(node.metadata || {})],
                    originalFileName: originalCanvasImageFileName(node),
                    imageName: `${canvasImageBaseName(node)}_放大${Math.round(params.targetLongEdge / 1024)}K`, imageVersion: canvasImageVersion(node) + 1,
                    prompt: node.metadata?.prompt,
                },
            };
            setNodes((prev) => [...prev, child]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
            setUpscaleNodeId(current => current === node.id ? null : current);
        });
    };

    const generateAngleNode = async (node: CanvasNodeData, params: CanvasImageAngleParams) => {
            if (!node.metadata?.content) return;
            const generationConfig = resolveCanvasToolModel("canvas-angle", { ...buildGenerationConfig(effectiveConfig, node, "image"), ...params.imageSettings, ...(params.model ? { model: params.model } : {}), count: "1" }, await ensureCanvasModelsReady());
            if (!await waitForWriteAccess() || !isCurrent()) return;
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                handleMissingModelConfig();
                return;
            }
            const childId = nanoid();
            const imageConfig = nodeSizeFromRatio(generationConfig.size, 320, 320) || fitNodeSize(node.width, node.height, 320, 320);
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
                    position: placeCanvasImageOutputs(nodesRef.current, [node], imageConfig, node.position, 96),
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
                if (!await waitForWriteAccess() || !isCurrent()) return;
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
                if (!await waitForWriteAccess() || !isCurrent() || isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : "生成失败";
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        };

    const quickImageNode = async (source: CanvasNodeData, action: QuickImageAction) => {
        const key = `quick-image:${source.id}`;
        if (generationDispatchLocksRef.current.has(key)) return;
        generationDispatchLocksRef.current.add(key);
        let childId: string | undefined;
        let controller: AbortController | undefined;
        try {
            const node = nodesRef.current.find(item => item.id === source.id);
            if (!node || node.type !== CanvasNodeType.Image || !(node.metadata?.content || node.metadata?.storageKey)) return;
            if (node.metadata?.imageTask || node.metadata?.status === "loading" || nodesRef.current.some(item => item.metadata?.quickImageAction && item.metadata?.generationRecord?.sourceNodeId === node.id && (item.metadata.imageTask || item.metadata.status === "loading"))) {
                message.warning(uiText("已有图片任务待完成，请先查看原任务")); return;
            }
            if (!isModuleAvailable(useModuleStore.getState().flags, useBusinessConfigStore.getState().tools, "canvas-edit")) { message.warning(uiText("当前图片编辑功能已停用")); return; }
            if (useUserStore.getState().user?.status !== "active" || !await waitForWriteAccess() || !isCurrent()) return;
            const title = quickImageTitle(action);
            const config = { ...effectiveConfig, model: QUICK_IMAGE_MODEL, imageModel: QUICK_IMAGE_MODEL, count: "1", size: "auto", quality: action === "hd-upscale" ? "4K" : "2K", imageOptions: "", systemPrompt: "" };
            const references = [{ id: node.id, name: node.title || "原图", type: node.metadata?.mimeType || "image/png", dataUrl: node.metadata?.content || "", storageKey: node.metadata?.storageKey }];
            const size = fitNodeSize(node.metadata?.naturalWidth || node.width, node.metadata?.naturalHeight || node.height, 320, 320);
            childId = nanoid();
            const generationRecord = createCanvasGenerationRecord({ id: nanoid(), sourceNodeId: node.id, prompt: "", references, nodes: nodesRef.current, config, generationType: "edit" });
            setNodes(previous => [...previous, { id: childId!, type: CanvasNodeType.Image, title: `${node.title || "图片"} · ${title}`, position: placeCanvasImageOutputs(nodesRef.current, [node], size, node.position, 96), ...size,
                metadata: { ...buildImageGenerationMetadata("edit", config, 1, references), quickImageAction: action, generationRecord, compareSources: [canvasCompareSource(node.metadata || {})], status: NODE_STATUS_LOADING } }]);
            setConnections(previous => [...previous, { id: nanoid(), fromNodeId: node.id, toNodeId: childId! }]);
            setSelectedNodeIds(new Set([childId])); setContextMenu(null); setDialogNodeId(null);
            controller = startGenerationRequest(childId, node.id, childId);
            const task = await createOptions(childId, controller, undefined, "canvas-edit");
            const { metadata, uploaded } = await task.receiveResult(requestEdit(config, "", references, undefined, { ...task, tool: "canvas-edit", quickImageAction: action }));
            if (!await waitForWriteAccess() || !isCurrent()) return;
            const resultSize = fitNodeSize(uploaded.width, uploaded.height, size.width, size.height);
            setNodes(previous => previous.map(item => item.id === childId ? { ...item, ...resultSize, metadata: { ...item.metadata, ...metadata } } : item));
        } catch (error) {
            if (!await waitForWriteAccess() || !isCurrent() || isGenerationCanceled(error)) return;
            const errorDetails = error instanceof Error ? error.message : "图片处理失败";
            message.error(uiText(errorDetails));
            if (childId) setNodes(previous => previous.map(item => item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item));
        } finally {
            generationDispatchLocksRef.current.delete(key);
            if (childId && controller) finishGenerationRequest(childId, controller);
        }
    };

    return { createImageReversePromptNodes, saveManualImageEdit, cropImageNode, splitImageNode, maskEditImageNode, upscaleImageNode, generateAngleNode, quickImageNode };
}
