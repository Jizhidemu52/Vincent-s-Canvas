import type { Dispatch, SetStateAction } from "react";
import { nanoid } from "nanoid";
import { requestBatchEdit } from "@/services/api/image";
import { flushSync } from "react-dom";
import { useCanvasStore, flushCanvasPersistence } from "@/stores/canvas/use-canvas-store";
import { controlQueuedBatch, QueuedTaskHttpError, QueuedTaskSubmissionUncertainError, type QueuedBatchAction } from "@/services/api/generation-tasks";
import { uploadImage, type UploadedImage } from "@/services/image-storage";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { mapCanvasAsyncPool } from "@/lib/canvas/canvas-async-pool";
import { assertCanvasImageUploadSize } from "@/lib/canvas/canvas-image-upload-limit";
import { deploymentFeatures } from "@/lib/deployment-features";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import type { AssetInput } from "@/stores/use-asset-store";
import type { LocalUser } from "@/stores/use-user-store";
import type { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection, type CanvasNodeMetadata, type Position } from "@/types/canvas";

export type BatchEditFileItem = {
    id: string;
    file: File;
    relativePath: string;
    status: "waiting" | "processing" | "paused" | "success" | "failed" | "cancelled";
    requestId?: string;
    sourceUrl?: string;
    resultUrl?: string;
    failureReason?: string;
};

type Runtime = {
    prompt: string;
    optimizePrompt?: boolean;
    setOptimizing?: (value: boolean) => void;
    items: BatchEditFileItem[];
    config: AiConfig;
    estimate: ReturnType<typeof useBusinessConfigStore.getState>["estimate"];
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    onMissingModel: () => void;
    user: LocalUser | null;
    projectId: string;
    getCenter: () => Position;
    imageMetadata: (image: UploadedImage) => CanvasNodeMetadata;
    addAssets: (assets: AssetInput[]) => unknown;
    setRunning: Dispatch<SetStateAction<boolean>>;
    setServerId: Dispatch<SetStateAction<string | null>>;
    setAction: Dispatch<SetStateAction<QueuedBatchAction | null>>;
    setItems: Dispatch<SetStateAction<BatchEditFileItem[]>>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    message: { error: (text: string) => unknown; warning: (text: string) => unknown; success: (text: string) => unknown };
};

/** The batch form stays mounted; upload/queue/result handling loads only on execution. */
export async function runCanvasBatchImageEdit({
    prompt: batchEditPrompt, optimizePrompt = false, setOptimizing, items: batchEditItems, config: batchGenerationConfig, estimate: estimateUsage, isAiConfigReady,
    onMissingModel: handleMissingModelConfig, user, projectId, getCenter: getCanvasCenter, imageMetadata, addAssets,
    setRunning: setBatchEditRunning, setServerId: setBatchEditServerId, setAction: setBatchEditAction, setItems: setBatchEditItems,
    setNodes, setConnections, setSelectedNodeIds, message,
}: Runtime) {
        let prompt = batchEditPrompt.trim();
        let optimized = false;
        const items = batchEditItems;
        if (items.some(item => item.requestId)) { message.warning("该批次已有原请求，请在画布结果节点查询原任务；不会重复提交。新批次请重新选择图片。"); return; }
        const model = batchGenerationConfig.model;
        const modelId = modelOptionName(model);
        const usage = estimateUsage({ operationType: "batch_image", toolKey: "canvas-batch", modelId, quantity: items.length });

        if (!items.length || items.length > 100) {
            message.error("请选择 1–100 张图片，每张图片独立生成 1 张结果。");
            return;
        }
        try {
            items.forEach(item => assertCanvasImageUploadSize(item.file));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "图片过大，未提交批量改图");
            return;
        }
        if (!prompt) {
            message.error("请输入批量改图提示词");
            return;
        }
        if (!isAiConfigReady(batchGenerationConfig, model)) {
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

        const localBatchId = `canvas-batch-${nanoid()}`;
        const origin = getCanvasCenter();
        const sourceX = origin.x - 420;
        const resultX = origin.x + 60;
        const rowGap = 52;
        const maxWidth = 320;
        const maxHeight = 240;
        const prepared: Array<{
            originalIndex: number;
            item: BatchEditFileItem;
            sourceId: string;
            resultId: string;
            uploadedSource: UploadedImage;
        }> = [];
        const initialBatchNodes: CanvasNodeData[] = [];
        const initialBatchConnections: CanvasConnection[] = [];
        let localFailures = 0;
        const selectedResults: string[] = [];
        const settledResultIds = new Set<string>();
        const generatedAssets: AssetInput[] = [];

        setBatchEditRunning(true);
        setBatchEditServerId(null);
        setBatchEditAction(null);
        setBatchEditItems((prev) => prev.map((item) => ({ ...item, status: "waiting", sourceUrl: undefined, resultUrl: undefined, failureReason: undefined })));

        for (const [index, item] of items.entries()) {
            const sourceId = `${localBatchId}-source-${index + 1}`;
            const resultId = `${localBatchId}-result-${index + 1}`;
            try {
                setBatchEditItems((prev) => prev.map((entry) => (entry.id === item.id ? { ...entry, status: "processing" } : entry)));
                const uploadedSource = await uploadImage(item.file);
                const sourceSize = fitNodeSize(uploadedSource.width, uploadedSource.height, maxWidth, maxHeight);
                const rowY = origin.y + index * (Math.max(sourceSize.height, maxHeight) + rowGap);
                initialBatchNodes.push(
                    {
                        id: sourceId,
                        type: CanvasNodeType.Image,
                        title: item.relativePath,
                        position: { x: sourceX, y: rowY },
                        width: sourceSize.width,
                        height: sourceSize.height,
                        metadata: { ...imageMetadata(uploadedSource), prompt, batchRootId: localBatchId },
                    },
                    {
                        id: resultId,
                        type: CanvasNodeType.Image,
                        title: `${item.file.name} 改图结果`,
                        position: { x: resultX, y: rowY },
                        width: sourceSize.width,
                        height: sourceSize.height,
                        metadata: {
                            prompt,
                            status: "loading",
                            generationType: "edit",
                            model,
                            size: batchGenerationConfig.size,
                            quality: batchGenerationConfig.quality,
                            imageOptions: batchGenerationConfig.imageOptions,
                            count: 1,
                            references: [uploadedSource.storageKey || uploadedSource.url],
                            batchRootId: localBatchId,
                        },
                    },
                );
                initialBatchConnections.push({ id: nanoid(), fromNodeId: sourceId, toNodeId: resultId });
                prepared.push({ originalIndex: index, item, sourceId, resultId, uploadedSource });
                setBatchEditItems((prev) => prev.map((entry) => (entry.id === item.id ? { ...entry, status: "waiting", sourceUrl: uploadedSource.url } : entry)));
            } catch (error) {
                localFailures += 1;
                const reason = error instanceof Error ? error.message : "本地图片读取失败";
                setBatchEditItems((prev) => prev.map((entry) => (entry.id === item.id ? { ...entry, status: "failed", sourceUrl: `file://${item.relativePath}`, failureReason: reason } : entry)));
            }
        }

        if (!prepared.length) {
            setBatchEditRunning(false);
            setOptimizing?.(false);
            message.error("没有可提交的图片");
            return;
        }

        setNodes((prev) => [...prev, ...initialBatchNodes]);
        setConnections((prev) => [...prev, ...initialBatchConnections]);

        const preparedIndexByItemId = new Map(prepared.map((entry, index) => [entry.item.id, index]));
        let failedCount = localFailures;
        let cancelledCount = 0;
        let unresolvedCount = 0;
        try {
            const result = await requestBatchEdit(
                { ...batchGenerationConfig, model, count: "1" },
                prompt,
                prepared.map((entry) => ({ file: entry.item.file, title: entry.item.relativePath })),
                {
                    optimizePrompt,
                    onSubmissionStarted: async (requestId, uploadedItems) => {
                        const bindings = new Map(uploadedItems.map((item, index) => [prepared[item.itemIndex]!.resultId, { requestId: `${requestId}:${index}`, ownerId: user!.id, projectId, resultIndex: 0 }]));
                        setBatchEditItems(prev => prev.map(item => ({ ...item, requestId })));
                        let durableNodes: CanvasNodeData[] = [];
                        flushSync(() => setNodes(prev => { durableNodes = prev.map(node => bindings.has(node.id) ? { ...node, metadata: { ...node.metadata, imageTask: bindings.get(node.id) } } : node); return durableNodes; }));
                        useCanvasStore.getState().updateProject(projectId, { nodes: durableNodes });
                        await flushCanvasPersistence();
                    },
                    onOptimizing: () => setOptimizing?.(true),
                    onCompiled: (finalPrompt, wasOptimized) => { prompt = finalPrompt; optimized = wasOptimized; setOptimizing?.(false); },
                    onSubmitted: setBatchEditServerId,
                    onProgress: (current) => {
                        const byPreparedIndex = new Map(current.map((task) => [task.itemIndex, task]));
                        setBatchEditItems((prev) => {
                            let changed = false;
                            const next = prev.map((entry) => {
                                const preparedIndex = preparedIndexByItemId.get(entry.id);
                                if (preparedIndex === undefined) return entry;
                                const task = byPreparedIndex.get(preparedIndex);
                                if (!task) return entry;
                                const status = batchTaskUiStatus(task.status);
                                const failureReason = task.failureReason || entry.failureReason;
                                if (entry.status === status && entry.failureReason === failureReason) return entry;
                                changed = true;
                                return {
                                    ...entry,
                                    status,
                                    failureReason,
                                };
                            });
                            return changed ? next : prev;
                        });
                    },
                },
            );

            const completedBatchItems = new Map<string, { status: "failed" | "cancelled"; failureReason: string }>();
            const completedBatchResultNodes = new Map<string, string>();
            const successfulBatchTasks: Array<{ entry: (typeof prepared)[number]; resultUrl: string; sourceTaskId: string }> = [];

            for (const failure of result.failures) {
                const entry = prepared[failure.index];
                if (!entry) continue;
                failedCount += 1;
                completedBatchItems.set(entry.item.id, { status: "failed", failureReason: failure.reason });
                completedBatchResultNodes.set(entry.resultId, failure.reason);
                settledResultIds.add(entry.resultId);
            }

            for (const task of result.tasks) {
                const entry = prepared[task.itemIndex];
                if (!entry) continue;
                if (task.status !== "success") {
                    const cancelled = task.status === "cancelled";
                    if (cancelled) cancelledCount += 1;
                    else failedCount += 1;
                    const reason = task.failureReason || (cancelled ? "任务已取消" : "批量改图失败");
                    completedBatchItems.set(entry.item.id, { status: cancelled ? "cancelled" : "failed", failureReason: reason });
                    completedBatchResultNodes.set(entry.resultId, reason);
                    settledResultIds.add(entry.resultId);
                    continue;
                }
                const resultUrl = task.resultUrls[0];
                if (!resultUrl) {
                    failedCount += 1;
                    const reason = "任务成功但没有返回结果图片";
                    completedBatchItems.set(entry.item.id, { status: "failed", failureReason: reason });
                    completedBatchResultNodes.set(entry.resultId, reason);
                    settledResultIds.add(entry.resultId);
                    continue;
                }
                successfulBatchTasks.push({ entry, resultUrl, sourceTaskId: task.id });
            }
            await mapCanvasAsyncPool(successfulBatchTasks, 3, async ({ entry, resultUrl, sourceTaskId }) => {
                try {
                    const uploadedResult = await uploadImage(resultUrl);
                    const resultSize = fitNodeSize(uploadedResult.width, uploadedResult.height, maxWidth, maxHeight);
                    selectedResults.push(entry.resultId);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === entry.resultId
                                ? {
                                      ...node,
                                      position: {
                                          x: node.position.x + node.width / 2 - resultSize.width / 2,
                                          y: node.position.y + node.height / 2 - resultSize.height / 2,
                                      },
                                      width: resultSize.width,
                                      height: resultSize.height,
                                      metadata: {
                                          ...node.metadata,
                                          ...imageMetadata(uploadedResult),
                                          sourceTaskId, imageTask: undefined, optimized,
                                          userInput: optimizePrompt ? { scene: "batch-optimize", userText: batchEditPrompt.trim(), mode: "edit" } : undefined,
                                          originalFileName: entry.item.file.name,
                                          imageName: entry.item.file.name.replace(/\.[^.]+$/, ""), imageVersion: 2,
                                          prompt,
                                          generationType: "edit",
                                          model,
                                          size: batchGenerationConfig.size,
                                          quality: batchGenerationConfig.quality,
                                          imageOptions: batchGenerationConfig.imageOptions,
                                          count: 1,
                                          references: [entry.uploadedSource.storageKey || entry.uploadedSource.url],
                                      },
                                  }
                                : node,
                        ),
                    );
                    generatedAssets.push({
                        kind: "image",
                        title: `${entry.item.file.name} 改图结果`,
                        coverUrl: uploadedResult.url,
                        tags: ["批量改图"],
                        source: "无线画布-批量改图",
                        data: {
                            dataUrl: uploadedResult.url,
                            storageKey: uploadedResult.storageKey,
                            width: uploadedResult.width,
                            height: uploadedResult.height,
                            bytes: uploadedResult.bytes,
                            mimeType: uploadedResult.mimeType,
                        },
                        metadata: {
                            source: "canvas",
                            module: "批量改图",
                            imageName: entry.item.file.name.replace(/\.[^.]+$/, ""), imageVersion: 2,
                            prompt,
                            model,
                            modelId,
                            projectId,
                            nodeId: entry.resultId,
                            sourceFile: entry.item.relativePath,
                            serverBatchId: result.batchId,
                            serverAssetId: serverAssetIdFromContentUrl(resultUrl),
                            toolMode: "batch-image-edit",
                            recreatePath: `/image?tool=image-edit&prompt=${encodeURIComponent(prompt)}&model=${encodeURIComponent(model)}`,
                        },
                    });
                    setBatchEditItems((prev) => prev.map((item) => (item.id === entry.item.id ? { ...item, status: "success", resultUrl: uploadedResult.url } : item)));
                } catch (error) {
                    failedCount += 1;
                    const reason = error instanceof Error ? error.message : "结果图存储失败";
                    completedBatchItems.set(entry.item.id, { status: "failed", failureReason: reason });
                    completedBatchResultNodes.set(entry.resultId, reason);
                } finally {
                    settledResultIds.add(entry.resultId);
                }
            });
            if (completedBatchItems.size) {
                setBatchEditItems((prev) =>
                    prev.map((item) => {
                        const completed = completedBatchItems.get(item.id);
                        return completed ? { ...item, ...completed } : item;
                    }),
                );
            }
            if (completedBatchResultNodes.size) {
                setNodes((prev) =>
                    prev.map((node) => {
                        const reason = completedBatchResultNodes.get(node.id);
                        return reason ? { ...node, metadata: { ...node.metadata, status: "error", errorDetails: reason } } : node;
                    }),
                );
            }
        } catch (error) {
            const uncertain = error instanceof QueuedTaskSubmissionUncertainError;
            const rejected = error instanceof QueuedTaskHttpError && error.submissionRejected;
            const reason = error instanceof Error ? error.message : "批量任务提交失败";
            const unresolved = prepared.filter((entry) => !settledResultIds.has(entry.resultId));
            const unresolvedItemIds = new Set(unresolved.map((entry) => entry.item.id));
            const unresolvedResultIds = new Set(unresolved.map((entry) => entry.resultId));
            if (uncertain) unresolvedCount = unresolved.length;
            else failedCount += unresolved.length;
            setBatchEditItems((prev) => prev.map((item) => (unresolvedItemIds.has(item.id) ? { ...item, ...(rejected ? { requestId: undefined } : {}), status: uncertain ? "paused" : "failed", failureReason: reason } : item)));
            setNodes((prev) => prev.map((node) => (unresolvedResultIds.has(node.id) ? { ...node, metadata: { ...node.metadata, ...(rejected ? { imageTask: undefined } : {}), status: "error", errorDetails: reason } } : node)));
        } finally {
            if (generatedAssets.length) addAssets(generatedAssets);
            setSelectedNodeIds(new Set(selectedResults));
            setBatchEditRunning(false);
            setOptimizing?.(false);
        }

        if (unresolvedCount) {
            message.warning(`批次状态待核查：${unresolvedCount} 张待查询原任务，不会重复提交或扣费。`);
        } else if (failedCount || cancelledCount) {
            message.warning(`批量改图完成，成功 ${selectedResults.length} 张，失败 ${failedCount} 张，取消 ${cancelledCount} 张`);
        } else {
            message.success(`批量改图完成：${selectedResults.length} 张`);
        }

}

export function prepareCanvasBatchFiles(files: File[]) {
    const images = files.filter(file => file.type.startsWith("image/"))
        .sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, "zh-Hans-CN", { numeric: true }));
    if (images.length > 100) throw new Error("每批最多处理 100 张图片，请分批选择；原列表未改变。");
    images.forEach(assertCanvasImageUploadSize);
    return images.map(file => ({ id: nanoid(), file, relativePath: file.webkitRelativePath || file.name, status: "waiting" as const }));
}
export async function controlCanvasBatch(id: string, action: QueuedBatchAction, message: Runtime["message"]) {
    try {
        const result = await controlQueuedBatch(id, action);
        message.success(`${action === "pause" ? "暂停" : action === "resume" ? "恢复" : "取消"}成功，影响 ${result.changed} 张图片`);
    } catch (error) {
        message.error(error instanceof Error ? error.message : "批量任务操作失败");
    }
}

function batchTaskUiStatus(status: string): BatchEditFileItem["status"] {
    if (status === "processing" || status === "paused" || status === "success" || status === "failed" || status === "cancelled") return status;
    return "waiting";
}

function serverAssetIdFromContentUrl(url: string) {
    return url.match(/^\/api\/assets\/([0-9a-f-]{36})\/content$/i)?.[1];
}
