import { uiText } from "@/lib/i18n";
import { currentToolConfig } from "@/hooks/use-tool-config";
import { stopCanvasObservation } from "@/lib/canvas/canvas-project-async-lifecycle";
import { type QueuedBatchAction } from "@/services/api/generation-tasks";
import { useCanvasGraphSetter } from "@/stores/canvas/canvas-graph-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { type AiConfig, useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { type Position } from "@/types/canvas";
import { App } from "antd";
import { nanoid } from "nanoid";
import type { ChangeEvent as ReactChangeEvent, RefObject, SetStateAction } from "react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BatchEditFileItem } from "./canvas-batch-edit-runtime";
import { imageMetadata } from "./canvas-project-utils";
const loadBatchEditRuntime = () => import("./canvas-batch-edit-runtime");

type BatchEditState = {
    id: string; label: string; prompt: string; optimizePrompt: boolean; optimizing: boolean;
    imageSettings: Partial<AiConfig>; items: BatchEditFileItem[]; running: boolean;
    serverId: string | null; action: QueuedBatchAction | null; inputVersion: number;
};
export type CanvasBatchEditSummary = {
    id: string; label: string; running: boolean; status: "draft" | "running" | "pending" | "finished"; total: number; completed: number;
};
const newBatch = (index: number): BatchEditState => ({ id: nanoid(), label: "批次 " + index, prompt: "", optimizePrompt: false, optimizing: false,
    imageSettings: {}, items: [], running: false, serverId: null, action: null, inputVersion: 0 });
const resolveValue = <T,>(value: SetStateAction<T>, previous: T): T => typeof value === "function" ? (value as (previous: T) => T)(previous) : value;

export function useCanvasBatchEdit({ projectId, generationDispatchLocksRef, getCanvasCenter, handleMissingModelConfig, isAiConfigReady, flushPendingHistory, waitForWriteAccess, isObservationCurrent }: {
    projectId: string;
    generationDispatchLocksRef: RefObject<Set<string>>;
    getCanvasCenter: () => Position;
    handleMissingModelConfig: () => void;
    isAiConfigReady: (...args: unknown[]) => boolean;
    flushPendingHistory?: () => unknown;
    waitForWriteAccess: () => Promise<boolean>;
    isObservationCurrent: () => boolean;
}) {
    const { message } = App.useApp();
    const effectiveConfig = useEffectiveConfig("canvas");
    const ownerId = useUserStore(state => state.user?.id);
    const ownerStatus = useUserStore(state => state.user?.status);
    const ownerRole = useUserStore(state => state.user?.role);
    const estimateUsage = useBusinessConfigStore(state => state.estimate);
    const addAssets = useAssetStore(state => state.addAssets);
    const setNodes = useCanvasGraphSetter("nodes");
    const setConnections = useCanvasGraphSetter("connections");
    const setSelectedNodeIds = useCanvasGraphSetter("selectedNodeIds");
    const [batchEditOpen, setBatchEditOpen] = useState(false);
    const batchInputVersionRef = useRef(0);
    const fileSelectionVersionRef = useRef(0);
    const nextBatchIndexRef = useRef(1);
    const initialBatchRef = useRef<BatchEditState | null>(null);
    if (!initialBatchRef.current) initialBatchRef.current = newBatch(nextBatchIndexRef.current++);
    const [batches, setBatches] = useState<BatchEditState[]>([initialBatchRef.current]);
    const batchesRef = useRef(batches);
    const [activeBatchEditId, setActiveBatchEditId] = useState(initialBatchRef.current.id);
    const activeBatchIdRef = useRef(activeBatchEditId);
    const [selectionEpoch, setSelectionEpoch] = useState(0);
    const selectionEpochRef = useRef(0);
    const runsRef = useRef(new Map<string, AbortController>());
    const scope = useMemo(() => ({ active: true }), [projectId, ownerId, ownerStatus, ownerRole]);
    const scopeRef = useRef(scope);
    const current = useCallback(() => scope.active && scopeRef.current === scope && isObservationCurrent()
        && Boolean(ownerId) && useUserStore.getState().user?.id === ownerId && useUserStore.getState().user?.status === "active"
        && useUserStore.getState().user?.role === ownerRole, [scope, isObservationCurrent, ownerId, ownerRole]);
    useLayoutEffect(() => {
        scope.active = true;
        if (scopeRef.current !== scope) {
            scopeRef.current = scope;
            const batch = newBatch(nextBatchIndexRef.current++);
            batchesRef.current = [batch]; setBatches([batch]);
            activeBatchIdRef.current = batch.id; setActiveBatchEditId(batch.id);
            selectionEpochRef.current += 1; setSelectionEpoch(selectionEpochRef.current);
            batchInputVersionRef.current += 1;
            setBatchEditOpen(false);
        }
        return () => {
            scope.active = false;
            runsRef.current.forEach(controller => stopCanvasObservation(controller));
            runsRef.current.clear();
        };
    }, [scope]);

    const updateBatch = useCallback((id: string, update: (batch: BatchEditState) => BatchEditState) => {
        const previous = batchesRef.current;
        let changed = false;
        const next = previous.map(batch => {
            if (batch.id !== id) return batch;
            const updated = update(batch); changed ||= updated !== batch; return updated;
        });
        if (changed) { batchesRef.current = next; setBatches(next); }
    }, []);
    const updateInput = useCallback((update: (batch: BatchEditState) => BatchEditState) => {
        if (!current() || activeBatchIdRef.current !== activeBatchEditId || selectionEpochRef.current !== selectionEpoch) return;
        updateBatch(activeBatchEditId, batch => {
            if (batch.running || batch.items.some(item => item.requestId)) return batch;
            batchInputVersionRef.current += 1;
            return { ...update(batch), inputVersion: batch.inputVersion + 1 };
        });
    }, [activeBatchEditId, current, selectionEpoch, updateBatch]);
    const setBatchEditPrompt = useCallback((value: SetStateAction<string>) => updateInput(batch => ({ ...batch, prompt: resolveValue(value, batch.prompt) })), [updateInput]);
    const setBatchImageSettings = useCallback((value: SetStateAction<Partial<AiConfig>>) => updateInput(batch => ({ ...batch, imageSettings: resolveValue(value, batch.imageSettings) })), [updateInput]);
    const setBatchOptimizePrompt = useCallback((value: SetStateAction<boolean>) => updateInput(batch => ({ ...batch, optimizePrompt: resolveValue(value, batch.optimizePrompt) })), [updateInput]);
    const setBatchEditItems = useCallback((value: SetStateAction<BatchEditFileItem[]>) => updateInput(batch => {
        fileSelectionVersionRef.current += 1;
        return { ...batch, items: resolveValue(value, batch.items) };
    }), [updateInput]);
    const activateBatch = useCallback((id: string) => {
        activeBatchIdRef.current = id; setActiveBatchEditId(id); batchInputVersionRef.current += 1;
        selectionEpochRef.current += 1; setSelectionEpoch(selectionEpochRef.current);
    }, []);
    const createBatchEdit = useCallback(() => {
        if (!current()) return;
        const batch = newBatch(nextBatchIndexRef.current++);
        batchesRef.current = [...batchesRef.current, batch]; setBatches(batchesRef.current);
        activateBatch(batch.id); setBatchEditOpen(true);
    }, [activateBatch, current]);
    const selectBatchEdit = useCallback((id: string) => {
        if (current() && batchesRef.current.some(batch => batch.id === id)) activateBatch(id);
    }, [activateBatch, current]);
    const applyBatchEditTemplate = useCallback((prompt: string, settings: Partial<AiConfig>) => {
        if (!current()) return;
        const active = batchesRef.current.find(batch => batch.id === activeBatchIdRef.current);
        const reusable = active && !active.running && !active.prompt && !active.items.length && !Object.keys(active.imageSettings).length;
        const batch = { ...(reusable ? active : newBatch(nextBatchIndexRef.current++)), prompt, imageSettings: { ...settings }, inputVersion: (reusable ? active.inputVersion : 0) + 1 };
        batchesRef.current = reusable ? batchesRef.current.map(item => item.id === batch.id ? batch : item) : [...batchesRef.current, batch];
        setBatches(batchesRef.current); activateBatch(batch.id); setBatchEditOpen(true);
    }, [activateBatch, current]);
    const applyBatchEditFiles = useCallback(async (files: FileList | File[] | null) => {
        if (!current() || activeBatchIdRef.current !== activeBatchEditId || selectionEpochRef.current !== selectionEpoch) return;
        const batch = batchesRef.current.find(item => item.id === activeBatchEditId);
        if (!batch || batch.running || batch.items.some(item => item.requestId)) return;
        const selected = Array.from(files || []), fileSelectionVersion = ++fileSelectionVersionRef.current;
        try {
            const { prepareCanvasBatchFiles } = await loadBatchEditRuntime();
            if (!current() || activeBatchIdRef.current !== activeBatchEditId || selectionEpochRef.current !== selectionEpoch || fileSelectionVersionRef.current !== fileSelectionVersion) return;
            const items = prepareCanvasBatchFiles(selected);
            updateBatch(batch.id, previous => {
                if (previous.running || previous.items.some(item => item.requestId)) return previous;
                batchInputVersionRef.current += 1;
                return { ...previous, items, inputVersion: previous.inputVersion + 1 };
            });
        } catch (error) { if (current()) message.warning(String(error instanceof Error ? error.message : error)); }
    }, [activeBatchEditId, current, message, selectionEpoch, updateBatch]);
    const handleBatchFolderInputChange = useCallback((event: ReactChangeEvent<HTMLInputElement>) => {
        void applyBatchEditFiles(event.target.files); event.target.value = "";
    }, [applyBatchEditFiles]);

    const runBatchImageEdit = useCallback(async () => {
        if (activeBatchIdRef.current !== activeBatchEditId || selectionEpochRef.current !== selectionEpoch) return;
        const batch = batchesRef.current.find(item => item.id === activeBatchEditId);
        if (!batch || !current()) return;
        const key = "canvas-batch:" + batch.id;
        if (generationDispatchLocksRef.current.has(key) || batch.running) { message.info(uiText("该批次仍在执行，可新建批次继续创作")); return; }
        generationDispatchLocksRef.current.add(key);
        const controller = new AbortController(); runsRef.current.set(batch.id, controller);
        const isCurrent = () => {
            const valid = current() && runsRef.current.get(batch.id) === controller;
            if (!valid && !controller.signal.aborted) stopCanvasObservation(controller);
            return valid && !controller.signal.aborted;
        };
        const canWrite = async () => {
            if (!isCurrent()) return false;
            const allowed = await waitForWriteAccess();
            if (!allowed || !isCurrent()) { stopCanvasObservation(controller); return false; }
            return true;
        };
        const update = (change: (value: BatchEditState) => BatchEditState) => { if (isCurrent()) updateBatch(batch.id, change); };
        const scopedMessage = Object.fromEntries(["error", "warning", "success"].map(level => [level, (text: string) => { if (isCurrent()) message[level as "error" | "warning" | "success"](text); }])) as Pick<typeof message, "error" | "warning" | "success">;
        update(value => ({ ...value, running: true }));
        const user = useUserStore.getState().user;
        try {
            if (!await canWrite()) return;
            const config = currentToolConfig({ ...effectiveConfig, ...batch.imageSettings, model: batch.imageSettings.model || effectiveConfig.imageModel || effectiveConfig.model, count: "1" }, "canvas-batch");
            const { runCanvasBatchImageEdit } = await loadBatchEditRuntime();
            if (!await canWrite()) return;
            await runCanvasBatchImageEdit({
                prompt: batch.prompt, optimizePrompt: batch.optimizePrompt, items: batch.items.map(item => ({ ...item })), config: { ...config }, estimate: estimateUsage, isAiConfigReady,
                onMissingModel: handleMissingModelConfig, user, projectId, getCenter: getCanvasCenter, imageMetadata, addAssets,
                setOptimizing: value => update(previous => ({ ...previous, optimizing: value })),
                setRunning: value => update(previous => ({ ...previous, running: resolveValue(value, previous.running) })),
                setServerId: value => update(previous => ({ ...previous, serverId: resolveValue(value, previous.serverId) })),
                setAction: value => update(previous => ({ ...previous, action: resolveValue(value, previous.action) })),
                setItems: value => update(previous => ({ ...previous, items: resolveValue(value, previous.items) })),
                setNodes, setConnections, setSelectedNodeIds,
                flushPendingHistory, message: scopedMessage, signal: controller.signal, isCurrent, waitForWriteAccess: canWrite,
            });
        } catch (error) {
            if (isCurrent()) message.error(error instanceof Error ? error.message : uiText("批量改图加载失败"));
        } finally {
            update(value => ({ ...value, running: false, optimizing: false }));
            if (runsRef.current.get(batch.id) === controller) runsRef.current.delete(batch.id);
            generationDispatchLocksRef.current.delete(key);
        }
    }, [activeBatchEditId, addAssets, current, effectiveConfig, estimateUsage, flushPendingHistory, generationDispatchLocksRef, getCanvasCenter, handleMissingModelConfig, isAiConfigReady, message, projectId, selectionEpoch, setConnections, setNodes, setSelectedNodeIds, updateBatch, waitForWriteAccess]);

    const controlActiveBatchEdit = useCallback(async (action: QueuedBatchAction) => {
        if (activeBatchIdRef.current !== activeBatchEditId || selectionEpochRef.current !== selectionEpoch) return;
        const batch = batchesRef.current.find(item => item.id === activeBatchEditId);
        if (!batch?.serverId || batch.action || !current()) return;
        updateBatch(batch.id, previous => ({ ...previous, action }));
        try {
            const { controlCanvasBatch } = await loadBatchEditRuntime();
            if (!await waitForWriteAccess() || !current()) return;
            const scopedMessage = { success: (text: string) => { if (current()) message.success(text); }, error: (text: string) => { if (current()) message.error(text); }, warning: (text: string) => { if (current()) message.warning(text); } };
            await controlCanvasBatch(batch.serverId, action, scopedMessage);
        } catch (error) { if (current()) message.error(String(error instanceof Error ? error.message : error)); }
        finally { if (current()) updateBatch(batch.id, previous => ({ ...previous, action: null })); }
    }, [activeBatchEditId, current, message, selectionEpoch, updateBatch, waitForWriteAccess]);
    const active = batches.find(batch => batch.id === activeBatchEditId) || batches[0]!;
    const batchEditBatches: CanvasBatchEditSummary[] = batches.map(batch => ({ id: batch.id, label: batch.label, running: batch.running, total: batch.items.length,
        completed: batch.items.filter(item => ["success", "failed", "cancelled"].includes(item.status)).length,
        status: batch.running ? "running" : batch.items.some(item => item.requestId && item.status === "paused") ? "pending" : batch.items.some(item => item.status !== "waiting") ? "finished" : "draft" }));
    return {
        batchEditOpen, setBatchEditOpen, batchEditPrompt: active.prompt, setBatchEditPrompt, batchInputVersionRef, batchOptimizePrompt: active.optimizePrompt, setBatchOptimizePrompt,
        batchOptimizing: active.optimizing, batchImageSettings: active.imageSettings, setBatchImageSettings, batchEditItems: active.items, setBatchEditItems,
        batchEditRunning: active.running, batchEditServerId: active.serverId, batchEditAction: active.action, applyBatchEditFiles, handleBatchFolderInputChange, runBatchImageEdit, controlActiveBatchEdit,
        batchEditBatches, activeBatchEditId, createBatchEdit, selectBatchEdit, applyBatchEditTemplate,
    };
}
