import { uiText } from "@/lib/i18n";
import { useToolConfig } from "@/hooks/use-tool-config";
import { type QueuedBatchAction } from "@/services/api/generation-tasks";
import { useCanvasGraphSetter } from "@/stores/canvas/canvas-graph-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { type AiConfig, useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { type Position } from "@/types/canvas";
import { App } from "antd";
import type { ChangeEvent as ReactChangeEvent, RefObject } from "react";
import { useCallback, useState } from "react";
import type { BatchEditFileItem } from "./canvas-batch-edit-runtime";
import { imageMetadata } from "./canvas-project-utils";
const loadBatchEditRuntime = () => import("./canvas-batch-edit-runtime");

export function useCanvasBatchEdit({ projectId, generationDispatchLocksRef, getCanvasCenter, handleMissingModelConfig, isAiConfigReady, flushPendingHistory }: {
    projectId: string;
    generationDispatchLocksRef: RefObject<Set<string>>;
    getCanvasCenter: () => Position;
    handleMissingModelConfig: () => void;
    isAiConfigReady: (...args: unknown[]) => boolean;
    flushPendingHistory?: () => unknown;
}) {
    const { message } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const estimateUsage = useBusinessConfigStore(state => state.estimate);
    const addAssets = useAssetStore(state => state.addAssets);
    const setNodes = useCanvasGraphSetter("nodes");
    const setConnections = useCanvasGraphSetter("connections");
    const setSelectedNodeIds = useCanvasGraphSetter("selectedNodeIds");
    const [batchEditOpen, setBatchEditOpen] = useState(false);
    const [batchEditPrompt, setBatchEditPrompt] = useState("");
    const [batchOptimizePrompt, setBatchOptimizePrompt] = useState(false);
    const [batchOptimizing, setBatchOptimizing] = useState(false);
    const [batchImageSettings, setBatchImageSettings] = useState<Partial<AiConfig>>({});
    const [batchEditItems, setBatchEditItems] = useState<BatchEditFileItem[]>([]);
    const [batchEditRunning, setBatchEditRunning] = useState(false);
    const [batchEditServerId, setBatchEditServerId] = useState<string | null>(null);
    const [batchEditAction, setBatchEditAction] = useState<QueuedBatchAction | null>(null);
    const batchGenerationConfig = useToolConfig({ ...effectiveConfig, ...batchImageSettings, model: batchImageSettings.model || effectiveConfig.imageModel || effectiveConfig.model, count: "1" }, "canvas-batch");

    const applyBatchEditFiles = useCallback(async (files: FileList | File[] | null) => {
        const selected = Array.from(files || []);
        try {
            const { prepareCanvasBatchFiles } = await loadBatchEditRuntime();
            setBatchEditItems(prepareCanvasBatchFiles(selected));
        } catch (error) {
            message.warning(String(error instanceof Error ? error.message : error));
        }
    }, [message]);

    const handleBatchFolderInputChange = useCallback(
        (event: ReactChangeEvent<HTMLInputElement>) => {
            applyBatchEditFiles(event.target.files);
            event.target.value = "";
        },
        [applyBatchEditFiles],
    );

    const runBatchImageEdit = useCallback(async () => {
        const user = useUserStore.getState().user;
        if (generationDispatchLocksRef.current.size) { message.info(uiText("当前任务仍在执行，请完成或停止后再运行")); return; }
        generationDispatchLocksRef.current.add("canvas-batch");
        setBatchEditRunning(true);
        try {
            const { runCanvasBatchImageEdit } = await loadBatchEditRuntime();
            await runCanvasBatchImageEdit({
                prompt: batchEditPrompt, optimizePrompt: batchOptimizePrompt, setOptimizing: setBatchOptimizing, items: batchEditItems, config: batchGenerationConfig, estimate: estimateUsage, isAiConfigReady,
                onMissingModel: handleMissingModelConfig, user, projectId, getCenter: getCanvasCenter, imageMetadata, addAssets,
                setRunning: setBatchEditRunning, setServerId: setBatchEditServerId, setAction: setBatchEditAction, setItems: setBatchEditItems,
                setNodes, setConnections, setSelectedNodeIds, flushPendingHistory, message,
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : uiText("批量改图加载失败"));
        } finally {
            generationDispatchLocksRef.current.delete("canvas-batch");
            setBatchEditRunning(false);
        }
    }, [addAssets, batchEditItems, batchEditPrompt, batchOptimizePrompt, batchGenerationConfig, estimateUsage, flushPendingHistory, getCanvasCenter, handleMissingModelConfig, isAiConfigReady, message, projectId]);

    const controlActiveBatchEdit = useCallback(async (action: QueuedBatchAction) => {
        if (!batchEditServerId) return;
        setBatchEditAction(action);
        try {
            const { controlCanvasBatch } = await loadBatchEditRuntime();
            await controlCanvasBatch(batchEditServerId, action, message);
        } catch (error) {
            message.error(String(error instanceof Error ? error.message : error));
        } finally {
            setBatchEditAction(null);
        }
    }, [batchEditServerId, message]);

    return {
        batchEditOpen, setBatchEditOpen, batchEditPrompt, setBatchEditPrompt, batchOptimizePrompt, setBatchOptimizePrompt,
        batchOptimizing, batchImageSettings, setBatchImageSettings, batchEditItems, setBatchEditItems,
        batchEditRunning, batchEditServerId, batchEditAction, applyBatchEditFiles, handleBatchFolderInputChange, runBatchImageEdit, controlActiveBatchEdit,
    };
}
