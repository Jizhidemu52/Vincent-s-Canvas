import { uiText } from "@/lib/i18n";
import { App } from "antd";
import { useCallback, useEffect, useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { createCanvasImageOperationRunner } from "@/lib/canvas/canvas-image-operation";
import { useCanvasGraphStore } from "@/stores/canvas/canvas-graph-store";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasNodeData, ContextMenuState } from "@/types/canvas";
import type { useCanvasDialogs } from "./use-canvas-dialogs";
import type { useCanvasGenerationRuntime } from "./use-canvas-generation-runtime";
import type { CanvasImageActionRuntimeContext, createCanvasImageActionsRuntime } from "./canvas-image-actions-runtime";

export type CanvasImageActionsOptions = {
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
type ImageActions = ReturnType<typeof createCanvasImageActionsRuntime>;

export function useCanvasImageActions(options: CanvasImageActionsOptions) {
    const { projectId } = options;
    const { message } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const setField = useCanvasGraphStore(state => state.setField);
    const scope = useMemo(() => ({ active: true, runner: null as ReturnType<typeof createCanvasImageOperationRunner> | null }), [projectId]);
    useEffect(() => {
        scope.active = true;
        return () => { scope.active = false; scope.runner?.cancelAll(); };
    }, [scope]);
    const runLocalImageOperation = useCallback(async (key: string, label: string, task: (signal: AbortSignal) => Promise<void>) => {
        const ownerId = useUserStore.getState().user?.id;
        const isCurrent = () => scope.active && useUserStore.getState().user?.id === ownerId;
        try {
            const { runCanvasLocalImageOperation } = await import("./canvas-image-actions-runtime");
            return isCurrent() ? runCanvasLocalImageOperation({ scope, projectId, message, key, label, task }) : false;
        } catch {
            if (isCurrent()) message.error(uiText("加载失败，请重试"));
            return false;
        }
    }, [scope, message, projectId]);
    const latest = useRef({ ...options, message, effectiveConfig, setField, runLocalImageOperation });
    latest.current = { ...options, message, effectiveConfig, setField, runLocalImageOperation };

    const invoke = useCallback(async <K extends keyof ImageActions>(action: K, ...args: Parameters<ImageActions[K]>) => {
        const context = latest.current;
        const ownerId = useUserStore.getState().user?.id;
        const isCurrent = () => scope.active && context.designProjectIdRef.current === context.projectId && useUserStore.getState().user?.id === ownerId;
        let module: typeof import("./canvas-image-actions-runtime");
        try { module = await import("./canvas-image-actions-runtime"); }
        catch (error) {
            if (action === "saveManualImageEdit") throw error;
            if (isCurrent()) message.error(uiText("加载失败，请重试"));
            return;
        }
        if (!isCurrent()) {
            if (action === "saveManualImageEdit") throw new Error("画布或账号已切换，请重新打开图片编辑");
            return;
        }
        const actions = module.createCanvasImageActionsRuntime({ ...context, isCurrent } satisfies CanvasImageActionRuntimeContext);
        const execute = actions[action] as (...values: Parameters<ImageActions[K]>) => Promise<void>;
        await execute(...args);
    }, [message, scope]);

    return useMemo(() => ({
        createImageReversePromptNodes: (...args: Parameters<ImageActions["createImageReversePromptNodes"]>) => invoke("createImageReversePromptNodes", ...args),
        saveManualImageEdit: (...args: Parameters<ImageActions["saveManualImageEdit"]>) => invoke("saveManualImageEdit", ...args),
        cropImageNode: (...args: Parameters<ImageActions["cropImageNode"]>) => invoke("cropImageNode", ...args),
        splitImageNode: (...args: Parameters<ImageActions["splitImageNode"]>) => invoke("splitImageNode", ...args),
        maskEditImageNode: (...args: Parameters<ImageActions["maskEditImageNode"]>) => invoke("maskEditImageNode", ...args),
        upscaleImageNode: (...args: Parameters<ImageActions["upscaleImageNode"]>) => invoke("upscaleImageNode", ...args),
        generateAngleNode: (...args: Parameters<ImageActions["generateAngleNode"]>) => invoke("generateAngleNode", ...args),
        runLocalImageOperation,
    }), [invoke, runLocalImageOperation]);
}
