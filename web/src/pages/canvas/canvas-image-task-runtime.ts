import type { Dispatch, RefObject, SetStateAction } from "react";
import { flushSync } from "react-dom";
import { observeCanvasImageTask, type CanvasImageTaskBinding } from "@/lib/canvas/canvas-image-task-recovery";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { getQueuedTask, getQueuedTaskByRequestId, QueuedTaskFailedError } from "@/services/api/generation-tasks";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { uploadImage } from "@/services/image-storage";
import { flushCanvasPersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";
import type { ToolKey } from "../../../../shared/feature-catalog";
import { imageModelProfile } from "@/lib/image-model-settings";
import { shouldCancelCanvasGeneration } from "@/lib/canvas/canvas-project-async-lifecycle";

export type CanvasImageTaskScope = { projectId: string; mounted: boolean; recoveries: Map<string, AbortController> };
type RecoveryOutput = { nodeId: string; status: "success" | "failed"; url?: string; storageKey?: string; error?: string };

type Context = {
    nodes: RefObject<CanvasNodeData[]>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    saveQueue: RefObject<{ flush(): void } | null>;
    scope: CanvasImageTaskScope;
    ownerId: string | undefined;
    generating: RefObject<{ has(nodeId: string): boolean }>;
};

/** Loaded only when a generation is about to submit or an existing task needs observation. */
export default function createCanvasImageTaskRuntime({ nodes, setNodes, saveQueue, scope, ownerId, generating }: Context) {
    const flushPendingSave = () => saveQueue.current?.flush();
    const inScope = () => scope.mounted && Boolean(ownerId) && useUserStore.getState().user?.id === ownerId;
    const current = (nodeId: string, binding: CanvasImageTaskBinding, requireBinding = true) => {
        const node = nodes.current.find(item => item.id === nodeId);
        return inScope() && binding.ownerId === ownerId && binding.projectId === scope.projectId
            && Boolean(node) && (!requireBinding || node?.metadata?.imageTask?.requestId === binding.requestId);
    };
    const patch = async (nodeId: string, binding: CanvasImageTaskBinding, metadata: Partial<CanvasNodeMetadata>, requireBinding = true) => {
        if (!current(nodeId, binding, requireBinding)) throw new DOMException("画布或任务已变化", "AbortError");
        flushSync(() => setNodes(previous => {
            const target = previous.find(node => node.id === nodeId);
            return previous.map(node => {
                const primary = metadata.status === "success" && target?.metadata?.batchRootId === node.id
                    && node.metadata?.isBatchRoot && !node.metadata.imageTask && (!node.metadata.primaryImageId || node.metadata.primaryImageId === nodeId);
                if (node.id !== nodeId && !primary) return node;
                return {
                    ...node,
                    ...(metadata.status === "success" && metadata.naturalWidth && metadata.naturalHeight
                        ? fitNodeSize(metadata.naturalWidth, metadata.naturalHeight, node.width, node.height) : {}),
                    metadata: { ...node.metadata, ...metadata, ...(primary ? { primaryImageId: nodeId } : {}) },
                };
            });
        }));
        // Flush the editor before the store so an older debounce cannot overwrite the binding.
        flushPendingSave();
        useCanvasStore.getState().updateProject(binding.projectId, { nodes: nodes.current });
        try {
            await flushCanvasPersistence();
        } catch (error) {
            const node = nodes.current.find(item => item.id === nodeId);
            if ("imageTask" in metadata && metadata.imageTask === undefined && current(nodeId, binding, false)
                && !node?.metadata?.imageTask && node?.metadata?.sourceTaskId === metadata.sourceTaskId) {
                flushSync(() => setNodes(previous => previous.map(item => {
                    const rolledBackCover = node?.metadata?.batchRootId === item.id && item.metadata?.primaryImageId === nodeId
                        && item.metadata.sourceTaskId === metadata.sourceTaskId;
                    if (item.id !== nodeId && !rolledBackCover) return item;
                    return { ...item, metadata: {
                        ...item.metadata, ...(item.id === nodeId ? { imageTask: binding } : {}),
                        status: "error", errorDetails: "图片任务结果保存失败，已保留原任务，请重试查询。",
                    } };
                })));
                flushPendingSave();
                useCanvasStore.getState().updateProject(binding.projectId, { nodes: nodes.current });
            }
            throw error;
        }
        if (!current(nodeId, binding, metadata.imageTask === undefined && "imageTask" in metadata ? false : true)) throw new DOMException("画布或任务已变化", "AbortError");
    };

    const runtime = {
        createOptions(nodeId: string, controller: AbortController, requestId: string, onSubmitted?: () => void, toolKey?: ToolKey) {
            if (!ownerId) throw new Error("当前账号不可用");
            const binding: CanvasImageTaskBinding = { ownerId, projectId: scope.projectId, requestId: `${requestId}:0`, resultIndex: 0 };
            let prepared = false;
            const assertCurrent = () => {
                controller.signal.throwIfAborted();
                if (!current(nodeId, binding, prepared)) throw new DOMException("画布或任务已变化", "AbortError");
            };
            assertCurrent();
            const options = {
                requestId,
                signal: controller.signal,
                cancelOnAbort: () => shouldCancelCanvasGeneration(controller.signal) && current(nodeId, binding, prepared),
                assertCurrent,
                async generate(config: Parameters<typeof requestGeneration>[0], prompt: string, references?: Parameters<typeof requestEdit>[2], mask?: Parameters<typeof requestEdit>[3], edit = Boolean(references?.length || mask), promptInput?: import("../../../../shared/prompt-contracts").PromptInputData) {
                    assertCurrent();
                    if (!mask && imageModelProfile(config.model || config.imageModel).kind === "midjourney-blend") { edit = false; prompt = ""; }
                    config = { ...config, count: "1", canvasImageCount: "1" };
                    const requestOptions = { ...options, promptInput: promptInput?.compilationId ? promptInput : promptInput ? { ...promptInput, userText: prompt, fields: { ...promptInput.fields, ...(promptInput.scene === "workflow-step" || Object.hasOwn(promptInput.fields || {}, "instruction") ? { instruction: prompt } : {}) }, hasMask: Boolean(mask) } : undefined, onOptimizing: () => { setNodes(previous => previous.map(node => node.id === nodeId ? { ...node, metadata: { ...node.metadata, optimizingPrompt: true } } : node)); }, onCompiled: (finalPrompt: string, optimized: boolean) => { setNodes(previous => previous.map(node => node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt: finalPrompt, optimized, optimizingPrompt: false } } : node)); }, tool: toolKey || (edit ? "canvas-edit" : "canvas-image") };
                    return options.receiveResult(edit
                        ? requestEdit(config, prompt, references || [], mask, requestOptions)
                        : requestGeneration(config, prompt, requestOptions, references));
                },
                async receiveResult<T extends { dataUrl: string; sourceTaskId?: string; prompt?: string; optimized?: boolean; userInput?: import("../../../../shared/prompt-contracts").PromptInputData }>(request: Promise<T[]>) {
                    try {
                        const image = (await request)[0];
                        assertCurrent();
                        if (!image) throw new Error("接口没有返回图片");
                        const uploaded = await uploadImage(image.dataUrl);
                        assertCurrent();
                        const metadata: CanvasNodeMetadata = {
                            imageTask: undefined, errorDetails: undefined, sourceTaskId: image.sourceTaskId,
                            ...(image.prompt !== undefined ? { prompt: image.prompt, optimized: image.optimized, userInput: image.userInput } : {}), optimizingPrompt: false,
                            content: uploaded.url, storageKey: uploaded.storageKey, status: "success",
                            naturalWidth: uploaded.width, naturalHeight: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType,
                            ...(uploaded.originalFileName ? { originalFileName: uploaded.originalFileName, imageName: uploaded.originalFileName.replace(/\.[^.]+$/, ""), imageVersion: 1 } : {}),
                        };
                        return { image, uploaded, metadata };
                    } catch (error) {
                        assertCurrent();
                        if (error instanceof QueuedTaskFailedError || (error as { submissionRejected?: boolean })?.submissionRejected) {
                            setNodes(previous => previous.map(node => node.id === nodeId ? {
                                ...node, metadata: { ...node.metadata, imageTask: undefined, optimizingPrompt: false },
                            } : node));
                        }
                        throw error;
                    }
                },
                onSubmissionStarted: async () => {
                    assertCurrent();
                    await runtime.prepare(nodeId, binding, controller.signal);
                    prepared = true;
                    assertCurrent();
                },
                onSubmitted: async (ids: string[]) => {
                    assertCurrent();
                    await runtime.submitted(nodeId, binding, ids);
                    onSubmitted?.();
                },
            };
            return options;
        },
        async recoverPending(nodeId?: string): Promise<RecoveryOutput[] | null> {
            if (!inScope()) return [];
            const source = nodes.current.find(node => node.id === nodeId);
            if (nodeId && !source) return [];
            const pending = nodes.current.filter(node => node.type === CanvasNodeType.Image && node.metadata?.imageTask
                && (!nodeId || node.id === nodeId || (source?.metadata?.isBatchRoot && node.metadata.batchRootId === nodeId)));
            if (!pending.length) return null;
            await Promise.all(pending.map(node => runtime.recoverImageTask(node.id, node.metadata!.imageTask!)));
            return pending.map(node => {
                const restored = nodes.current.find(item => item.id === node.id);
                return restored?.metadata?.status === "success"
                    ? { nodeId: node.id, status: "success", url: restored.metadata.content, storageKey: restored.metadata.storageKey }
                    : { nodeId: node.id, status: "failed", error: restored?.metadata?.errorDetails || "原图片任务仍待查询" };
            });
        },
        async recoverImageTask(nodeId: string, binding: CanvasImageTaskBinding) {
            const recoveries = scope.recoveries;
            if (!current(nodeId, binding) || recoveries.has(nodeId) || generating.current.has(nodeId)) return;
            const controller = new AbortController();
            // No await precedes this shared lock, including after concurrent imports.
            recoveries.set(nodeId, controller);
            try {
                await runtime.recover(nodeId, binding, controller.signal);
            } finally {
                if (recoveries.get(nodeId) === controller) recoveries.delete(nodeId);
            }
        },
        async prepare(nodeId: string, binding: CanvasImageTaskBinding, signal: AbortSignal) {
            const previous = nodes.current.find(node => node.id === nodeId)?.metadata;
            if (previous?.imageTask) throw new Error("该图片已有原任务，请先恢复查询");
            const previousSourceTaskId = previous?.sourceTaskId;
            try {
                await patch(nodeId, binding, { imageTask: binding, sourceTaskId: undefined, status: "loading", errorDetails: undefined }, false);
                signal.throwIfAborted();
            } catch (error) {
                // This callback is awaited before POST: a failed first save is known not to have submitted.
                if (current(nodeId, binding)) {
                    flushSync(() => setNodes(previous => previous.map(node => node.id === nodeId ? {
                        ...node, metadata: { ...node.metadata, imageTask: undefined, sourceTaskId: previousSourceTaskId },
                    } : node)));
                    flushPendingSave();
                    useCanvasStore.getState().updateProject(binding.projectId, { nodes: nodes.current });
                }
                throw error;
            }
        },
        async submitted(nodeId: string, binding: CanvasImageTaskBinding, ids: string[]) {
            const taskId = ids[0];
            if (!taskId) throw new Error("服务器没有返回图片任务编号");
            await patch(nodeId, binding, { imageTask: { ...binding, taskId }, sourceTaskId: taskId });
        },
        async recover(nodeId: string, binding: CanvasImageTaskBinding, signal: AbortSignal) {
            const valid = () => current(nodeId, binding) && !signal.aborted;
            try {
                await patch(nodeId, binding, { status: "loading", errorDetails: undefined });
                const task = await observeCanvasImageTask(binding, {
                    signal, isCurrent: valid,
                    getTask: getQueuedTask, getByRequestId: getQueuedTaskByRequestId,
                    onTask: async task => {
                        if (nodes.current.find(node => node.id === nodeId)?.metadata?.imageTask?.taskId !== task.id) {
                            await patch(nodeId, binding, { imageTask: { ...binding, taskId: task.id }, sourceTaskId: task.id });
                        }
                    },
                });
                if (!valid()) return;
                if (!task) throw new Error("未找到原图片任务，提交状态待核查；再次点击仅查询原任务，不会重新生成。");
                if (task.status !== "success") {
                    const terminal = task.status === "failed" || task.status === "cancelled";
                    await patch(nodeId, binding, {
                        status: "error", sourceTaskId: task.id,
                        errorDetails: task.failureReason || (terminal ? "原图片任务已失败或取消" : "原图片任务已暂停，提交状态待核查，请勿重复生成。"),
                        ...(terminal ? { imageTask: undefined } : {}),
                    });
                    return;
                }
                const url = task.resultUrls[binding.resultIndex];
                if (!url) throw new Error("原图片任务已完成，但结果暂不可用；再次点击仅查询原任务。");
                const image = await uploadImage(url);
                if (!valid()) return;
                // Refill the original node at its existing position, respecting the image ratio.
                await patch(nodeId, binding, {
                    imageTask: undefined, sourceTaskId: task.id, content: image.url, storageKey: image.storageKey,
                    naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType,
                    status: "success", errorDetails: undefined, optimizingPrompt: false,
                    // Older task records omit these fields; missing metadata must not erase the saved request.
                    ...(task.prompt !== undefined ? { prompt: task.prompt } : {}),
                    ...(task.optimized !== undefined ? { optimized: task.optimized } : {}),
                    ...(task.userInput !== undefined ? { userInput: task.userInput } : {}),
                });
            } catch (error) {
                if (valid() && !(error instanceof Error && error.name === "AbortError")) {
                    await patch(nodeId, binding, { status: "error", errorDetails: `${error instanceof Error ? error.message : "原图片任务查询失败"}（保留原任务，可重试查询）` }).catch(() => undefined);
                }
            }
        },
    };
    return runtime;
}
