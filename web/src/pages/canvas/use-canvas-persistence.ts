import { useEffect, useRef, type RefObject } from "react";
import { createCanvasProjectSaveQueue, type CanvasProjectSaveQueue } from "@/lib/canvas/canvas-project-save-queue";
import { flushCanvasPersistence, hasPendingCanvasPersistence, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasProjectPatch } from "@/lib/canvas/canvas-project-update";
import type { ViewportTransform } from "@/types/canvas";
import { normalizeCanvasSelectedNodeIds } from "@/lib/canvas/canvas-view-state";
import { canvasHistoryForSave, type CanvasHistoryEntry, type useCanvasHistoryState } from "./use-canvas-history";

export type CanvasProjectSaveSnapshot = {
    projectId: string;
    patch: Pick<CanvasProject, "nodes" | "connections" | "groups" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "history">;
};

type UpdateProject = (id: string, patch: CanvasProjectPatch) => void;
export function useCanvasPersistenceQueue(updateProject: UpdateProject, writable?: RefObject<boolean>) {
    const projectSaveQueueRef = useRef<CanvasProjectSaveQueue<CanvasProjectSaveSnapshot> | null>(null);
    const projectSaveHandlerRef = useRef<(snapshot: CanvasProjectSaveSnapshot) => void>(() => undefined);
    projectSaveHandlerRef.current = ({ projectId: id, patch }) => updateProject(id, patch);
    if (!projectSaveQueueRef.current) {
        projectSaveQueueRef.current = createCanvasProjectSaveQueue(180, (snapshot) => projectSaveHandlerRef.current(snapshot), undefined, () => writable?.current !== false);
    }
    return projectSaveQueueRef;
}

export function useCanvasPersistence(options: {
    projectId: string; projectLoaded: boolean; usePerformanceScenario: boolean;
    projectSaveQueueRef: RefObject<CanvasProjectSaveQueue<CanvasProjectSaveSnapshot> | null>;
    history: ReturnType<typeof useCanvasHistoryState>; current: CanvasHistoryEntry;
    updateProject: UpdateProject; batchEditRunning: boolean; runningNodeId: string | null;
    viewport: ViewportTransform;
    selectedNodeIds?: ReadonlySet<string>;
    writable?: RefObject<boolean>;
}) {
    const { projectId, projectLoaded, usePerformanceScenario, projectSaveQueueRef, updateProject, batchEditRunning, runningNodeId, viewport, selectedNodeIds } = options;
    const canWrite = options.writable?.current !== false;
    const { historyRef, lastHistoryRef, historyPausedRef, applyingHistoryRef, historyState } = options.history;
    const { nodes, connections, groups, chatSessions, activeChatId, backgroundMode, showImageInfo } = options.current;
    const savedProjectIdRef = useRef(projectId);
    const viewportSaveQueueRef = useRef<CanvasProjectSaveQueue<{ projectId: string; viewport: ViewportTransform; selectedNodeIds?: string[] }> | null>(null);
    const viewportSaveHandlerRef = useRef(updateProject);
    viewportSaveHandlerRef.current = updateProject;
    if (!viewportSaveQueueRef.current) {
        viewportSaveQueueRef.current = createCanvasProjectSaveQueue(500, ({ projectId: id, ...viewState }) => viewportSaveHandlerRef.current(id, viewState), undefined, () => options.writable?.current !== false);
    }
    useEffect(() => {
        if (savedProjectIdRef.current === projectId) return;
        projectSaveQueueRef.current?.flush();
        viewportSaveQueueRef.current?.flush();
        savedProjectIdRef.current = projectId;
    }, [projectId]);

    useEffect(() => {
        if (!projectLoaded || historyPausedRef.current || usePerformanceScenario || options.writable?.current === false) return;
        projectSaveQueueRef.current?.schedule(
            {
                projectId,
                patch: {
                    nodes, connections, groups, chatSessions, activeChatId, backgroundMode, showImageInfo,
                    history: canvasHistoryForSave(historyRef.current, lastHistoryRef.current, { nodes, connections, groups, chatSessions, activeChatId, backgroundMode, showImageInfo }, applyingHistoryRef.current),
                },
            },
            batchEditRunning || runningNodeId ? 900 : 180,
        );
    }, [activeChatId, backgroundMode, batchEditRunning, chatSessions, connections, groups, historyState, nodes, projectId, projectLoaded, runningNodeId, showImageInfo, usePerformanceScenario]);

    useEffect(() => {
        if (!canWrite) return;
        // A quick renewal can finish before React paints "recovering". Let the
        // queues remember the blocked flush instead of relying on that render.
        const resumedProject = projectSaveQueueRef.current?.resume();
        const resumedViewport = viewportSaveQueueRef.current?.resume();
        if (resumedProject || resumedViewport) void flushCanvasPersistence().catch(() => undefined);
    });

    useEffect(() => {
        const flushProjectSave = () => {
            if (options.writable?.current === false) return;
            projectSaveQueueRef.current?.flush();
            viewportSaveQueueRef.current?.flush();
            // The editor queue feeds the store queue. Flush both in this order so
            // the final edit does not wait for a debounce after the page closes.
            void flushCanvasPersistence().catch(() => undefined);
        };
        const onVisibility = () => { if (document.visibilityState === "hidden") flushProjectSave(); };
        const onBeforeUnload = (event: BeforeUnloadEvent) => {
            const pending = projectSaveQueueRef.current?.hasPending() || viewportSaveQueueRef.current?.hasPending() || hasPendingCanvasPersistence();
            flushProjectSave();
            // IndexedDB writes cannot be awaited during unload. Give the user a
            // chance to stay until the pending write finishes instead of losing it silently.
            if (pending) {
                event.preventDefault();
                event.returnValue = "";
            }
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        window.addEventListener("pagehide", flushProjectSave);
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            window.removeEventListener("beforeunload", onBeforeUnload);
            window.removeEventListener("pagehide", flushProjectSave);
            document.removeEventListener("visibilitychange", onVisibility);
            flushProjectSave();
            // A lost editor may only be unmounted after its draft was backed
            // up, or on navigation. Never let its old timers publish later.
            projectSaveQueueRef.current?.discard();
            viewportSaveQueueRef.current?.discard();
        };
    }, []);

    useEffect(() => {
        if (!projectLoaded || usePerformanceScenario || options.writable?.current === false) return;
        // Capture the owner and value together: a project switch must never save
        // the next project's live viewport into the previous project.
        viewportSaveQueueRef.current?.schedule({ projectId, viewport,
            ...(selectedNodeIds ? { selectedNodeIds: normalizeCanvasSelectedNodeIds(selectedNodeIds, nodes, groups) } : {}),
        });
    }, [projectId, projectLoaded, usePerformanceScenario, viewport, selectedNodeIds, nodes, groups]);
    return savedProjectIdRef;
}
