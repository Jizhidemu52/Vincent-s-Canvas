import { type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { shouldOpenCanvasCreationPanel } from "@/lib/canvas/canvas-layout-breakpoint";
import type { CanvasPerformanceScenarioNodeCount } from "@/lib/canvas/canvas-performance-scenario";
import { abortPendingCanvasRequests, createCanvasProjectAsyncLifecycle } from "@/lib/canvas/canvas-project-async-lifecycle";
import { normalizeCanvasSelectedNodeIds } from "@/lib/canvas/canvas-view-state";
import { releaseUnusedMediaObjectUrls } from "@/services/file-storage";
import { releaseUnusedImageObjectUrls } from "@/services/image-storage";
import { useCanvasGraphSetter } from "@/stores/canvas/canvas-graph-store";
import { loadCanvasProject, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { type CanvasAssistantSession, type CanvasNodeData, type CanvasNodeGroup, type ViewportTransform } from "@/types/canvas";
import { App } from "antd";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useCanvasGenerationRuntime } from "./use-canvas-generation-runtime";
import { boundedCanvasHistory, useCanvasHistoryState } from "./use-canvas-history";
import { useCanvasQuickGeneration } from "./use-canvas-quick-generation";
type Setter<T> = Dispatch<SetStateAction<T>>;
type CanvasProjectHydrationOptions = {
    projectId: string;
    projectLoaded: boolean;
    setProjectLoaded: Setter<boolean>;
    nodesRef: RefObject<CanvasNodeData[]>;
    history: ReturnType<typeof useCanvasHistoryState>;
    runtime: ReturnType<typeof useCanvasGenerationRuntime>;
    quickGeneration: Pick<ReturnType<typeof useCanvasQuickGeneration>, "setQuickGeneratePosition" | "setQuickGenerateRunning" | "setQuickGenerateOpen">;
    scenario: { usePerformanceScenario: boolean; performanceFixtureSize: CanvasPerformanceScenarioNodeCount | null; performanceScenarioIncludesImages: boolean };
    view: {
        setGroups: Setter<CanvasNodeGroup[]>;
        setChatSessions: Setter<CanvasAssistantSession[]>;
        setActiveChatId: Setter<string | null>;
        setBackgroundMode: Setter<CanvasBackgroundMode>;
        setShowImageInfo: Setter<boolean>;
        setViewport: Setter<ViewportTransform>;
    };
    resetEditor: () => void;
};

const loadExperienceMetrics = () => import("@/lib/canvas/canvas-experience-metrics");
const loadHydrationRuntime = () => import("./canvas-project-hydration");

export function useCanvasProjectHydration({ projectId, projectLoaded, setProjectLoaded, nodesRef, history, runtime, quickGeneration, scenario, view, resetEditor }: CanvasProjectHydrationOptions) {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const hydrated = useCanvasStore((state) => state.hydrated);
    const openProject = useCanvasStore((state) => state.openProject);
    const setNodes = useCanvasGraphSetter("nodes");
    const setConnections = useCanvasGraphSetter("connections");
    const setSelectedNodeIds = useCanvasGraphSetter("selectedNodeIds");
    const setStreamedTextById = useCanvasGraphSetter("streamedTextById");
    const { historyRef, lastHistoryRef, historyCommitTimerRef, applyingHistoryRef, pendingHistoryEntryRef, historyPausedRef, setHistoryState } = history;
    const { generationRequestsRef, textStreamBufferRef, setRunningNodeId, recoverPending } = runtime;
    const { setQuickGeneratePosition, setQuickGenerateRunning, setQuickGenerateOpen } = quickGeneration;
    const { usePerformanceScenario, performanceFixtureSize, performanceScenarioIncludesImages } = scenario;
    const { setGroups, setChatSessions, setActiveChatId, setBackgroundMode, setShowImageInfo, setViewport } = view;
    const projectAsyncLifecycleRef = useRef(createCanvasProjectAsyncLifecycle());

    const releaseStaleCanvasObjectUrls = useCallback((restoredNodes: CanvasNodeData[], restoredSessions: CanvasAssistantSession[]) => {
        const assets = useAssetStore.getState().assets;
        const usedData = { assets, nodes: restoredNodes, chatSessions: restoredSessions, history: historyRef.current, lastHistory: lastHistoryRef.current };
        releaseUnusedImageObjectUrls(usedData);
        releaseUnusedMediaObjectUrls(usedData);
    }, []);

    useEffect(() => {
        if (!hydrated) return;
        const lifecycle = projectAsyncLifecycleRef.current;
        const restoreToken = lifecycle.begin();
        const openedAt = performance.now();
        pendingHistoryEntryRef.current = null;
        applyingHistoryRef.current = false;
        resetEditor();
        const invalidateRestore = () => lifecycle.invalidate(restoreToken);
        setProjectLoaded(false);
        setQuickGeneratePosition(null);

        textStreamBufferRef.current?.cancel();
        setStreamedTextById((current) => (current.size ? new Map() : current));
        abortPendingCanvasRequests(generationRequestsRef.current);
        setRunningNodeId(null);
        setQuickGenerateRunning(false);
        if (usePerformanceScenario && performanceFixtureSize !== null) {
            void import("@/lib/canvas/canvas-performance-scenario").then(({ createCanvasPerformanceScenario }) => {
            if (!lifecycle.isCurrent(restoreToken)) return;
            const scenario = createCanvasPerformanceScenario(performanceFixtureSize, { includeImageContent: performanceScenarioIncludesImages });
            historyPausedRef.current = true;
            setNodes(scenario.nodes);
            setConnections(scenario.connections);
            setGroups([]);
            setChatSessions([]);
            setActiveChatId(null);
            setBackgroundMode("dots");
            setShowImageInfo(false);
            setViewport(scenario.viewport);
            historyRef.current = { past: [], future: [] };
            lastHistoryRef.current = null;
            setHistoryState({ canUndo: false, canRedo: false });
            setProjectLoaded(true);
            }).catch(() => {
                if (!lifecycle.isCurrent(restoreToken)) return;
                message.error("性能测试场景加载失败，请重新打开");
                navigate("/canvas", { replace: true });
            });
            return invalidateRestore;
        }

        historyPausedRef.current = false;
        const restore = async () => {
        let project: CanvasProject | null;
        let hydrationRuntime: Awaited<ReturnType<typeof loadHydrationRuntime>>;
        try {
            [project, hydrationRuntime] = await Promise.all([
                openProject(projectId) || loadCanvasProject(projectId), loadHydrationRuntime(),
            ]);
        }
        catch (error) {
            if (lifecycle.isCurrent(restoreToken)) {
                message.error(error instanceof Error ? error.message : "画布读取失败，请重试");
                navigate("/canvas", { replace: true });
            }
            return;
        }
        if (!lifecycle.isCurrent(restoreToken)) return;
        if (!project) {
            navigate("/canvas", { replace: true });
            return;
        }

        const restoredGroups = project.groups || [];
        const commitRestoredProject = (restoredNodes: CanvasNodeData[], restoredSessions: CanvasAssistantSession[], restoredHistory = boundedCanvasHistory(project.history)) => {
            if (!lifecycle.isCurrent(restoreToken)) return;
            setNodes(restoredNodes);
            setQuickGenerateOpen(shouldOpenCanvasCreationPanel(restoredNodes.length, window.innerWidth));
            setConnections(project.connections);
            setGroups(restoredGroups);
            setChatSessions(restoredSessions);
            setActiveChatId(project.activeChatId || null);
            setBackgroundMode(project.backgroundMode);
            setShowImageInfo(project.showImageInfo || false);
            setViewport(project.viewport);
            setSelectedNodeIds(new Set(normalizeCanvasSelectedNodeIds(project.selectedNodeIds, restoredNodes, restoredGroups)));
            historyRef.current = restoredHistory;
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
            lastHistoryRef.current = {
                nodes: restoredNodes,
                connections: project.connections,
                groups: restoredGroups,
                chatSessions: restoredSessions,
                activeChatId: project.activeChatId || null,
                backgroundMode: project.backgroundMode,
                showImageInfo: project.showImageInfo || false,
            };
            setHistoryState({ canUndo: restoredHistory.past.length > 0, canRedo: restoredHistory.future.length > 0 });
            setProjectLoaded(true);
            requestAnimationFrame(() => {
                if (lifecycle.isCurrent(restoreToken)) {
                    const elapsed = performance.now() - openedAt;
                    void loadExperienceMetrics().then(metrics => metrics.recordCanvasOpen(elapsed, restoredNodes.length)).catch(() => undefined);
                    releaseStaleCanvasObjectUrls(restoredNodes, restoredSessions);
                }
            });
        };

            const { createCanvasHydrationContext, hydrateAssistantImages, hydrateCanvasHistory, hydrateCanvasImages, resetInterruptedGeneration } = hydrationRuntime;
            const hydration = createCanvasHydrationContext();
            try {
                const restoredNodes = await hydrateCanvasImages(resetInterruptedGeneration(project.nodes, hydration), hydration);
                if (!lifecycle.isCurrent(restoreToken)) return;
                const restoredSessions = await hydrateAssistantImages(project.chatSessions || [], restoredNodes, hydration);
                const restoredHistory = await hydrateCanvasHistory(project.history, hydration);
                commitRestoredProject(restoredNodes, restoredSessions, restoredHistory);
            } catch (error) {
                if (!lifecycle.isCurrent(restoreToken)) return;
                const reason = error instanceof Error ? error.message : "素材恢复失败";
                message.warning(`部分素材恢复失败，已保留原始项目内容：${reason}`);
                commitRestoredProject(resetInterruptedGeneration(project.nodes, hydration), project.chatSessions || []);
            }
        };
        void restore();
        return invalidateRestore;
    }, [hydrated, message, navigate, openProject, performanceFixtureSize, performanceScenarioIncludesImages, projectId, releaseStaleCanvasObjectUrls, resetEditor, usePerformanceScenario]);

    useEffect(() => {
        // Only the live restored graph is observed; history hydration stays side-effect free.
        if (projectLoaded && !usePerformanceScenario && nodesRef.current.some(node => node.metadata?.imageTask)) void recoverPending();
    }, [projectLoaded, projectId, recoverPending, usePerformanceScenario]);
}
