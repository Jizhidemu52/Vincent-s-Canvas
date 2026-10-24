import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ChangeEvent as ReactChangeEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronDown, ImageIcon, X } from "lucide-react";

import { requestImageQuestion } from "@/services/api/image";
import type { BatchEditFileItem } from "./canvas-batch-edit-runtime";
import { canvasToolKey, currentToolConfig, useToolConfig } from "@/hooks/use-tool-config";
import { useCanvasGenerationRuntime } from "./use-canvas-generation-runtime";
import { useCanvasImageSequence } from "./use-canvas-image-sequence";
import { QueuedTaskFailedError, QueuedTaskPausedError, type QueuedBatchAction } from "@/services/api/generation-tasks";
import { requestAudioGeneration, storeGeneratedAudio } from "@/services/api/audio";
import { recoverVideoGenerationTask, requestVideoGeneration, storeGeneratedVideo } from "@/services/api/video";
import { fetchServerAssetContent } from "@/services/api/server-assets";
import { hydratePromptReuse } from "@/services/api/prompts";
import { promptImageSettings } from "@/lib/prompt-editor-parameters";
import { defaultConfig, modelOptionName, type AiConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { releaseUnusedImageObjectUrls, resolveImageUrl, uploadImage, type UploadedImage } from "@/services/image-storage";
import { releaseUnusedMediaObjectUrls, resolveMediaUrl, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { nanoid } from "nanoid";
import { getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { deploymentFeatures } from "@/lib/deployment-features";
import { getCanvasAntThemeConfig } from "@/lib/app-theme";
import { useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { loadCanvasImageTools } from "@/lib/canvas/canvas-image-tool-loader";
import { createCanvasImageOperationRunner } from "@/lib/canvas/canvas-image-operation";
import { assertCanvasImageUploadSize } from "@/lib/canvas/canvas-image-upload-limit";
import { canvasImageUsageInput } from "@/lib/canvas/canvas-image-usage";
import { cloneCanvasNodeGraph, copyCanvasNodeGraph, type CanvasNodeGraph } from "@/lib/canvas/canvas-node-copy";
import { clampCanvasZoom } from "@/lib/canvas/canvas-zoom";
import { useCanvasShortcuts } from "./use-canvas-shortcuts";
import { useCanvasClipboardDrop, isCanvasAudioFile as isAudioFile } from "./use-canvas-clipboard-drop";
import { useCanvasHistoryState, useCanvasHistory, boundedCanvasHistory, type CanvasHistoryEntry } from "./use-canvas-history";
import { zoomViewportAtCanvasCenter } from "@/lib/canvas/canvas-viewport-interaction";
import { fitNodeSize, nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { App, ConfigProvider } from "antd";
import { NODE_DEFAULT_SIZE, getNodeSpec } from "@/constant/canvas";
import type { ActiveConnectionPathHandle } from "@/components/canvas/canvas-connections";
import type { CanvasMediaWorkflowAction } from "@/lib/canvas/canvas-assistant-panel-render-stability";
import type { CanvasGroupLayerHandle } from "@/components/canvas/canvas-group-layer";
import { assignCanvasNodeGroup, canvasGroupMemberIds, createCanvasGroupIndex, removeCanvasGroupMembers } from "@/lib/canvas/canvas-node-groups";
import { canvasImagePreviewEdge } from "@/lib/canvas/canvas-image-thumbnail";
import type { CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import type { CanvasImageCropRect } from "@/components/canvas/canvas-node-crop-dialog";
import type { CanvasImageMaskEditPayload } from "@/components/canvas/canvas-node-mask-edit-dialog";
import type { CanvasImageSplitParams } from "@/components/canvas/canvas-node-split-dialog";
import type { CanvasImageUpscaleParams } from "@/components/canvas/canvas-node-upscale-dialog";
import { buildNodeGenerationContext, buildNodeResponseMessages, createConfigGenerationInputIndex, hydrateNodeGenerationContext, type NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import type { CanvasConnectionLayerHandle } from "@/components/canvas/canvas-connection-layer";
import { CanvasOverviewLayer, type CanvasOverviewLayerHandle } from "@/components/canvas/canvas-overview-layer";
import { CanvasSelectionOverlay, type CanvasSelectionOverlayHandle } from "@/components/canvas/canvas-selection-overlay";
import { WirelessCanvas, type WirelessCanvasHandle } from "@/components/canvas/wireless-canvas";
import { CanvasNodeLayer } from "@/components/canvas/canvas-node-layer";
import { CanvasConnectionSvg, CanvasGraphConnectionLayer } from "@/components/canvas/canvas-connection-svg";
import { CanvasHoverToolbarHost } from "@/components/canvas/canvas-hover-toolbar-host";
import { CanvasGraphProvider, useCanvasGraphField, useCanvasGraphSetter } from "@/stores/canvas/canvas-graph-store";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { CanvasToolbar } from "@/components/canvas/canvas-toolbar";
import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { useCanManageConfig } from "@/hooks/use-can-manage-config";
import { useCanvasExport } from "@/hooks/use-canvas-export";
import { useCanvasDesktopLayout } from "@/hooks/use-canvas-desktop-layout";
import { clampCanvasPanelWidth, clampCanvasPromptHeight } from "@/lib/canvas/canvas-panel-width";
import { useCanvasPanelStore } from "@/stores/canvas/use-canvas-panel-store";
import { shouldOpenCanvasCreationPanel } from "@/lib/canvas/canvas-layout-breakpoint";
import { useCanvasAgentStore } from "@/stores/canvas/use-canvas-agent-store";
import { flushCanvasPersistence, loadCanvasProject, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { canvasLinkCopiedMessage } from "@/components/canvas/canvas-save-status";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { useModuleEnabled } from "@/stores/use-module-store";
import { applyCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasAgentUndoRecord } from "@/lib/canvas/canvas-agent-undo";
import { buildWorkflowVideoStageDispatch, completeAgentMediaWorkflowStage, restoreAgentMediaWorkflow, selectWorkflowCandidate } from "@/lib/canvas/agent-media-workflow";
import { buildAgentMediaWorkflowStageOps } from "@/lib/canvas/agent-media-workflow-stage";
import { createCanvasMentionReferenceIndex, createCanvasResourceReferenceIndex } from "@/lib/canvas/canvas-resource-references";
import { canvasImageReferenceMentions, resolveCanvasNodeImageReferences } from "@/lib/canvas/canvas-image-references";
import { syncCanvasSelectionReferences, type CanvasSelectionReference } from "@/lib/canvas/canvas-selection-references";
import { createCanvasSelectionGenerationSync } from "@/lib/canvas/canvas-selection-prompt";
import { placeCanvasImageOutputs } from "@/lib/canvas/canvas-image-output-placement";
import { canvasImageBaseName, canvasImageExportStem, canvasImageVersion, canvasImageReferenceIdentity, originalCanvasImageFileName, originalReferenceFileName } from "@/lib/canvas/canvas-image-filename";
import { canvasCompareSource } from "@/lib/canvas/canvas-image-compare-source";
import { imageModelProfile, normalizeImageModelSettings } from "@/lib/image-model-settings";
import { canvasNodePromptDraftPatch } from "@/lib/canvas/canvas-node-prompt-draft";
import { imageWorkflowConnectionError, normalizeCanvasConnection } from "@/lib/canvas/canvas-shared-connections";
import type { SharedGenerationExecution } from "./canvas-shared-generation-runtime";
import { createCanvasBatchRenderIndex } from "@/lib/canvas/canvas-batch-motion";
import { isCanvasBatchChildHidden, isCanvasBatchConnectionEndpointHidden } from "@/lib/canvas/canvas-batch-visibility";
import { createConnectionAdjacency } from "@/lib/canvas/canvas-connection-geometry";
import { findCanvasConnectionHit } from "@/lib/canvas/canvas-connection-hit-test";
import { findCanvasOverviewNodeHit } from "@/lib/canvas/canvas-overview-hit-test";
import { findCanvasConnectionDropTarget, type CanvasConnectionDropTarget } from "@/lib/canvas/canvas-connection-drop-target";
import { useCanvasPersistence, useCanvasPersistenceQueue } from "./use-canvas-persistence";
import { createCanvasTimeoutRegistry } from "@/lib/canvas/canvas-timeout-registry";
import { beginCanvasHover, commitCanvasHover, endCanvasHover, resetCanvasHover, type CanvasHoverState } from "@/lib/canvas/canvas-hover-stability";
import { createDragPreview, createLivePreviewNodeResolver, type CanvasDragPreview } from "@/lib/canvas/canvas-drag-preview";
import { collectCanvasDragNodes } from "@/lib/canvas/canvas-drag-selection";
import { createCanvasDragNodeElementCache } from "@/lib/canvas/canvas-drag-node-element-cache";
import { createResizePreview, type CanvasResizePreview } from "@/lib/canvas/canvas-resize-preview";
import { canvasNodeResizeStartPosition } from "@/lib/canvas/canvas-node-resize";
import { collectAffectedConnectionIds, refreshVisibleConnectionsForDrag, sameCanvasIdSet } from "@/lib/canvas/canvas-drag-visible-connections";
import { canvasRenderQualityAtScale, isCanvasOverviewScale, nextCanvasRenderQuality, type CanvasRenderQuality } from "@/lib/canvas/canvas-render-quality";
import { createCanvasPerformanceTracker, type CanvasInteractionMetrics, type CanvasVisibilityCounts } from "@/lib/canvas/canvas-performance-metrics";
import { canvasPerformanceFixtureSize, isCanvasPerformanceModeEnabled } from "@/lib/canvas/canvas-performance-scenario-mode";
import { abortPendingCanvasRequests, createCanvasProjectAsyncLifecycle } from "@/lib/canvas/canvas-project-async-lifecycle";
import { mapCanvasAsyncPool } from "@/lib/canvas/canvas-async-pool";
import { shouldPublishCanvasTextStream } from "@/lib/canvas/canvas-text-stream-visibility";
import { createCanvasSelectedNodeCache } from "@/lib/canvas/canvas-selected-node-cache";
import { createCanvasMinimapGeometryCache } from "@/lib/canvas/canvas-minimap-geometry-cache";
import { createCanvasVisibleNodeCache } from "@/lib/canvas/canvas-visible-node-cache";
import { createCanvasNodeMap, refreshCanvasNodeMap } from "@/lib/canvas/canvas-node-map";
import { canvasNodeHasImagePreview } from "@/lib/canvas/canvas-node-rendering";
import { CANVAS_AGENT_PANEL_MOTION_MS } from "@/lib/canvas/canvas-agent-panel-constants";
import { loadCanvasAssistantPanel, loadCanvasLocalAgentPanel } from "@/lib/canvas/canvas-agent-panel-loaders";
import { loadCanvasNodePromptPanel, loadCanvasQuickGeneratePanel } from "@/lib/canvas/canvas-node-panel-loaders";
import { loadCanvasNodeHoverToolbar } from "@/lib/canvas/canvas-node-hover-loaders";
import { CanvasTopBar } from "@/components/canvas/canvas-top-bar";
import { CanvasDialogsHost } from "@/components/canvas/canvas-dialogs-host";
import { useCanvasDialogs } from "./use-canvas-dialogs";
import { createCanvasConnectionSpatialIndex, refreshCanvasConnectionSpatialIndex, selectCanvasSpatialIndexConnections } from "@/lib/canvas/canvas-connection-spatial-index";
import { canvasConnectionSvgSurfaceKind } from "@/lib/canvas/canvas-connection-svg-visibility";
import { selectCanvasNodeIdsInBounds } from "@/lib/canvas/canvas-selection";
import { boundsForViewport, createCanvasSpatialIndex, refreshCanvasSpatialIndex } from "@/lib/canvas/canvas-spatial-index";
import { canvasViewportOverscan } from "@/lib/canvas/canvas-viewport-overscan";
import { moveImageReference, validateImageReferences } from "@/lib/image-reference-policy";
import { loadCanvasExport } from "@/lib/canvas/canvas-export-loader";
import type { CanvasAgentMode } from "@/components/canvas/canvas-agent-chat-ui";
import {
    CanvasNodeType,
    type CanvasAssistantImage,
    type CanvasAgentMediaWorkflow,
    type CanvasAssistantSession,
    type CanvasConnection,
    type CanvasImageGenerationType,
    type CanvasNodeData,
    type CanvasNodeGroup,
    type CanvasNodeMetadata,
    type ConnectionHandle,
    type ContextMenuState,
    type Position,
    type SelectionBox,
    type ViewportTransform,
} from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import "./workspace.css";
import "@fontsource-variable/geist/wght.css";

const CanvasAssistantPanel = lazy(loadCanvasAssistantPanel);
const CanvasNodeContextMenu = lazy(() => import("@/components/canvas/canvas-context-menu").then(module => ({ default: module.CanvasNodeContextMenu })));
const CanvasWorkspaceTools = lazy(() => import("@/components/canvas/canvas-workspace-tools").then(module => ({ default: module.CanvasWorkspaceTools })));
const CanvasBatchEditDialog = lazy(() => import("@/components/canvas/canvas-batch-edit-dialog"));
const CanvasZoomControls = lazy(() => import("@/components/canvas/canvas-zoom-controls").then(module => ({ default: module.CanvasZoomControls })));


const CanvasDesignActions = lazy(() => import("@/components/canvas/canvas-design-actions").then(module => ({ default: module.CanvasDesignActions })));
const CanvasImageSequenceDialog = lazy(() => import("@/components/canvas/canvas-image-sequence-dialog").then(module => ({ default: module.CanvasImageSequenceDialog })));
const CanvasInlineImageCompare = lazy(() => import("@/components/canvas/canvas-inline-image-compare").then(module => ({ default: module.CanvasInlineImageCompare })));
const CanvasGroupLayer = lazy(() => import("@/components/canvas/canvas-group-layer").then(module => ({ default: module.CanvasGroupLayer })));

const CanvasPerformancePanel = lazy(() => import("@/components/canvas/canvas-performance-panel").then(module => ({ default: module.CanvasPerformancePanel })));
const Minimap = lazy(() => import("@/components/canvas/canvas-mini-map").then(module => ({ default: module.Minimap })));
const CanvasLocalAgentPanel = lazy(loadCanvasLocalAgentPanel);









const CanvasConfigNodeContent = lazy(() => import("./canvas-config-node-content").then(module => ({ default: module.CanvasConfigNodeContent })));
const CanvasNodePromptPanel = lazy(loadCanvasNodePromptPanel);
const CanvasQuickGeneratePanel = lazy(loadCanvasQuickGeneratePanel);
const loadCanvasPanelControls = () => import("@/components/canvas/canvas-panel-size-control");
const CanvasPanelResizeHandle = lazy(() => loadCanvasPanelControls().then(module => ({ default: module.CanvasPanelResizeHandle })));
const CanvasPanelSizeControl = lazy(() => loadCanvasPanelControls().then(module => ({ default: module.CanvasPanelSizeControl })));
const CanvasNodeHoverToolbar = lazy(loadCanvasNodeHoverToolbar);


type PendingConnectionCreate = {
    connection: ConnectionHandle;
    position: Position;
};







type CanvasGenerationOutput = {
    nodeId: string;
    status: "success" | "failed";
    url?: string;
    storageKey?: string;
    error?: string;
};

type CanvasGenerationResult = {
    mode: CanvasNodeGenerationMode;
    outputs: CanvasGenerationOutput[];
};


const loadBatchEditRuntime = () => import("./canvas-batch-edit-runtime");

const VIDEO_NODE_MAX_WIDTH = 420;
const VIDEO_NODE_MAX_HEIGHT = 420;
const ConnectionCreateMenu = lazy(() => import("@/components/canvas/canvas-connection-create-menu").then(module => ({ default: module.ConnectionCreateMenu })));
const NODE_STATUS_IDLE = "idle" as const;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;
const INTERRUPTED_IMAGE_TASK_ERROR = "本地查询已中断，可恢复原图片任务，不会重新生成。";
const IMAGE_PROMPT_REVERSE_PRESET = `请根据参考图片反推一段适合用于 AI 生图的提示词。

要求：
1. 只输出提示词正文，不要解释。
2. 覆盖主体、构图、风格、光线、色彩、材质、镜头和氛围。
3. 尽量写成可直接用于生图模型的完整提示词。`;

function createCanvasNode(type: CanvasNodeType, position: Position, metadata?: CanvasNodeMetadata): CanvasNodeData {
    const spec = getNodeSpec(type);
    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    return {
        id,
        type,
        title: spec.title,
        position: {
            x: position.x - spec.width / 2,
            y: position.y - spec.height / 2,
        },
        width: spec.width,
        height: spec.height,
        metadata: { ...spec.metadata, ...metadata },
    };
}

export default function CanvasPage() {
    const [mounted, setMounted] = useState(false);
    const { id: graphScopeId } = useParams<{ id: string }>();
    const canvasThemeKey = useThemeStore((state) => state.theme);
    const canvasAntTheme = useMemo(() => getCanvasAntThemeConfig(canvasThemeKey), [canvasThemeKey]);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return <CanvasRefreshShell />;

    return <ConfigProvider theme={canvasAntTheme}><App className="h-full"><CanvasGraphProvider key={graphScopeId}><WirelessCanvasPage /></CanvasGraphProvider></App></ConfigProvider>;
}

function CanvasRefreshShell() {
    const themeKey = useThemeStore(state => state.theme);
    const theme = canvasThemes[themeKey];
    return (
        <main className="cw-workspace relative h-full min-h-0 overflow-hidden" data-theme={themeKey} style={{ background: theme.canvas.background, color: theme.node.text }} aria-label="正在加载画布">
            <div
                className="absolute inset-0"
                style={{
                    backgroundImage: `radial-gradient(circle, ${theme.canvas.dot} .9px, transparent 1.1px)`,
                    backgroundSize: "16px 16px",
                }}
            />
            <div className="cw-topbar" aria-hidden="true"><div className="cw-project-card cw-surface"><span className="cw-icon cw-brand"><span>V</span></span><span className="cw-project-title">正在加载…</span></div><div className="cw-account-card cw-surface" /></div>
            <aside className="cw-create-panel cw-surface" aria-hidden="true"><div className="cw-tabs">创建 <span className="opacity-50">对话</span></div><div className="h-[370px]" /></aside>
            <div className="cw-dock" aria-hidden="true"><div className="cw-tools cw-surface">
                {Array.from({ length: 7 }).map((_, index) => (
                    <div key={index} className="size-8 rounded-md bg-current opacity-10" />
                ))}
            </div></div>
        </main>
    );
}


function WirelessCanvasPage() {
    const { message, modal } = App.useApp();
    const params = useParams<{ id: string }>();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const projectId = params.id || "";
    const performanceModeEnabled = isCanvasPerformanceModeEnabled(
        import.meta.env.DEV,
        import.meta.env.VITE_ENABLE_CANVAS_PERFORMANCE_SCENARIO === "true",
        searchParams.get("perf"),
    );
    const performanceFixtureSize = canvasPerformanceFixtureSize(performanceModeEnabled, searchParams.get("fixture"));
    const usePerformanceScenario = performanceFixtureSize !== null;
    const performanceScenarioIncludesImages = usePerformanceScenario && searchParams.get("media") === "1";
    const localAgentConnected = useCanvasAgentStore((state) => state.connected);
    const localAgentActivity = useCanvasAgentStore((state) => state.activity);
    const localAgentEnabled = useCanvasAgentStore((state) => state.enabled);
    const localAgentModuleEnabled = useModuleEnabled("canvas-local-agent");
    const localToolsEnabled = useModuleEnabled("canvas-local-tools");
    const containerRef = useRef<HTMLDivElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const quickReferenceInputRef = useRef<HTMLInputElement>(null);
    const batchFilesInputRef = useRef<HTMLInputElement>(null);
    const uploadTargetRef = useRef<{ nodeId?: string; position?: Position } | null>(null);
    const history = useCanvasHistoryState();
    const { historyRef, lastHistoryRef, historyCommitTimerRef, applyingHistoryRef, pendingHistoryEntryRef, historyPausedRef, historyState, setHistoryState } = history;


    const transientTimeoutsRef = useRef(createCanvasTimeoutRegistry());







    const rafRef = useRef<number | null>(null);
    const pendingDragPreviewRef = useRef<{ x: number; y: number } | null>(null);
    const selectionFrameRef = useRef<number | null>(null);
    const selectionPreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const selectionPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
    const pendingSelectionIdsRef = useRef<Set<string> | null>(null);
    const selectionOverlayRef = useRef<CanvasSelectionOverlayHandle>(null);
    const connectionPreviewFrameRef = useRef<number | null>(null);
    const connectionPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
    const connectionInitialPreviewRef = useRef<{ handle: ConnectionHandle; mouseWorld: Position } | null>(null);
    const activeConnectionPathRef = useRef<ActiveConnectionPathHandle>(null);
    const toolbarHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const canvasHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const canvasHoverStateRef = useRef<CanvasHoverState>({ activeId: null, pendingId: null });
    const renderQualityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const performanceTrackerRef = useRef(createCanvasPerformanceTracker());
    const performanceFrameRef = useRef<number | null>(null);
    const performanceLastFrameAtRef = useRef(0);
    const performanceActiveRef = useRef(false);
    const performanceCountsRef = useRef<CanvasVisibilityCounts>({ totalNodes: 0, visibleNodes: 0, totalConnections: 0, visibleConnections: 0 });
    const canvasConnectionLayerRef = useRef<CanvasConnectionLayerHandle>(null);
    const canvasOverviewLayerRef = useRef<CanvasOverviewLayerHandle>(null);
    const canvasGroupLayerRef = useRef<CanvasGroupLayerHandle>(null);
    const draggingGroupRef = useRef(false);
    const wirelessCanvasRef = useRef<WirelessCanvasHandle>(null);
    const canvasSpatialIndexRef = useRef<ReturnType<typeof createCanvasSpatialIndex> | null>(null);
    const connectionSpatialIndexRef = useRef<ReturnType<typeof createCanvasConnectionSpatialIndex> | null>(null);
    const nodeByIdRef = useRef<ReturnType<typeof createCanvasNodeMap> | null>(null);
    const nodeDraggingRef = useRef(false);
    const dragRef = useRef<{
        isDraggingNode: boolean;
        hasMoved: boolean;
        startX: number;
        startY: number;
        initialSelectedNodes: { id: string; x: number; y: number }[];
    }>({
        isDraggingNode: false,
        hasMoved: false,
        startX: 0,
        startY: 0,
        initialSelectedNodes: [],
    });
    const dragPreviewRef = useRef<CanvasDragPreview>(new Map());
    const dragNodeElementCacheRef = useRef<ReturnType<typeof createCanvasDragNodeElementCache> | null>(null);
    const draggedConnectionIdsRef = useRef<ReadonlySet<string>>(new Set());
    const resizePreviewRef = useRef<CanvasResizePreview>(new Map());
    const resizeConnectionIdsRef = useRef<ReadonlySet<string>>(new Set());
    const nodeResizingRef = useRef(false);
    const resizePreviewRafRef = useRef<number | null>(null);
    const pendingResizePreviewRef = useRef<CanvasResizePreview | null>(null);
    const textStreamPublishingEnabledRef = useRef(true);

    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = (..._args: unknown[]) => true;
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const canManageConfig = useCanManageConfig();
    const user = useUserStore((state) => state.user);
    const estimateUsage = useBusinessConfigStore((state) => state.estimate);
    const addAsset = useAssetStore((state) => state.addAsset);
    const addAssets = useAssetStore((state) => state.addAssets);
    const cleanupAssetImages = useAssetStore((state) => state.cleanupImages);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const createProject = useCanvasStore((state) => state.createProject);
    const openProject = useCanvasStore((state) => state.openProject);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const currentProject = useCanvasStore((state) => state.projects.find((project) => project.id === projectId));
    const projectSaveQueueRef = useCanvasPersistenceQueue(updateProject);
    const canvasThemeKey = useThemeStore((state) => state.theme);
    const theme = canvasThemes[canvasThemeKey];
    const [nodes, setNodes] = useCanvasGraphField("nodes");
    const canvasDialogs = useCanvasDialogs();
    const { setCompareImageIds, templateSourceId, setTemplateSourceId, setClearConfirmOpen, setAssetPickerOpen, setInfoNodeId, setCropNodeId, manualEditNode, setManualEditNode, setImageExport, setImageDownload, renameNode, setRenameNode, renameGroup, setRenameGroup, maskEditNodeId, setMaskEditNodeId, setMaskEditModel, setSplitNodeId, setUpscaleNodeId, setSuperResolveNodeId, setAngleNodeId, previewNodeId, setPreviewNodeId } = canvasDialogs;

    const designProjectIdRef = useRef(projectId);
    designProjectIdRef.current = projectId;
    const restoringGenerationRef = useRef(false);
    const [connections, setConnections] = useCanvasGraphField("connections");
    const [groups, setGroups] = useState<CanvasNodeGroup[]>([]);
    const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);
    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [size, setSize] = useState({ width: 1200, height: 720 });
    const [selectedNodeIds, setSelectedNodeIds] = useCanvasGraphField("selectedNodeIds");
    const [selectedConnectionId, setSelectedConnectionId] = useCanvasGraphField("selectedConnectionId");
    const [canvasConnectionFallback, setCanvasConnectionFallback] = useState(false);
    const [canvasOverviewFallback, setCanvasOverviewFallback] = useState(false);
    const setHoveredNodeId = useCanvasGraphSetter("hoveredNodeId");
    const [connectingParams, setConnectingParams] = useState<ConnectionHandle | null>(null);
    const [connectionTargetNodeId, setConnectionTargetNodeId] = useState<string | null>(null);
    const [pendingConnectionCreate, setPendingConnectionCreate] = useState<PendingConnectionCreate | null>(null);
    const [isSelecting, setIsSelecting] = useState(false);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [workspaceToolsOpen, setWorkspaceToolsOpen] = useState(false);
    const openWorkspaceTools = useCallback(() => setWorkspaceToolsOpen(true), []);

    const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
    const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>("dots");
    const [interactionMode, setInteractionMode] = useState<"select" | "hand">("select");
    const [agentLayout, setAgentLayout] = useState<"sidebar" | "wide">(() => {
        try { return localStorage.getItem("canvas-agent-layout") === "wide" ? "wide" : "sidebar"; } catch { return "sidebar"; }
    });
    const toggleAgentLayout = useCallback(() => setAgentLayout((current) => {
        const next = current === "sidebar" ? "wide" : "sidebar";
        try { localStorage.setItem("canvas-agent-layout", next); } catch { /* Private storage may be unavailable. */ }
        return next;
    }), []);
    const [showImageInfo, setShowImageInfo] = useState(false);


    const isCanvasDesktopLayout = useCanvasDesktopLayout();
    const createPanelWidth = useCanvasPanelStore((state) => state.createWidth);
    const chatPanelWidth = useCanvasPanelStore((state) => state.chatWidth);
    const createPromptHeight = useCanvasPanelStore((state) => state.promptHeight);
    const [quickGenerateOpen, setQuickGenerateOpen] = useState(false);
    const [quickGeneratePrompt, setQuickGeneratePrompt] = useState("");
    const [quickGeneratePosition, setQuickGeneratePosition] = useState<Position | null>(null);
    const [quickGenerateModel, setQuickGenerateModel] = useState(effectiveConfig.imageModel || effectiveConfig.model);
    const [quickGenerateSize, setQuickGenerateSize] = useState(effectiveConfig.size || defaultConfig.size);
    const [quickGenerateQuality, setQuickGenerateQuality] = useState(effectiveConfig.quality || defaultConfig.quality);
    const [quickGenerateCount, setQuickGenerateCount] = useState(2);
    const [quickGenerateImageOptions, setQuickGenerateImageOptions] = useState(effectiveConfig.imageOptions || "");
    const [quickGenerateReferences, setQuickGenerateReferences] = useState<CanvasSelectionReference[]>([]);
    const [quickGenerateRunning, setQuickGenerateRunning] = useState(false);
    const quickSubmissionRef = useRef<symbol | null>(null);
    const [batchEditOpen, setBatchEditOpen] = useState(false);
    const [batchEditPrompt, setBatchEditPrompt] = useState("");
    const [batchImageSettings, setBatchImageSettings] = useState<Partial<AiConfig>>({});
    const [batchEditItems, setBatchEditItems] = useState<BatchEditFileItem[]>([]);
    const [batchEditRunning, setBatchEditRunning] = useState(false);
    const [batchEditServerId, setBatchEditServerId] = useState<string | null>(null);
    const [batchEditAction, setBatchEditAction] = useState<QueuedBatchAction | null>(null);
    const [projectLoaded, setProjectLoaded] = useState(false);
    const setToolbarNodeId = useCanvasGraphSetter("toolbarNodeId");
    const [nodeImageSettingsOpen, setNodeImageSettingsOpen] = useState(false);
    const [dialogNodeId, setDialogNodeId] = useState<string | null>(null);
    const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
    const [editRequestNonce, setEditRequestNonce] = useState(0);














    const [assistantCollapsed, setAssistantCollapsed] = useState(true);
    const [assistantMounted, setAssistantMounted] = useState(false);
    const [assistantClosing, setAssistantClosing] = useState(false);
    const assistantOpen = assistantMounted && !assistantCollapsed;
    const [agentMode, setAgentMode] = useState<CanvasAgentMode>("online");
    const agentUndoRecordRef = useRef<CanvasAgentUndoRecord | null>(null);
    const [canUndoAgentOps, setCanUndoAgentOps] = useState(false);
    const codexAutoConnect = ["new", "recent", "choose"].includes(searchParams.get("mode") || "");
    const codexCompactAgent = codexAutoConnect && searchParams.has("agentUrl");
    const [titleEditing, setTitleEditing] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");

    const [collapsingBatchIds, setCollapsingBatchIds] = useState<Set<string>>(new Set());
    const [openingBatchIds, setOpeningBatchIds] = useState<Set<string>>(new Set());
    const [isNodeDragging, setIsNodeDragging] = useState(false);
    const [dragPreviewById, setDragPreviewById] = useState<CanvasDragPreview>(() => new Map());
    const [draggedConnectionIds, setDraggedConnectionIds] = useState<ReadonlySet<string>>(() => new Set());
    const [resizePreviewById, setResizePreviewById] = useState<CanvasResizePreview>(() => new Map());
    const [resizeConnectionIds, setResizeConnectionIds] = useState<ReadonlySet<string>>(() => new Set());
    const [isNodeResizing, setIsNodeResizing] = useState(false);
    const [renderQuality, setRenderQuality] = useState<CanvasRenderQuality>("full");
    const [performanceMetrics, setPerformanceMetrics] = useState<CanvasInteractionMetrics | null>(null);
    const setStreamedTextById = useCanvasGraphSetter("streamedTextById");



    const batchGenerationConfig = useToolConfig({ ...effectiveConfig, ...batchImageSettings, model: batchImageSettings.model || effectiveConfig.imageModel || effectiveConfig.model, count: "1" }, "canvas-batch");


    const nodesRef = useRef(nodes);
    const connectionsRef = useRef(connections);
    const groupsRef = useRef(groups);
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    const viewportRef = useRef(viewport);
    const generateNodeRef = useRef<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, onResult?: (result: CanvasGenerationResult) => void) => Promise<void>) | null>(null);
    const connectingParamsRef = useRef(connectingParams);
    const connectionTargetNodeIdRef = useRef(connectionTargetNodeId);
    const selectionBoxRef = useRef<SelectionBox | null>(null);
    const agentCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingConnectionCreateRef = useRef(pendingConnectionCreate);


    const {
        createOptions, recoverPending, runningNodeId, setRunningNodeId, generationRequestsRef, generationDispatchLocksRef,
        textStreamBufferRef, clearStreamedText, startGenerationRequest, finishGenerationRequest, stopGenerationByRunningId,
    } = useCanvasGenerationRuntime({ projectId, nodesRef, setNodes, projectSaveQueueRef, textStreamPublishingEnabledRef });
    const projectAsyncLifecycleRef = useRef(createCanvasProjectAsyncLifecycle());
    const loadedReuseTokenRef = useRef(new Set<string>());
    const quickGenerateRef = useRef<() => Promise<void>>(async () => undefined);
    const agentSelectedNodeCacheRef = useRef(createCanvasSelectedNodeCache());
    const minimapGeometryCacheRef = useRef(createCanvasMinimapGeometryCache());
    const visibleNodeCacheRef = useRef(createCanvasVisibleNodeCache());

    useEffect(() => {
        setQuickGenerateModel((current) => current || effectiveConfig.imageModel || effectiveConfig.model);
        setQuickGenerateSize((current) => current || effectiveConfig.size || defaultConfig.size);
    }, [effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size]);

    useEffect(() => { setImageDownload(null); }, [projectId]);

    useEffect(() => {
        if (maskEditNodeId) setMaskEditModel(effectiveConfig.imageModel || effectiveConfig.model);
    }, [effectiveConfig.imageModel, effectiveConfig.model, maskEditNodeId]);

    const handleMissingModelConfig = useCallback(() => {
        if (canManageConfig) {
            openConfigDialog(true);
            return;
        }
        message.warning("当前没有可用模型，请联系管理员统一配置模型和 API");
    }, [canManageConfig, message, openConfigDialog]);

    const quickGenerateEstimate = useMemo(
        () => estimateUsage(canvasImageUsageInput(quickGenerateModel || effectiveConfig.imageModel || effectiveConfig.model, quickGenerateReferences.length)),
        [effectiveConfig.imageModel, effectiveConfig.model, estimateUsage, quickGenerateModel, quickGenerateReferences.length],
    );

    // Persist current chat normally without making streaming/chat selection
    // changes restart the graph's history debounce or change command identity.
    const historyChatRef = useRef({ chatSessions, activeChatId });
    historyChatRef.current = { chatSessions, activeChatId };
    const createHistoryEntry = useCallback(
        (): CanvasHistoryEntry => ({
            nodes: nodesRef.current,
            connections: connectionsRef.current,
            groups: groupsRef.current,
            ...historyChatRef.current,
            backgroundMode,
            showImageInfo,
        }),
        [backgroundMode, showImageInfo],
    );

    const applyHistory = useCallback((entry: CanvasHistoryEntry) => {
        const restoredNodes = entry.nodes.map(node => hasPendingImageTask(node, entry.nodes) && node.metadata?.status === NODE_STATUS_LOADING
            && !generationRequestsRef.current.has(node.id)
            ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails: INTERRUPTED_IMAGE_TASK_ERROR } }
            : node);
        const restoredEntry = { ...entry, nodes: restoredNodes, groups: entry.groups || [] };
        if (historyCommitTimerRef.current) {
            clearTimeout(historyCommitTimerRef.current);
            historyCommitTimerRef.current = null;
        }
        applyingHistoryRef.current = true;
        pendingHistoryEntryRef.current = restoredEntry;
        setNodes(restoredNodes);
        setConnections(entry.connections);
        setGroups(restoredEntry.groups);
        // Historical chat fields are legacy data, never a canvas undo command.
        setBackgroundMode(entry.backgroundMode);
        setShowImageInfo(entry.showImageInfo);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
    }, []);

    const { flushPendingHistory, undoCanvas, redoCanvas } = useCanvasHistory(history, {
        current: { nodes, connections, groups, chatSessions, activeChatId, backgroundMode, showImageInfo },
        projectLoaded, createHistoryEntry, applyHistory,
    });

    const cleanupCanvasFiles = useCallback(
        (extra?: unknown) => {
            cleanupAssetImages({ extra, history: historyRef.current, lastHistory: lastHistoryRef.current });
        },
        [cleanupAssetImages],
    );
    const releaseStaleCanvasObjectUrls = useCallback((restoredNodes: CanvasNodeData[], restoredSessions: CanvasAssistantSession[]) => {
        const assets = useAssetStore.getState().assets;
        const usedData = { assets, nodes: restoredNodes, chatSessions: restoredSessions, history: historyRef.current, lastHistory: lastHistoryRef.current };
        releaseUnusedImageObjectUrls(usedData);
        releaseUnusedMediaObjectUrls(usedData);
    }, []);



    const confirmStopGeneration = useCallback(
        (nodeId: string) => {
            modal.confirm({
                title: "停止生成？",
                content: "当前生成请求会被中断，已经生成完成的内容会保留。",
                okText: "停止",
                cancelText: "继续生成",
                okButtonProps: { danger: true },
                onOk: () => stopGenerationByRunningId(nodeId),
            });
        },
        [modal, stopGenerationByRunningId],
    );

    useEffect(() => {
        if (!hydrated) return;
        const lifecycle = projectAsyncLifecycleRef.current;
        const restoreToken = lifecycle.begin();
        pendingHistoryEntryRef.current = null;
        applyingHistoryRef.current = false;
        agentUndoRecordRef.current = null;
        setCanUndoAgentOps(false);
        setCompareImageIds(null);
        setTemplateSourceId(undefined);
        const invalidateRestore = () => lifecycle.invalidate(restoreToken);
        setProjectLoaded(false);
        setQuickGeneratePosition(null);
        setContextMenu(null);
        setManualEditNode(null);
        setImageExport(null);
        setRenameNode(null);
        setRenameGroup(null);
        textStreamBufferRef.current?.cancel();
        setStreamedTextById((current) => (current.size ? new Map() : current));
        abortPendingCanvasRequests(generationRequestsRef.current);
        setRunningNodeId(null);
        setQuickGenerateRunning(false);
        if (usePerformanceScenario) {
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
        try { project = openProject(projectId) || await loadCanvasProject(projectId); }
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
                if (lifecycle.isCurrent(restoreToken)) releaseStaleCanvasObjectUrls(restoredNodes, restoredSessions);
            });
        };

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
    }, [hydrated, message, navigate, openProject, performanceFixtureSize, performanceScenarioIncludesImages, projectId, releaseStaleCanvasObjectUrls, usePerformanceScenario]);

    useEffect(() => {
        // Only the live restored graph is observed; history hydration stays side-effect free.
        if (projectLoaded && !usePerformanceScenario && nodesRef.current.some(node => node.metadata?.imageTask)) void recoverPending();
    }, [projectLoaded, projectId, recoverPending, usePerformanceScenario]);

    useEffect(() => {
        if (!projectLoaded || !["new", "recent", "choose"].includes(searchParams.get("mode") || "")) return;
        if (searchParams.has("agentUrl")) {
            setAgentMode("local");
            return;
        }
        openAgent("local");
    }, [projectLoaded, searchParams]);



    useEffect(
        () => () => {
            agentUndoRecordRef.current = null;
            if (agentCloseTimerRef.current) clearTimeout(agentCloseTimerRef.current);
            abortPendingCanvasRequests(generationRequestsRef.current);
            textStreamBufferRef.current?.cancel();
            transientTimeoutsRef.current.clearAll();
            if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
            if (connectionPreviewFrameRef.current !== null) cancelAnimationFrame(connectionPreviewFrameRef.current);
        },
        [],
    );

    const savedProjectIdRef = useCanvasPersistence({
        projectId, projectLoaded, usePerformanceScenario, projectSaveQueueRef, history, updateProject,
        current: { nodes, connections, groups, chatSessions, activeChatId, backgroundMode, showImageInfo },
        batchEditRunning, runningNodeId, viewport, viewportRef,
    });

    useEffect(() => {
        if (!dialogNodeId) setNodeImageSettingsOpen(false);
    }, [dialogNodeId]);



    useLayoutEffect(() => {
        nodesRef.current = nodes;
        connectionsRef.current = connections;
        groupsRef.current = groups;
        selectedNodeIdsRef.current = selectedNodeIds;
        viewportRef.current = viewport;
        connectingParamsRef.current = connectingParams;
        connectionTargetNodeIdRef.current = connectionTargetNodeId;
        pendingConnectionCreateRef.current = pendingConnectionCreate;
    }, [nodes, connections, groups, selectedNodeIds, viewport, connectingParams, connectionTargetNodeId, pendingConnectionCreate]);



    useEffect(() => {
        if (!projectLoaded) return;
        const el = containerRef.current;
        if (!el) return;

        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            setSize({ width: rect.width, height: rect.height });
        };

        updateSize();
        const resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(el);
        return () => resizeObserver.disconnect();
    }, [projectLoaded]);

    const screenToCanvas = useCallback((clientX: number, clientY: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const currentViewport = viewportRef.current;
        const localX = clientX - (rect?.left || 0);
        const localY = clientY - (rect?.top || 0);

        return {
            x: (localX - currentViewport.x) / currentViewport.k,
            y: (localY - currentViewport.y) / currentViewport.k,
        };
    }, []);

    const getCanvasScale = useCallback(() => viewportRef.current.k, []);

    const previewViewport = useCallback((next: ViewportTransform) => {
        viewportRef.current = next;
        canvasConnectionLayerRef.current?.draw(next);
        canvasOverviewLayerRef.current?.draw(next);
    }, []);

    const previewMinimapViewport = useCallback((next: ViewportTransform) => {
        wirelessCanvasRef.current?.previewViewport(next);
    }, []);

    const enableCanvasConnectionFallback = useCallback(() => setCanvasConnectionFallback(true), []);
    const enableCanvasOverviewFallback = useCallback(() => setCanvasOverviewFallback(true), []);

    const commitViewport = useCallback((next: ViewportTransform) => {
        viewportRef.current = next;
        setViewport(next);
        setContextMenu(null);
    }, []);

    const handleCanvasInteractionChange = useCallback((isInteracting: boolean) => {
        if (renderQualityTimerRef.current) {
            clearTimeout(renderQualityTimerRef.current);
            renderQualityTimerRef.current = null;
        }

        if (isInteracting) {
            canvasHoverStateRef.current = resetCanvasHover(canvasHoverStateRef.current);
            setHoveredNodeId(null);
            if (toolbarHideTimerRef.current) {
                clearTimeout(toolbarHideTimerRef.current);
                toolbarHideTimerRef.current = null;
            }
            setToolbarNodeId(null);
            setRenderQuality(nextCanvasRenderQuality(true));
            if (performanceModeEnabled && !performanceActiveRef.current) {
                performanceActiveRef.current = true;
                performanceLastFrameAtRef.current = performance.now();
                performanceTrackerRef.current.start("canvas", performanceLastFrameAtRef.current);
                const sample = (now: number) => {
                    performanceTrackerRef.current.frame(now - performanceLastFrameAtRef.current);
                    performanceLastFrameAtRef.current = now;
                    performanceFrameRef.current = requestAnimationFrame(sample);
                };
                performanceFrameRef.current = requestAnimationFrame(sample);
            }
            return;
        }

        renderQualityTimerRef.current = setTimeout(() => {
            renderQualityTimerRef.current = null;
            if (!nodeDraggingRef.current) setRenderQuality(nextCanvasRenderQuality(false));
            if (performanceModeEnabled && performanceActiveRef.current) {
                performanceActiveRef.current = false;
                if (performanceFrameRef.current) cancelAnimationFrame(performanceFrameRef.current);
                performanceFrameRef.current = null;
                setPerformanceMetrics(performanceTrackerRef.current.finish(performance.now(), performanceCountsRef.current));
            }
        }, 150);
    }, [performanceModeEnabled]);

    useEffect(
        () => () => {
            if (renderQualityTimerRef.current) clearTimeout(renderQualityTimerRef.current);
            if (performanceFrameRef.current) cancelAnimationFrame(performanceFrameRef.current);
        },
        [],
    );

    const getCanvasCenter = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        return screenToCanvas((rect?.left || 0) + (rect?.width || size.width) / 2, (rect?.top || 0) + (rect?.height || size.height) / 2);
    }, [screenToCanvas, size.height, size.width]);

    const setConnecting = useCallback((next: ConnectionHandle | null) => {
        connectingParamsRef.current = next;
        setConnectingParams(next);
        if (!next) {
            if (connectionPreviewFrameRef.current) {
                cancelAnimationFrame(connectionPreviewFrameRef.current);
                connectionPreviewFrameRef.current = null;
            }
            connectionPointerRef.current = null;
            connectionInitialPreviewRef.current = null;
            activeConnectionPathRef.current?.clear();
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
        }
    }, []);

    const keepNodeToolbar = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current || nodeImageSettingsOpen) return;
            if (toolbarHideTimerRef.current) {
                clearTimeout(toolbarHideTimerRef.current);
                toolbarHideTimerRef.current = null;
            }
            setToolbarNodeId(nodeId);
        },
        [nodeImageSettingsOpen],
    );

    const hideNodeToolbar = useCallback(() => {
        if (toolbarHideTimerRef.current) clearTimeout(toolbarHideTimerRef.current);
        toolbarHideTimerRef.current = setTimeout(() => {
            setToolbarNodeId(null);
            toolbarHideTimerRef.current = null;
        }, 120);
    }, []);

    const commitSettledCanvasHover = useCallback(() => {
        canvasHoverTimerRef.current = null;
        const next = commitCanvasHover(canvasHoverStateRef.current);
        canvasHoverStateRef.current = next;
        setHoveredNodeId((current) => (current === next.activeId ? current : next.activeId));
        if (next.activeId) keepNodeToolbar(next.activeId);
    }, [keepNodeToolbar]);

    const scheduleSettledCanvasHover = useCallback(
        (nodeId: string) => {
            const next = beginCanvasHover(canvasHoverStateRef.current, nodeId);
            canvasHoverStateRef.current = next;
            if (canvasHoverTimerRef.current) clearTimeout(canvasHoverTimerRef.current);
            if (next.activeId === nodeId) {
                keepNodeToolbar(nodeId);
                return;
            }
            canvasHoverTimerRef.current = setTimeout(commitSettledCanvasHover, 72);
        },
        [commitSettledCanvasHover, keepNodeToolbar],
    );

    const clearSettledCanvasHover = useCallback(
        (nodeId: string) => {
            const previous = canvasHoverStateRef.current;
            const next = endCanvasHover(previous, nodeId);
            canvasHoverStateRef.current = next;
            if (previous.pendingId === nodeId && canvasHoverTimerRef.current) {
                clearTimeout(canvasHoverTimerRef.current);
                canvasHoverTimerRef.current = null;
            }
            if (previous.activeId !== next.activeId) {
                setHoveredNodeId((current) => (current === next.activeId ? current : next.activeId));
            }
            if (!next.activeId) hideNodeToolbar();
        },
        [hideNodeToolbar],
    );

    useEffect(
        () => () => {
            if (toolbarHideTimerRef.current) clearTimeout(toolbarHideTimerRef.current);
            if (canvasHoverTimerRef.current) clearTimeout(canvasHoverTimerRef.current);
        },
        [],
    );

    const connectNodes = useCallback(
        (current: ConnectionHandle, targetNodeId: string) => {
            if (current.nodeId === targetNodeId) return;

            const connection = normalizeConnection(current.nodeId, targetNodeId, nodesRef.current, current.handleType);
            if (!connection) {
                message.warning("当前支持生图配置之间的工作流连接，请把两个配置都设为生图");
                return;
            }
            if ([...generationDispatchLocksRef.current].some(key => key.startsWith("image-sequence:"))) { message.info("请先停止工作流，再修改连线"); return; }
            const workflowError = imageWorkflowConnectionError(connection, connectionsRef.current);
            if (workflowError) { message.warning(workflowError); return; }
            const { fromNodeId, toNodeId } = connection;
            if (connection.kind === "config-target" && connectionsRef.current.some((edge) => edge.kind === "config-target" && edge.toNodeId === toNodeId && edge.fromNodeId !== fromNodeId)) {
                message.warning("一个任务只能使用一套公共配置，请先断开原配置连线");
                return;
            }
            const exists = connectionsRef.current.some((conn) => conn.fromNodeId === fromNodeId && conn.toNodeId === toNodeId);
            if (!exists) {
                setConnections((prev) => [...prev, { id: nanoid(), ...connection }]);
            } else if (connection.kind) {
                setConnections((prev) => prev.map((edge) => edge.fromNodeId === fromNodeId && edge.toNodeId === toNodeId ? { ...edge, kind: connection.kind } : edge));
            }
            setContextMenu(null);
        },
        [message],
    );

    const createConnectedNode = useCallback(
        (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video | CanvasNodeType.Audio, pending: PendingConnectionCreate) => {
            if ([...generationDispatchLocksRef.current].some(key => key.startsWith("image-sequence:"))) { message.info("请先停止工作流，再修改连线"); return; }
            const metadata = type === CanvasNodeType.Config ? { model: effectiveConfig.imageModel || effectiveConfig.model, generationMode: "image" as const, size: effectiveConfig.size, count: 1 } : undefined;
            const newNode = createCanvasNode(type, pending.position, metadata);
            const connection = normalizeConnection(pending.connection.nodeId, newNode.id, [...nodesRef.current, newNode], pending.connection.handleType);
            if (!connection) {
                message.warning("工作流只支持生图配置，请把上一步配置设为生图");
                return;
            }
            setNodes((prev) => [...prev, newNode]);
            setConnections((prev) => [...prev, { id: nanoid(), ...connection }]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio) setDialogNodeId(newNode.id);
            setPendingConnectionCreate(null);
            setConnecting(null);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message, setConnecting],
    );

    const cancelPendingConnectionCreate = useCallback(() => {
        setPendingConnectionCreate(null);
        setConnecting(null);
    }, [setConnecting]);

    const nodeById = useMemo(() => {
        const next = nodeByIdRef.current ? refreshCanvasNodeMap(nodeByIdRef.current, nodes) : createCanvasNodeMap(nodes);
        nodeByIdRef.current = next;
        return next;
    }, [nodes]);
    const batchIndexes = useMemo(() => createCanvasBatchRenderIndex(nodeById.values()), [nodeById]);
    const batchRootsById = batchIndexes.rootsById;
    const groupIndex = useMemo(() => createCanvasGroupIndex(groups, nodeById), [groups, nodeById]);
    const hiddenGroupNodeIds = groupIndex.hiddenNodeIds;
    const canvasSpatialIndex = useMemo(() => {
        const next = canvasSpatialIndexRef.current ? refreshCanvasSpatialIndex(canvasSpatialIndexRef.current, nodes, nodeById) : createCanvasSpatialIndex(nodes, undefined, nodeById);
        canvasSpatialIndexRef.current = next;
        return next;
    }, [nodes]);

    const getConnectionDropTarget = useCallback(
        (clientX: number, clientY: number, current: ConnectionHandle): CanvasConnectionDropTarget => {
            const world = screenToCanvas(clientX, clientY);
            return findCanvasConnectionDropTarget({
                index: canvasSpatialIndex,
                world,
                current,
                scale: viewportRef.current.k,
                canConnect: (node) => Boolean(normalizeConnection(current.nodeId, node.id, nodesRef.current, current.handleType)),
                isHiddenNode: (node) => hiddenGroupNodeIds.has(node.id) || isCanvasBatchChildHidden(node, batchRootsById),
            });
        },
        [batchRootsById, canvasSpatialIndex, hiddenGroupNodeIds, screenToCanvas],
    );

    const visibleCanvasBounds = useMemo(() => {
        const padding = canvasViewportOverscan(viewport, size.width, size.height, isCanvasOverviewScale(viewport.k) ? "overview" : "detail");

        return boundsForViewport(viewport, size.width, size.height, padding);
    }, [size.height, size.width, viewport]);

    const batchVisibleNodes = visibleNodeCacheRef.current.select(canvasSpatialIndex, visibleCanvasBounds, batchRootsById, collapsingBatchIds);
    const visibleNodes = useMemo(() => hiddenGroupNodeIds.size ? batchVisibleNodes.filter(node => !hiddenGroupNodeIds.has(node.id)) : batchVisibleNodes, [batchVisibleNodes, hiddenGroupNodeIds]);

    const connectionById = useMemo(() => new Map(connections.map((connection) => [connection.id, connection])), [connections]);
    const connectionSpatialIndex = useMemo(() => {
        const next = connectionSpatialIndexRef.current
            ? refreshCanvasConnectionSpatialIndex(connectionSpatialIndexRef.current, connections, nodeById)
            : createCanvasConnectionSpatialIndex(connections, nodeById);
        connectionSpatialIndexRef.current = next;
        return next;
    }, [connections, nodeById]);
    const connectionAdjacency = useMemo(() => createConnectionAdjacency(connections), [connections]);
    const resolveRenderNode = useMemo(() => createLivePreviewNodeResolver(nodeById, dragPreviewRef, resizePreviewRef), [nodeById]);
    useLayoutEffect(() => {
        const preview = connectionInitialPreviewRef.current;
        if (!connectingParams || !preview) return;
        activeConnectionPathRef.current?.draw(resolveRenderNode(connectingParams.nodeId), preview.handle, preview.mouseWorld);
    }, [connectingParams, resolveRenderNode]);
    const baseVisibleConnections = useMemo(
        () =>
            selectCanvasSpatialIndexConnections(connectionSpatialIndex, visibleCanvasBounds, (connection) => {
                const from = nodeById.get(connection.fromNodeId);
                const to = nodeById.get(connection.toNodeId);
                return Boolean(from && to && !hiddenGroupNodeIds.has(from.id) && !hiddenGroupNodeIds.has(to.id) && !isCanvasBatchConnectionEndpointHidden(from, batchRootsById) && !isCanvasBatchConnectionEndpointHidden(to, batchRootsById));
            }),
        [batchRootsById, connectionSpatialIndex, hiddenGroupNodeIds, nodeById, visibleCanvasBounds],
    );
    const baseVisibleConnectionIds = useMemo(() => new Set(baseVisibleConnections.map((connection) => connection.id)), [baseVisibleConnections]);
    const affectedConnectionIds = useMemo(() => {
        const ids = new Set(draggedConnectionIds);
        resizeConnectionIds.forEach((id) => ids.add(id));
        return ids;
    }, [draggedConnectionIds, resizeConnectionIds]);
    const visibleConnections = useMemo(() => {
        if (!affectedConnectionIds.size) return baseVisibleConnections;
        return refreshVisibleConnectionsForDrag({
            baseVisibleConnections,
            baseVisibleConnectionIds,
            affectedConnectionIds,
            connectionById,
            resolveNode: resolveRenderNode,
            bounds: visibleCanvasBounds,
            shouldInclude: (_connection, from, to) => !hiddenGroupNodeIds.has(from.id) && !hiddenGroupNodeIds.has(to.id) && !isCanvasBatchConnectionEndpointHidden(from, batchRootsById) && !isCanvasBatchConnectionEndpointHidden(to, batchRootsById),
        });
    }, [affectedConnectionIds, baseVisibleConnectionIds, baseVisibleConnections, batchRootsById, connectionById, hiddenGroupNodeIds, resolveRenderNode, visibleCanvasBounds]);

    const findConnectionAtClientPoint = useCallback(
        (clientX: number, clientY: number) =>
            findCanvasConnectionHit({
                connections: visibleConnections,
                nodeById,
                world: screenToCanvas(clientX, clientY),
                tolerance: 10 / viewportRef.current.k,
            }),
        [nodeById, screenToCanvas, visibleConnections],
    );

    const handleConnectionPointerDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            const connection = findConnectionAtClientPoint(event.clientX, event.clientY);
            if (!connection) return false;

            setSelectedConnectionId(connection.id);
            setSelectedNodeIds(new Set());
            setContextMenu(null);
            return true;
        },
        [findConnectionAtClientPoint],
    );

    const applyConnectionPointer = useCallback(
        (clientX: number, clientY: number) => {
            const current = connectingParamsRef.current;
            if (!current || pendingConnectionCreateRef.current) return;

            const dropTarget = getConnectionDropTarget(clientX, clientY, current);
            if (connectionTargetNodeIdRef.current !== dropTarget.nodeId) {
                connectionTargetNodeIdRef.current = dropTarget.nodeId;
                setConnectionTargetNodeId(dropTarget.nodeId);
            }
            const mouseWorld = screenToCanvas(clientX, clientY);
            activeConnectionPathRef.current?.draw(resolveRenderNode(current.nodeId), current, mouseWorld, dropTarget.nodeId ? resolveRenderNode(dropTarget.nodeId) : undefined);
        },
        [getConnectionDropTarget, resolveRenderNode, screenToCanvas],
    );

    const scheduleConnectionPointer = useCallback(
        (clientX: number, clientY: number) => {
            connectionPointerRef.current = { clientX, clientY };
            if (connectionPreviewFrameRef.current) return;
            connectionPreviewFrameRef.current = requestAnimationFrame(() => {
                connectionPreviewFrameRef.current = null;
                const pointer = connectionPointerRef.current;
                connectionPointerRef.current = null;
                if (pointer) applyConnectionPointer(pointer.clientX, pointer.clientY);
            });
        },
        [applyConnectionPointer],
    );

    const flushConnectionPointer = useCallback(() => {
        if (connectionPreviewFrameRef.current) {
            cancelAnimationFrame(connectionPreviewFrameRef.current);
            connectionPreviewFrameRef.current = null;
        }
        const pointer = connectionPointerRef.current;
        connectionPointerRef.current = null;
        if (pointer) applyConnectionPointer(pointer.clientX, pointer.clientY);
    }, [applyConnectionPointer]);

    useEffect(
        () => () => {
            if (connectionPreviewFrameRef.current) cancelAnimationFrame(connectionPreviewFrameRef.current);
        },
        [],
    );

    const commitSelectedNodeIds = useCallback((nextSelected: Set<string>) => {
        if (sameCanvasIdSet(selectedNodeIdsRef.current, nextSelected)) return;
        selectedNodeIdsRef.current = nextSelected;
        setSelectedNodeIds(nextSelected);
    }, []);

    const scheduleSelectionPreviewCommit = useCallback((nextSelected: Set<string>) => {
        pendingSelectionIdsRef.current = nextSelected;
        if (selectionPreviewTimerRef.current) return;
        selectionPreviewTimerRef.current = setTimeout(() => {
            selectionPreviewTimerRef.current = null;
            const pending = pendingSelectionIdsRef.current;
            pendingSelectionIdsRef.current = null;
            if (pending) commitSelectedNodeIds(pending);
        }, 80);
    }, [commitSelectedNodeIds]);

    const flushSelectionPreviewCommit = useCallback(() => {
        if (selectionPreviewTimerRef.current) {
            clearTimeout(selectionPreviewTimerRef.current);
            selectionPreviewTimerRef.current = null;
        }
        const pending = pendingSelectionIdsRef.current;
        pendingSelectionIdsRef.current = null;
        if (pending) commitSelectedNodeIds(pending);
    }, [commitSelectedNodeIds]);

    const applySelectionPointer = useCallback(
        (clientX: number, clientY: number) => {
            const currentSelection = selectionBoxRef.current;
            if (!currentSelection) return;

            const world = screenToCanvas(clientX, clientY);
            const bounds = {
                minX: Math.min(currentSelection.startWorldX, world.x),
                minY: Math.min(currentSelection.startWorldY, world.y),
                maxX: Math.max(currentSelection.startWorldX, world.x),
                maxY: Math.max(currentSelection.startWorldY, world.y),
            };
            const nextSelected = selectCanvasNodeIdsInBounds(
                canvasSpatialIndex,
                bounds,
                new Set(currentSelection.additive ? currentSelection.initialSelectedNodeIds : []),
                (node) => !hiddenGroupNodeIds.has(node.id) && !isCanvasBatchChildHidden(node, batchRootsById, collapsingBatchIds),
            );
            const nextSelectionBox = { ...currentSelection, currentWorldX: world.x, currentWorldY: world.y };
            selectionBoxRef.current = nextSelectionBox;
            selectionOverlayRef.current?.show(nextSelectionBox);
            scheduleSelectionPreviewCommit(nextSelected);
        },
        [batchRootsById, canvasSpatialIndex, collapsingBatchIds, hiddenGroupNodeIds, scheduleSelectionPreviewCommit, screenToCanvas],
    );
    const flushSelectionPointer = useCallback(() => {
        if (selectionFrameRef.current !== null) {
            cancelAnimationFrame(selectionFrameRef.current);
            selectionFrameRef.current = null;
        }
        const pointer = selectionPointerRef.current;
        selectionPointerRef.current = null;
        if (pointer) applySelectionPointer(pointer.clientX, pointer.clientY);
        flushSelectionPreviewCommit();
    }, [applySelectionPointer, flushSelectionPreviewCommit]);
    const cancelSelectionPreview = useCallback(() => {
        if (selectionFrameRef.current !== null) {
            cancelAnimationFrame(selectionFrameRef.current);
            selectionFrameRef.current = null;
        }
        selectionPointerRef.current = null;
        if (selectionPreviewTimerRef.current) {
            clearTimeout(selectionPreviewTimerRef.current);
            selectionPreviewTimerRef.current = null;
        }
        pendingSelectionIdsRef.current = null;
        selectionBoxRef.current = null;
        selectionOverlayRef.current?.hide();
        setIsSelecting(false);
    }, []);
    const scheduleSelectionPointer = useCallback(
        (clientX: number, clientY: number) => {
            selectionPointerRef.current = { clientX, clientY };
            if (selectionFrameRef.current !== null) return;
            selectionFrameRef.current = requestAnimationFrame(() => {
                selectionFrameRef.current = null;
                const pointer = selectionPointerRef.current;
                selectionPointerRef.current = null;
                if (pointer) applySelectionPointer(pointer.clientX, pointer.clientY);
            });
        },
        [applySelectionPointer],
    );
    useEffect(() => {
        performanceCountsRef.current = { totalNodes: nodes.length, visibleNodes: visibleNodes.length, totalConnections: connections.length, visibleConnections: visibleConnections.length };
    }, [connections.length, nodes.length, visibleConnections.length, visibleNodes.length]);
    const singleSelectedNodeId = selectedNodeIds.size === 1 ? selectedNodeIds.values().next().value! : null;
    const singleSelectedNode = singleSelectedNodeId && !hiddenGroupNodeIds.has(singleSelectedNodeId) ? nodeById.get(singleSelectedNodeId) || null : null;









    const hasMultipleSelectedNodes = selectedNodeIds.size > 1;

    useEffect(() => {
        setQuickGenerateReferences((current) => syncCanvasSelectionReferences(current, selectedNodeIds, nodeById));
    }, [nodes, nodeById, selectedNodeIds]);
    const batchChildCountById = batchIndexes.childCountByRootId;
    const batchMotionForNode = batchIndexes.getMotion;
    const graphHighlight = useMemo(() => ({ selectedNodeId: singleSelectedNode?.id || null, multipleSelected: hasMultipleSelectedNodes, connectionAdjacency, connectionById }),
        [singleSelectedNode?.id, hasMultipleSelectedNodes, connectionAdjacency, connectionById]);
    const nodeRenderQuality = useMemo(() => canvasRenderQualityAtScale(renderQuality, viewport.k), [renderQuality, viewport.k]);
    textStreamPublishingEnabledRef.current = shouldPublishCanvasTextStream(nodeRenderQuality, isNodeDragging);
    const canvasOverviewEnabled = nodeRenderQuality === "overview" && !canvasOverviewFallback;
    const overviewNodes = useMemo(
        () => (canvasOverviewEnabled ? Array.from(nodeById.values()).filter((node) => !isCanvasBatchChildHidden(node, batchRootsById, collapsingBatchIds)) : []),
        [batchRootsById, canvasOverviewEnabled, collapsingBatchIds, nodeById],
    );
    const overviewExcludedNodeIds = useMemo(() => {
        const ids = new Set(selectedNodeIds);
        if (!canvasOverviewEnabled) return ids;
        nodeById.forEach((node) => {
            if (canvasNodeHasImagePreview(node) || hiddenGroupNodeIds.has(node.id) || isCanvasBatchChildHidden(node, batchRootsById, collapsingBatchIds)) ids.add(node.id);
        });
        return ids;
    }, [batchRootsById, canvasOverviewEnabled, collapsingBatchIds, hiddenGroupNodeIds, nodeById, selectedNodeIds]);
    const renderedNodes = useMemo(
        // visibleNodes already excludes hidden groups/batches. Only selected nodes
        // and real image previews need DOM content instead of rectangle summaries.
        () => (canvasOverviewEnabled ? visibleNodes.filter((node) => overviewExcludedNodeIds.has(node.id)) : visibleNodes),
        [canvasOverviewEnabled, overviewExcludedNodeIds, visibleNodes],
    );

    const minimapNodes = minimapGeometryCacheRef.current.select(nodes, nodeById);
    const connectionSvgSurfaceKind = canvasConnectionSvgSurfaceKind(canvasConnectionFallback, Boolean(connectingParams));

    const handleOverviewNodePointerDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            if (!canvasOverviewEnabled) return false;
            const node = findCanvasOverviewNodeHit(overviewNodes, screenToCanvas(event.clientX, event.clientY));
            if (!node) return false;

            const additive = event.shiftKey || event.ctrlKey || event.metaKey;
            const nextSelected = additive ? new Set(selectedNodeIdsRef.current) : new Set<string>();
            if (additive && nextSelected.has(node.id)) nextSelected.delete(node.id);
            else nextSelected.add(node.id);
            commitSelectedNodeIds(nextSelected);
            setSelectedConnectionId(null);
            setContextMenu(null);
            return true;
        },
        [canvasOverviewEnabled, commitSelectedNodeIds, overviewNodes, screenToCanvas],
    );

    const configGenerationInputIndex = useMemo(() => createConfigGenerationInputIndex(nodes, connections, nodeById), [connections, nodeById]);
    const configInputSummaryForNodeId = useCallback(
        (nodeId: string) => (nodeById.get(nodeId)?.type === CanvasNodeType.Config ? getInputSummary(configGenerationInputIndex.get(nodeId)) : undefined),
        [configGenerationInputIndex, nodeById],
    );

    const mentionReferenceIndex = useMemo(() => createCanvasMentionReferenceIndex(nodes, connections, nodeById), [connections, nodeById]);
    const globalResourceReferenceIndex = useMemo(() => createCanvasResourceReferenceIndex(nodes, nodeById), [nodeById]);
    const resourceReferencesForActiveNode = useCallback(
        (activeNodeId: string | null) => {
            const resourceContextNodeId = dialogNodeId || activeNodeId;
            const references = new Map((resourceContextNodeId ? mentionReferenceIndex.get(resourceContextNodeId) : []).map((reference) => [reference.nodeId, reference]));
            const contextNode = resourceContextNodeId ? nodeById.get(resourceContextNodeId) : undefined;
            if (!assistantOpen && !quickGenerateOpen && contextNode?.type === CanvasNodeType.Image) {
                references.forEach((reference, id) => { if (reference.kind === "image") references.delete(id); });
                canvasImageReferenceMentions(resolveCanvasNodeImageReferences(contextNode, nodes, connections)).forEach(reference => {
                    if (nodeById.has(reference.nodeId)) references.set(reference.nodeId, reference);
                });
            }
            if (!assistantOpen && quickGenerateOpen) quickGenerateReferences.forEach((reference, index) => {
                const canvasReference = reference.canvasNodeId ? globalResourceReferenceIndex.get(reference.canvasNodeId) : undefined;
                if (canvasReference) references.set(canvasReference.nodeId, { ...canvasReference, label: `图片${index + 1}`, active: true });
            });
            return references;
        },
        [assistantOpen, connections, dialogNodeId, globalResourceReferenceIndex, mentionReferenceIndex, nodeById, nodes, quickGenerateOpen, quickGenerateReferences],
    );

    const agentSnapshot = useMemo<CanvasAgentSnapshot>(
        () => ({ projectId, title: currentProject?.title || "未命名画布", nodes, connections, selectedNodeIds: Array.from(selectedNodeIds), viewport, viewportSize: size, previewNodeId, hiddenNodeIds: [...hiddenGroupNodeIds] }),
        [connections, currentProject?.title, hiddenGroupNodeIds, nodes, projectId, selectedNodeIds, viewport, size, previewNodeId],
    );
    const agentSnapshotRef = useRef(agentSnapshot);
    agentSnapshotRef.current = agentSnapshot;
    const assistantSelectedNodes = agentSelectedNodeCacheRef.current.select(nodes, selectedNodeIds, nodeById, canvasSpatialIndex.nodeOrderById);
    const syncSelectedGenerationRef = useRef(createCanvasSelectionGenerationSync());
    useEffect(() => {
        const saved = syncSelectedGenerationRef.current(selectedNodeIds, assistantSelectedNodes, projectId);
        if (!saved) return;
        setQuickGeneratePrompt(saved.prompt);
        if (saved.model !== undefined) setQuickGenerateModel(saved.model);
        if (saved.size !== undefined) setQuickGenerateSize(saved.size);
        if (saved.quality !== undefined) setQuickGenerateQuality(saved.quality);
        if (saved.count !== undefined) setQuickGenerateCount(saved.count);
        if (saved.imageOptions !== undefined) setQuickGenerateImageOptions(saved.imageOptions);
    }, [assistantSelectedNodes, projectId, selectedNodeIds]);
    const currentAgentSnapshot = useCallback((): CanvasAgentSnapshot => ({ projectId, title: currentProject?.title || "未命名画布", nodes: nodesRef.current, connections: connectionsRef.current, selectedNodeIds: Array.from(selectedNodeIdsRef.current), viewport: viewportRef.current }), [currentProject?.title, projectId]);
    const commitAgentSnapshot = useCallback((snapshot: CanvasAgentSnapshot) => {
        // Keep pending manual edits separate from either an agent batch or its inverse.
        flushPendingHistory();
        nodesRef.current = snapshot.nodes;
        connectionsRef.current = snapshot.connections;
        selectedNodeIdsRef.current = new Set(snapshot.selectedNodeIds);
        viewportRef.current = snapshot.viewport;
        setNodes(snapshot.nodes);
        setConnections(snapshot.connections);
        setSelectedNodeIds(selectedNodeIdsRef.current);
        setSelectedConnectionId(null);
        setViewport(snapshot.viewport);
        setContextMenu(null);
        flushPendingHistory();
    }, [flushPendingHistory]);
    const applyAgentOps = useCallback(
        (ops?: CanvasAgentOp[]) => {
            const safeOps = Array.isArray(ops) ? ops.filter((op) => op?.type) : [];
            const before = currentAgentSnapshot();
            const generationOps = safeOps.filter((op): op is Extract<CanvasAgentOp, { type: "run_generation" }> => op.type === "run_generation" && Boolean(op.nodeId));
            const edits = safeOps.filter((op) => op.type !== "run_generation");
            const next = applyCanvasAgentOps(before, edits);
            // Capture candidate edits without another whole-graph scan. The lazy
            // diff also recognizes same-value or missing-target edits as no-ops.
            agentUndoRecordRef.current = edits.length ? { before, after: next } : null;
            setCanUndoAgentOps(Boolean(agentUndoRecordRef.current));
            commitAgentSnapshot(next);
            if (generationOps.length) {
                queueMicrotask(() =>
                    generationOps.forEach((op) => {
                        const target = nodesRef.current.find((node) => node.id === op.nodeId);
                        const prompt = op.prompt?.trim() ? op.prompt : (target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                        void generateNodeRef.current?.(op.nodeId, op.mode || target?.metadata?.generationMode || "image", prompt);
                    }),
                );
            }
            return next;
        },
        [commitAgentSnapshot, currentAgentSnapshot],
    );
    const undoAgentOps = useCallback(async () => {
        const record = agentUndoRecordRef.current;
        if (!record) return null;
        const action = await import("@/lib/canvas/canvas-agent-undo-action").catch(() => {
            if (agentUndoRecordRef.current === record) message.error("加载失败，请重试");
            return null;
        });
        // A project switch, newer batch, or another undo invalidates this click.
        // Read the live graph only after loading so edits made meanwhile win.
        if (!action || agentUndoRecordRef.current !== record) return null;
        return action.executeCanvasAgentUndo({
            current: currentAgentSnapshot(), record, groups: groupsRef.current, requests: generationRequestsRef.current.values(),
            commit: commitAgentSnapshot, feedback: { modal, message },
            setRecord: remaining => { agentUndoRecordRef.current = remaining; setCanUndoAgentOps(Boolean(remaining)); },
        });
    }, [commitAgentSnapshot, currentAgentSnapshot, message, modal]);
    const createNode = useCallback(
        (type: CanvasNodeType, position?: Position) => {
            const targetPosition = position || getCanvasCenter();
            const configMetadata =
                type === CanvasNodeType.Config
                    ? {
                          model: effectiveConfig.imageModel || effectiveConfig.model,
                          size: effectiveConfig.size,
                          count: 1,
                      }
                    : undefined;
            const newNode = createCanvasNode(type, targetPosition, configMetadata);

            flushPendingHistory();
            setNodes((prev) => [...prev, newNode]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio) setDialogNodeId(newNode.id);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, flushPendingHistory, getCanvasCenter],
    );

    const deleteNodes = useCallback(
        (ids: Set<string>) => {
            if (!ids.size) return;
            flushPendingHistory();
            const allIds = new Set(ids);
            nodesRef.current.forEach((node) => {
                if (ids.has(node.id)) node.metadata?.batchChildIds?.forEach((childId) => allIds.add(childId));
            });
            const stoppedRuns = new Set<string>();
            generationRequestsRef.current.forEach((request) => {
                if (allIds.has(request.targetNodeId) || allIds.has(request.originNodeId) || allIds.has(request.runningNodeId) ||
                    connectionsRef.current.some((edge) => edge.kind === "config-target" && allIds.has(edge.fromNodeId) && edge.toNodeId === request.originNodeId)) stoppedRuns.add(request.runningNodeId);
            });
            stoppedRuns.forEach(stopGenerationByRunningId);
            setNodes((prev) => {
                const next = prev.filter((node) => !allIds.has(node.id));
                return next.map((node) => {
                    const childIds = node.metadata?.batchChildIds?.filter((childId) => !allIds.has(childId));
                    if (!node.metadata?.isBatchRoot || childIds?.length === node.metadata.batchChildIds?.length) return node;
                    const primaryImageId = childIds?.includes(node.metadata.primaryImageId || "") ? node.metadata.primaryImageId : childIds?.[0];
                    const primaryNode = next.find((item) => item.id === primaryImageId);
                    return {
                        ...node,
                        metadata: {
                            ...node.metadata,
                            batchChildIds: childIds,
                            primaryImageId,
                            content: primaryNode?.metadata?.content || node.metadata.content,
                            ...(primaryNode ? { storageKey: primaryNode.metadata?.storageKey, compareSources: primaryNode.metadata?.compareSources, references: primaryNode.metadata?.references } : {}),
                            naturalWidth: primaryNode?.metadata?.naturalWidth || node.metadata.naturalWidth,
                            naturalHeight: primaryNode?.metadata?.naturalHeight || node.metadata.naturalHeight,
                        },
                    };
                });
            });
            setConnections((prev) => prev.filter((conn) => !allIds.has(conn.fromNodeId) && !allIds.has(conn.toNodeId)));
            setGroups(current => removeCanvasGroupMembers(current, allIds));
            setSelectedNodeIds(new Set());
            setSelectedConnectionId(null);
            setHoveredNodeId((current) => (current && allIds.has(current) ? null : current));
            setToolbarNodeId((current) => (current && allIds.has(current) ? null : current));
            setDialogNodeId((current) => (current && allIds.has(current) ? null : current));
            setEditingNodeId((current) => (current && allIds.has(current) ? null : current));
            setInfoNodeId((current) => (current && allIds.has(current) ? null : current));
            setCropNodeId((current) => (current && allIds.has(current) ? null : current));
            setManualEditNode((current) => current && allIds.has(current.id) ? null : current);
            setMaskEditNodeId((current) => (current && allIds.has(current) ? null : current));
            setAngleNodeId((current) => (current && allIds.has(current) ? null : current));
            setPreviewNodeId((current) => (current && allIds.has(current) ? null : current));
            setRunningNodeId((current) => (current && allIds.has(current) ? null : current));
            setContextMenu((current) => (current?.type === "node" && allIds.has(current.nodeId) ? null : current));
            cleanupCanvasFiles({ projectId, nodes: nodesRef.current.filter((node) => !allIds.has(node.id)), chatSessions });
        },
        [chatSessions, cleanupCanvasFiles, flushPendingHistory, projectId, stopGenerationByRunningId],
    );

    const createSelectedGroup = useCallback(() => {
        if (!localToolsEnabled) return;
        const memberIds = canvasGroupMemberIds(selectedNodeIdsRef.current, nodeById);
        if (memberIds.size < 2) { message.info("请先框选至少两个节点，再创建款式组"); return; }
        let number = groupsRef.current.length + 1;
        while (groupsRef.current.some(group => group.title === `款式 ${number}`)) number++;
        const group = { id: `group-${nanoid()}`, title: `款式 ${number}`, nodeIds: [...memberIds], collapsed: false };
        setGroups(current => assignCanvasNodeGroup(current, group, nodeById));
        commitSelectedNodeIds(memberIds);
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(null);
        setRenameGroup({ id: group.id, name: group.title });
    }, [commitSelectedNodeIds, localToolsEnabled, message, nodeById]);

    const selectGroup = useCallback((id: string) => {
        const group = groupIndex.groups.find(item => item.group.id === id);
        if (!group) return;
        commitSelectedNodeIds(new Set(group.nodeIds));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
    }, [commitSelectedNodeIds, groupIndex]);

    const toggleGroup = useCallback((id: string) => {
        setGroups(current => current.map(group => group.id === id ? { ...group, collapsed: !group.collapsed } : group));
        commitSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setDialogNodeId(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setPreviewNodeId(null);
        setContextMenu(null);
        setConnecting(null);
    }, [commitSelectedNodeIds, setConnecting]);

    const ungroup = useCallback((id: string) => {
        setGroups(current => current.filter(group => group.id !== id));
        setContextMenu(null);
    }, []);

    const startGroupRename = useCallback((id: string) => {
        const group = groupsRef.current.find(item => item.id === id);
        if (group) setRenameGroup({ id, name: group.title });
    }, []);

    const saveGroupName = useCallback((name: string) => {
        if (!name || !renameGroup) return;
        setGroups(current => current.map(group => group.id === renameGroup.id ? { ...group, title: name } : group));
        setRenameGroup(null);
    }, [renameGroup]);

    const deleteConnection = useCallback((connectionId: string) => {
        if ([...generationDispatchLocksRef.current].some(key => key.startsWith("image-sequence:"))) { message.info("请先停止工作流，再修改连线"); return; }
        flushPendingHistory();
        setConnections((prev) => prev.filter((conn) => conn.id !== connectionId));
        setSelectedConnectionId((current) => (current === connectionId ? null : current));
        setContextMenu((current) => (current?.type === "connection" && current.connectionId === connectionId ? null : current));
    }, [flushPendingHistory, message]);

    const deselectCanvas = useCallback(() => {
        cancelPendingConnectionCreate();
        commitSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        cancelSelectionPreview();
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
        setEditingNodeId(null);
    }, [cancelPendingConnectionCreate, cancelSelectionPreview, commitSelectedNodeIds]);

    const clearCanvas = useCallback(() => {
        flushPendingHistory();
        setNodes([]);
        setConnections([]);
        setGroups([]);
        setInfoNodeId(null);
        setCropNodeId(null);
        setManualEditNode(null);
        setMaskEditNodeId(null);
        setAngleNodeId(null);
        setPreviewNodeId(null);
        setQuickGeneratePosition(null);
        setRunningNodeId(null);
        deselectCanvas();
        setClearConfirmOpen(false);
        cleanupCanvasFiles({ projectId, nodes: [], chatSessions: [] });
    }, [cleanupCanvasFiles, deselectCanvas, flushPendingHistory, projectId]);

    const duplicateNodes = useCallback((ids: ReadonlySet<string>) => {
        const source = copyCanvasNodeGraph(nodesRef.current, connectionsRef.current, groupsRef.current, ids);
        if (!source.nodes.length) return;
        const next = cloneCanvasNodeGraph(source, { x: 36, y: 36 });
        // Keep distinct commands separate even when the previous edit is still debounced.
        flushPendingHistory();
        setNodes(prev => [...prev, ...next.nodes]);
        setConnections(prev => [...prev, ...next.connections]);
        if (next.groups?.length) setGroups(current => [...current, ...next.groups!]);
        setSelectedNodeIds(new Set(next.nodes.map(node => node.id)));
        setSelectedConnectionId(null);
        setDialogNodeId(next.nodes.length === 1 ? next.nodes[0]!.id : null);
    }, [flushPendingHistory]);

    const copySelectedNodes = useCallback(() => {
        const selectedIds = selectedNodeIdsRef.current;
        if (!selectedIds.size) return;

        const graph = copyCanvasNodeGraph(nodesRef.current, connectionsRef.current, groupsRef.current, selectedIds);
        if (!graph.nodes.length) return;

        return graph;
    }, []);

    const pasteCopiedNodes = useCallback((clipboard: CanvasNodeGraph) => {
        if (!clipboard?.nodes.length) return false;

        const center = getCanvasCenter();
        const bounds = clipboard.nodes.reduce(
            (acc, node) => ({
                left: Math.min(acc.left, node.position.x),
                top: Math.min(acc.top, node.position.y),
                right: Math.max(acc.right, node.position.x + node.width),
                bottom: Math.max(acc.bottom, node.position.y + node.height),
            }),
            { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
        );
        const dx = center.x - (bounds.left + bounds.right) / 2;
        const dy = center.y - (bounds.top + bounds.bottom) / 2;
        const { nodes: nextNodes, connections: nextConnections, groups: nextGroups } = cloneCanvasNodeGraph(clipboard, { x: dx, y: dy });

        flushPendingHistory();
        setNodes((prev) => [...prev, ...nextNodes]);
        setConnections((prev) => [...prev, ...nextConnections]);
        if (nextGroups?.length) setGroups(current => [...current, ...nextGroups]);
        setSelectedNodeIds(new Set(nextNodes.map((node) => node.id)));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(nextNodes[0]?.id || null);
        return true;
    }, [flushPendingHistory, getCanvasCenter]);

    const resetViewport = useCallback(() => {
        const next = { x: size.width / 2, y: size.height / 2, k: 1 };
        wirelessCanvasRef.current?.previewViewport(next);
        setViewport(next);
        setContextMenu(null);
    }, [size.height, size.width]);

    const toggleMiniMap = useCallback(() => setIsMiniMapOpen((value) => !value), []);

    const focusCanvasArea = useCallback(
        (position: Position, width: number, height: number) => {
            const current = viewportRef.current;
            setViewport({
                x: size.width / 2 - (position.x + width / 2) * current.k,
                y: size.height / 2 - (position.y + height / 2) * current.k,
                k: current.k,
            });
        },
        [size.height, size.width],
    );

    const setZoomScale = useCallback(
        (scale: number) => {
            const nextScale = clampCanvasZoom(scale);
            const next = zoomViewportAtCanvasCenter(viewportRef.current, size, nextScale);
            wirelessCanvasRef.current?.previewViewport(next);
            viewportRef.current = next;
            setViewport(next);
            setContextMenu(null);
        },
        [size.height, size.width],
    );

    const previewZoomScale = useCallback(
        (scale: number) => {
            const next = zoomViewportAtCanvasCenter(viewportRef.current, size, clampCanvasZoom(scale));
            wirelessCanvasRef.current?.previewViewport(next);
            setContextMenu(null);
        },
        [size.height, size.width],
    );





    const createAndOpenProject = useCallback(() => {
        const id = createProject(`无线画布 ${useCanvasStore.getState().projects.length + 1}`);
        navigate(`/canvas/${id}`);
    }, [createProject, navigate]);

    const deleteCurrentProject = useCallback(() => {
        modal.confirm({
            title: "删除整个画布？",
            content: "这会删除当前画布中的所有图片、节点和连线，并返回画布列表。删除单张图片请使用图片工具条中的“删除”。",
            okText: "删除整个画布",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: () => {
                deleteProjects([projectId]);
                cleanupAssetImages();
                navigate("/canvas");
            },
        });
    }, [cleanupAssetImages, deleteProjects, modal, navigate, projectId]);

    const handleCanvasMouseDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            setContextMenu(null);
            if (pendingConnectionCreateRef.current) cancelPendingConnectionCreate();
            if (event.button !== 0) return;

            if (interactionMode !== "select" && !event.ctrlKey && !event.metaKey) {
                cancelSelectionPreview();
                commitSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                return;
            }

            const world = screenToCanvas(event.clientX, event.clientY);
            const nextSelectionBox = {
                startWorldX: world.x,
                startWorldY: world.y,
                currentWorldX: world.x,
                currentWorldY: world.y,
                additive: event.shiftKey,
                initialSelectedNodeIds: event.shiftKey ? Array.from(selectedNodeIdsRef.current) : [],
            };
            selectionBoxRef.current = nextSelectionBox;
            selectionOverlayRef.current?.show(nextSelectionBox);
            setIsSelecting(true);
            if (!event.shiftKey) {
                commitSelectedNodeIds(new Set());
            }

            setSelectedConnectionId(null);
        },
        [cancelPendingConnectionCreate, cancelSelectionPreview, commitSelectedNodeIds, screenToCanvas, interactionMode],
    );

    const applyLiveDragPreview = useCallback((preview: CanvasDragPreview) => {
        dragPreviewRef.current = preview;
        dragNodeElementCacheRef.current?.apply(preview);
        canvasConnectionLayerRef.current?.refresh(viewportRef.current, draggedConnectionIdsRef.current);
        canvasGroupLayerRef.current?.refresh();
    }, []);

    const handleNodeMouseDown = useCallback((event: ReactMouseEvent, nodeId: string, groupSelection?: ReadonlySet<string>) => {
        event.stopPropagation();
        if (event.button !== 0) return;
        setContextMenu(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setSelectedConnectionId(null);

        const currentSelected = selectedNodeIdsRef.current;
        const nextSelected = new Set(groupSelection || currentSelected);
        draggingGroupRef.current = Boolean(groupSelection);

        if (!groupSelection && (event.shiftKey || event.metaKey || event.ctrlKey)) {
            if (nextSelected.has(nodeId)) {
                nextSelected.delete(nodeId);
            } else {
                nextSelected.add(nodeId);
            }
        } else if (!groupSelection && !nextSelected.has(nodeId)) {
            nextSelected.clear();
            nextSelected.add(nodeId);
        }

        commitSelectedNodeIds(nextSelected);
        const dragNodes = collectCanvasDragNodes(nextSelected, nodeById);
        const dragIds = dragNodes.ids;
        const dragNodeElementCache = createCanvasDragNodeElementCache(
            (draggedNodeId) => containerRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(draggedNodeId)}"]`) || null,
            () => new Map(Array.from(containerRef.current?.querySelectorAll<HTMLElement>("[data-node-id]") || [], element => [element.dataset.nodeId!, element] as const)),
        );
        dragNodeElementCache.warm(dragIds);
        dragNodeElementCacheRef.current = dragNodeElementCache;
        const nextDraggedConnectionIds = collectAffectedConnectionIds(dragIds, connectionAdjacency);
        draggedConnectionIdsRef.current = nextDraggedConnectionIds;
        setDraggedConnectionIds(nextDraggedConnectionIds);
        dragRef.current = {
            isDraggingNode: true,
            hasMoved: false,
            startX: event.clientX,
            startY: event.clientY,
            initialSelectedNodes: dragNodes.nodes,
        };
        flushPendingHistory();
        historyPausedRef.current = true;
        nodeDraggingRef.current = true;
        setIsNodeDragging(true);
        handleCanvasInteractionChange(true);
    }, [commitSelectedNodeIds, connectionAdjacency, flushPendingHistory, handleCanvasInteractionChange, nodeById]);

    const moveGroup = useCallback((event: ReactMouseEvent, id: string) => {
        const group = groupIndex.groups.find(item => item.group.id === id);
        const firstId = group?.nodes[0]?.id;
        if (group && firstId) handleNodeMouseDown(event, firstId, group.nodeIds);
    }, [groupIndex, handleNodeMouseDown]);

    const finishNodeDrag = useCallback((clientX?: number, clientY?: number) => {
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        pendingDragPreviewRef.current = null;
        if (!dragRef.current.isDraggingNode) return;

        const wasClick = !draggingGroupRef.current && !dragRef.current.hasMoved && dragRef.current.initialSelectedNodes.length === 1;
        const clickedNodeId = dragRef.current.initialSelectedNodes[0]?.id;
        const currentViewport = viewportRef.current;
        const dx = clientX == null ? 0 : (clientX - dragRef.current.startX) / currentViewport.k;
        const dy = clientY == null ? 0 : (clientY - dragRef.current.startY) / currentViewport.k;
        const initialPositions = dragRef.current.initialSelectedNodes;

        historyPausedRef.current = false;
        nodeDraggingRef.current = false;
        setIsNodeDragging(false);
        handleCanvasInteractionChange(false);
        if (dragRef.current.hasMoved && clientX != null && clientY != null) {
            const preview = createDragPreview(initialPositions, dx, dy);
            setNodes((prev) =>
                prev.map((node) => {
                    const position = preview.get(node.id);
                    return position ? { ...node, position } : node;
                }),
            );
        } else if (dragRef.current.hasMoved) {
            // A cancelled pointer sequence has no final coordinates. Restore
            // the imperatively moved node elements to their persisted state.
            applyLiveDragPreview(createDragPreview(initialPositions, 0, 0));
        }

        dragPreviewRef.current = new Map();
        setDragPreviewById(dragPreviewRef.current);
        dragNodeElementCacheRef.current?.clear();
        dragNodeElementCacheRef.current = null;
        draggedConnectionIdsRef.current = new Set();
        setDraggedConnectionIds(draggedConnectionIdsRef.current);

        dragRef.current.isDraggingNode = false;
        dragRef.current.hasMoved = false;
        dragRef.current.initialSelectedNodes = [];
        draggingGroupRef.current = false;
        if (wasClick && clickedNodeId) {
            const clickedNode = nodesRef.current.find((node) => node.id === clickedNodeId);
            if (clickedNode?.type === CanvasNodeType.Image && (clickedNode.metadata?.content || clickedNode.metadata?.storageKey)) {
                setDialogNodeId(null);
            } else if (clickedNode?.type === CanvasNodeType.Text) {
                setDialogNodeId((current) => (current === clickedNodeId ? current : null));
            } else {
                setDialogNodeId(clickedNodeId);
            }
        }
    }, [applyLiveDragPreview, handleCanvasInteractionChange]);

    const handleGlobalMouseMove = useCallback(
        (event: MouseEvent) => {
            const currentViewport = viewportRef.current;

            if (dragRef.current.isDraggingNode) {
                const dx = (event.clientX - dragRef.current.startX) / currentViewport.k;
                const dy = (event.clientY - dragRef.current.startY) / currentViewport.k;
                const initialPositions = dragRef.current.initialSelectedNodes;
                if (Math.abs(event.clientX - dragRef.current.startX) > 3 || Math.abs(event.clientY - dragRef.current.startY) > 3) {
                    dragRef.current.hasMoved = true;
                }

                pendingDragPreviewRef.current = { x: dx, y: dy };
                if (rafRef.current) return;
                rafRef.current = requestAnimationFrame(() => {
                    rafRef.current = null;
                    const pending = pendingDragPreviewRef.current;
                    pendingDragPreviewRef.current = null;
                    if (!pending || !dragRef.current.isDraggingNode) return;
                    const preview = createDragPreview(initialPositions, pending.x, pending.y);
                    applyLiveDragPreview(preview);
                    if (canvasConnectionFallback) setDragPreviewById(preview);
                });
                return;
            }

            if (connectingParamsRef.current && !pendingConnectionCreateRef.current) {
                scheduleConnectionPointer(event.clientX, event.clientY);
            }
        },
        [applyLiveDragPreview, canvasConnectionFallback, finishNodeDrag, scheduleConnectionPointer],
    );

    const handleGlobalPointerMove = useCallback(
        (event: PointerEvent) => {
            const currentSelection = selectionBoxRef.current;
            if (!currentSelection) return;

            if (event.buttons === 0) {
                flushSelectionPointer();
                selectionBoxRef.current = null;
                selectionOverlayRef.current?.hide();
                setIsSelecting(false);
                return;
            }

            scheduleSelectionPointer(event.clientX, event.clientY);
        },
        [flushSelectionPointer, scheduleSelectionPointer],
    );

    const handleGlobalMouseUp = useCallback(
        (event: MouseEvent) => {
            finishNodeDrag(event.clientX, event.clientY);
            flushConnectionPointer();

            flushSelectionPointer();
            selectionBoxRef.current = null;
            selectionOverlayRef.current?.hide();
            setIsSelecting(false);

            if (pendingConnectionCreateRef.current) return;

            const currentConnection = connectingParamsRef.current;
            if (currentConnection) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, currentConnection);
                if (dropTarget.nodeId) {
                    connectNodes(currentConnection, dropTarget.nodeId);
                    setConnecting(null);
                } else if (dropTarget.isNearNode) {
                    setConnecting(null);
                } else {
                    const position = screenToCanvas(event.clientX, event.clientY);
                    activeConnectionPathRef.current?.clear();
                    setPendingConnectionCreate({ connection: currentConnection, position });
                }
            }
        },
        [connectNodes, finishNodeDrag, flushConnectionPointer, flushSelectionPointer, getConnectionDropTarget, screenToCanvas, setConnecting],
    );

    useEffect(() => {
        const handlePointerUp = (event: PointerEvent) => {
            finishNodeDrag(event.clientX, event.clientY);
            flushSelectionPointer();
            selectionBoxRef.current = null;
            selectionOverlayRef.current?.hide();
            setIsSelecting(false);
        };
        const cancelNodeDrag = () => {
            finishNodeDrag();
            flushSelectionPointer();
            selectionBoxRef.current = null;
            selectionOverlayRef.current?.hide();
            setIsSelecting(false);
        };
        window.addEventListener("mousemove", handleGlobalMouseMove);
        window.addEventListener("mouseup", handleGlobalMouseUp);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", cancelNodeDrag);
        window.addEventListener("blur", cancelNodeDrag);
        window.addEventListener("pointermove", handleGlobalPointerMove);
        return () => {
            window.removeEventListener("mousemove", handleGlobalMouseMove);
            window.removeEventListener("mouseup", handleGlobalMouseUp);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", cancelNodeDrag);
            window.removeEventListener("blur", cancelNodeDrag);
            window.removeEventListener("pointermove", handleGlobalPointerMove);
            if (selectionFrameRef.current !== null) cancelAnimationFrame(selectionFrameRef.current);
            if (selectionPreviewTimerRef.current) clearTimeout(selectionPreviewTimerRef.current);
        };
    }, [finishNodeDrag, flushSelectionPointer, handleGlobalMouseMove, handleGlobalMouseUp, handleGlobalPointerMove]);

    const imageOperationRunner = useMemo(() => createCanvasImageOperationRunner(), [projectId]);
    useEffect(() => () => imageOperationRunner.cancelAll(), [imageOperationRunner]);
    const runLocalImageOperation = useCallback((key: string, label: string, task: (signal: AbortSignal) => Promise<void>) => {
        const messageKey = `canvas-image:${projectId}:${key}`;
        return imageOperationRunner.run(key, task, {
            start: () => { void message.loading({ key: messageKey, content: `${label}中…`, duration: 0 }); },
            error: (error) => { void message.error(`${label}失败：${error instanceof Error ? error.message : "请重试"}`); },
            finish: () => message.destroy(messageKey),
        });
    }, [imageOperationRunner, message, projectId]);

    const createImageFileNode = useCallback(async (file: File, position: Position, signal?: AbortSignal, preserveQuickGeneratePrompt = false) => {
        signal?.throwIfAborted();
        assertCanvasImageUploadSize(file);
        const image = await uploadImage(file);
        signal?.throwIfAborted();
        const size = fitNodeSize(image.width, image.height);
        const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const newNode: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: file.name,
            position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: imageMetadata(image),
        };

        // Clipboard import selects its new reference, but must not replace the live creation draft.
        // Consume this selection without inventing a source prompt on the uploaded image.
        if (preserveQuickGeneratePrompt) syncSelectedGenerationRef.current(new Set([id]), [newNode], projectId);
        flushPendingHistory();
        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, [flushPendingHistory, projectId]);

    const createVideoFileNode = useCallback(async (file: File, position: Position) => {
        const video = await uploadMediaFile(file, "video");
        const size = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
        const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        flushPendingHistory();
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Video,
                title: file.name,
                position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
                width: size.width,
                height: size.height,
                metadata: videoMetadata(video),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, [flushPendingHistory]);

    const createAudioFileNode = useCallback(async (file: File, position: Position) => {
        const audio = await uploadMediaFile(file, "audio");
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
        const id = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        flushPendingHistory();
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Audio,
                title: file.name,
                position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
                width: spec.width,
                height: spec.height,
                metadata: audioMetadata(audio),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
    }, [flushPendingHistory]);

    const createTextNodeFromClipboard = useCallback(
        (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return false;

            const node = {
                ...createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), { content: trimmed, status: NODE_STATUS_SUCCESS }),
                title: trimmed.slice(0, 32) || "剪切板文本",
            };

            flushPendingHistory();
            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            setDialogNodeId(node.id);
            return true;
        },
        [flushPendingHistory, getCanvasCenter],
    );

    const pasteSystemClipboard = useCallback(async (files: File[]) => {
        const center = getCanvasCenter();
        await runLocalImageOperation(`clipboard-paste:${nanoid()}`, "粘贴", async (signal) => {
            files.forEach(assertCanvasImageUploadSize);
            for (const [index, file] of files.entries()) {
                await createImageFileNode(file, { x: center.x + index * 36, y: center.y + index * 36 }, signal, true);
            }
            message.success(files.length === 1 ? "已从剪切板添加图片" : `已从剪切板添加 ${files.length} 张图片`);
        });
    }, [createImageFileNode, getCanvasCenter, message, runLocalImageOperation]);

    const handleDrop = useCanvasClipboardDrop({
        copyNodes: copySelectedNodes,
        getCutSnapshot: () => ({
            nodes: nodesRef.current, connections: connectionsRef.current, selectedIds: selectedNodeIdsRef.current,
            requests: [...generationRequestsRef.current.values()], dispatchLocks: [...generationDispatchLocksRef.current],
        }),
        cutNodes: () => deleteNodes(new Set(selectedNodeIdsRef.current)),
        pasteNodes: pasteCopiedNodes, pasteImages: pasteSystemClipboard, pasteText: createTextNodeFromClipboard,
        screenToCanvas, createImage: createImageFileNode, createVideo: createVideoFileNode, createAudio: createAudioFileNode,
        warning: text => message.warning(text), error: text => message.error(text),
    });

    useCanvasShortcuts({
        duplicate: () => duplicateNodes(new Set(selectedNodeIdsRef.current)),
        group: createSelectedGroup, undo: undoCanvas, redo: redoCanvas,
        selectAll: () => {
            commitSelectedNodeIds(new Set(nodesRef.current.map(node => node.id)));
            setSelectedConnectionId(null); setContextMenu(null); cancelSelectionPreview();
        },
        deleteSelection: () => {
            if (selectedNodeIdsRef.current.size) deleteNodes(new Set(selectedNodeIdsRef.current));
            else if (selectedConnectionId) deleteConnection(selectedConnectionId);
        },
        escape: () => {
            commitSelectedNodeIds(new Set()); setSelectedConnectionId(null); setContextMenu(null);
            cancelSelectionPreview(); setConnecting(null); setHoveredNodeId(null); setToolbarNodeId(null);
            setDialogNodeId(null); setEditingNodeId(null); setInfoNodeId(null); setCropNodeId(null);
            setMaskEditNodeId(null); setPendingConnectionCreate(null);
        },
    });

    const handleConnectStart = useCallback(
        (event: ReactMouseEvent, nodeId: string, handleType: "source" | "target") => {
            event.stopPropagation();
            if (event.button !== 0) return;
            const connection = { nodeId, handleType } as ConnectionHandle;
            const mouseWorld = screenToCanvas(event.clientX, event.clientY);
            connectionInitialPreviewRef.current = { handle: connection, mouseWorld };
            setConnecting(connection);
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
            setSelectedConnectionId(null);
        },
        [screenToCanvas, setConnecting],
    );

    const applyLiveResizePreview = useCallback(
        (preview: CanvasResizePreview) => {
            resizePreviewRef.current = preview;
            const nextResizeConnectionIds = collectAffectedConnectionIds(new Set(preview.keys()), connectionAdjacency);
            if (!sameCanvasIdSet(resizeConnectionIdsRef.current, nextResizeConnectionIds)) {
                resizeConnectionIdsRef.current = nextResizeConnectionIds;
                setResizeConnectionIds(nextResizeConnectionIds);
            }
            if (!nodeResizingRef.current) {
                nodeResizingRef.current = true;
                setIsNodeResizing(true);
            }

            const allAffectedConnectionIds = new Set(draggedConnectionIdsRef.current);
            nextResizeConnectionIds.forEach((id) => allAffectedConnectionIds.add(id));
            canvasConnectionLayerRef.current?.refresh(viewportRef.current, allAffectedConnectionIds);
            canvasGroupLayerRef.current?.refresh();
            if (canvasConnectionFallback) setResizePreviewById(preview);
        },
        [canvasConnectionFallback, connectionAdjacency],
    );

    const handleNodeResize = useCallback((nodeId: string, width: number, height: number, position?: Position) => {
        const preview = createResizePreview(nodeId, { position: canvasNodeResizeStartPosition(nodeByIdRef.current, nodeId, position), width, height });
        if (!nodeResizingRef.current) {
            nodeResizingRef.current = true;
            setIsNodeResizing(true);
            handleCanvasInteractionChange(true);
        }
        pendingResizePreviewRef.current = preview;
        if (resizePreviewRafRef.current) return;
        resizePreviewRafRef.current = requestAnimationFrame(() => {
            resizePreviewRafRef.current = null;
            const pending = pendingResizePreviewRef.current;
            pendingResizePreviewRef.current = null;
            if (pending) applyLiveResizePreview(pending);
        });

    }, [applyLiveResizePreview, handleCanvasInteractionChange]);

    const finishNodeResize = useCallback((nodeId: string, width: number, height: number, position: Position) => {
        if (resizePreviewRafRef.current) {
            cancelAnimationFrame(resizePreviewRafRef.current);
            resizePreviewRafRef.current = null;
        }
        pendingResizePreviewRef.current = null;
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, width, height, position } : node)));
        resizePreviewRef.current = new Map();
        setResizePreviewById(resizePreviewRef.current);
        resizeConnectionIdsRef.current = new Set();
        setResizeConnectionIds(resizeConnectionIdsRef.current);
        nodeResizingRef.current = false;
        setIsNodeResizing(false);
        handleCanvasInteractionChange(false);
    }, [handleCanvasInteractionChange]);

    useEffect(() => () => {
        if (resizePreviewRafRef.current) cancelAnimationFrame(resizePreviewRafRef.current);
        pendingResizePreviewRef.current = null;
    }, []);

    const toggleNodeFreeResize = useCallback((nodeId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const freeResize = !node.metadata?.freeResize;
                if (freeResize || node.type !== CanvasNodeType.Image) return { ...node, metadata: { ...node.metadata, freeResize } };
                const ratio = (node.metadata?.naturalWidth || node.width) / (node.metadata?.naturalHeight || node.height || 1);
                const height = node.width / ratio;
                return { ...node, height, position: { x: node.position.x, y: node.position.y + node.height / 2 - height / 2 }, metadata: { ...node.metadata, freeResize } };
            }),
        );
    }, []);

    const handleNodeContentChange = useCallback((nodeId: string, content: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, content } } : node)));
    }, []);

    const toggleBatchExpanded = useCallback((nodeId: string) => {
        const isExpanded = Boolean(nodesRef.current.find((node) => node.id === nodeId)?.metadata?.imageBatchExpanded);
        transientTimeoutsRef.current.clear(`batch-opening-${nodeId}`);
        transientTimeoutsRef.current.clear(`batch-collapsing-${nodeId}`);
        if (isExpanded) {
            setOpeningBatchIds((prev) => {
                if (!prev.has(nodeId)) return prev;
                const next = new Set(prev);
                next.delete(nodeId);
                return next;
            });
            setCollapsingBatchIds((prev) => new Set(prev).add(nodeId));
            transientTimeoutsRef.current.schedule(`batch-collapsing-${nodeId}`, () => {
                setCollapsingBatchIds((prev) => {
                    const next = new Set(prev);
                    next.delete(nodeId);
                    return next;
                });
            }, 320);
        } else {
            setCollapsingBatchIds((prev) => {
                if (!prev.has(nodeId)) return prev;
                const next = new Set(prev);
                next.delete(nodeId);
                return next;
            });
            setOpeningBatchIds((prev) => new Set(prev).add(nodeId));
            transientTimeoutsRef.current.schedule(`batch-opening-${nodeId}`, () => {
                setOpeningBatchIds((prev) => {
                    const next = new Set(prev);
                    next.delete(nodeId);
                    return next;
                });
            }, 260);
        }
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                return { ...node, metadata: { ...node.metadata, imageBatchExpanded: !node.metadata?.imageBatchExpanded } };
            }),
        );
    }, []);

    const setBatchPrimary = useCallback((child: CanvasNodeData) => {
        const rootId = child.metadata?.batchRootId;
        if (!rootId || !child.metadata?.content) return;
        setNodes((prev) =>
            prev.map((node) =>
                node.id === rootId
                    ? {
                          ...node,
                          width: child.width,
                          height: child.height,
                          metadata: {
                              ...node.metadata,
                              content: child.metadata?.content,
                              storageKey: child.metadata?.storageKey,
                              compareSources: child.metadata?.compareSources,
                              references: child.metadata?.references,
                              primaryImageId: child.id,
                              naturalWidth: child.metadata?.naturalWidth,
                              naturalHeight: child.metadata?.naturalHeight,
                              freeResize: child.metadata?.freeResize,
                          },
                      }
                    : node,
            ),
        );
    }, []);

    const openTextEditor = useCallback((node: CanvasNodeData) => {
        if (node.type !== CanvasNodeType.Text) return;
        setSelectedNodeIds(new Set([node.id]));
        setSelectedConnectionId(null);
        setDialogNodeId(node.id);
        setEditingNodeId(node.id);
        setEditRequestNonce((value) => value + 1);
    }, []);

    const handleNodePromptChange = useCallback((nodeId: string, prompt: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...canvasNodePromptDraftPatch(prompt) } } : node)));
    }, []);

    const handleConfigNodeChange = useCallback((nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? applyNodeConfigPatch(node, patch) : node)));
    }, []);

    const downloadNodeImage = useCallback(async (node: CanvasNodeData) => {
        if ((node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) || !node.metadata?.content) return;
        try {
            const { downloadCanvasContent, downloadCanvasImage, loadCanvasImageVariants, hasCanvasImageVariants } = await loadCanvasExport();
            if (node.type === CanvasNodeType.Image) {
                const variants = await loadCanvasImageVariants(node);
                const current = nodesRef.current.find(item => item.id === node.id);
                if (savedProjectIdRef.current !== projectId || !current || current.metadata?.content !== node.metadata.content || current.metadata?.storageKey !== node.metadata.storageKey) return;
                if (variants && hasCanvasImageVariants(variants)) {
                    setImageDownload({ projectId, node: current, variants });
                    return;
                }
                if (variants?.warning) message.warning(`后处理提示：${variants.warning}`);
                await downloadCanvasImage(node);
            }
            else downloadCanvasContent(node.metadata.content, `canvas-${node.type}-${node.id}.${node.type === CanvasNodeType.Video ? "mp4" : audioExtension(node.metadata.mimeType)}`);
        } catch (error) { message.error(error instanceof Error ? error.message : "图片下载失败"); }
    }, [message, projectId]);

    const saveNodeAsset = useCallback(
        async (node: CanvasNodeData) => {
            if (node.type === CanvasNodeType.Text) {
                const content = node.metadata?.content?.trim();
                if (!content) return message.error("没有可保存的文本");
                addAsset({
                    kind: "text",
                    title: node.metadata?.prompt?.slice(0, 24) || "画布文本",
                    coverUrl: "",
                    tags: [],
                    source: "无线画布",
                    data: { content },
                    metadata: { source: "canvas", module: "无线画布", nodeId: node.id, prompt: node.metadata?.prompt, model: node.metadata?.model, projectId },
                });
                message.success("已加入我的素材");
                return;
            }
            if (node.type === CanvasNodeType.Video) {
                if (!node.metadata?.content) return message.error("没有可保存的视频");
                addAsset({
                    kind: "video",
                    title: node.metadata?.prompt?.slice(0, 24) || "画布视频",
                    coverUrl: "",
                    tags: [],
                    source: "无线画布",
                    data: { url: node.metadata.content, storageKey: node.metadata.storageKey, width: node.width, height: node.height, bytes: node.metadata.bytes || 0, mimeType: node.metadata.mimeType || "video/mp4" },
                    metadata: {
                        source: "canvas",
                        module: "无线画布",
                        nodeId: node.id,
                        prompt: node.metadata?.prompt,
                        model: node.metadata?.model,
                        projectId,
                        recreatePath: `/video?prompt=${encodeURIComponent(String(node.metadata?.prompt || ""))}&model=${encodeURIComponent(String(node.metadata?.model || ""))}`,
                    },
                });
                message.success("已加入我的素材");
                return;
            }
            if (!node.metadata?.content) return message.error("没有可保存的图片");
            const dataUrl = node.metadata.storageKey ? "" : node.metadata.content;
            addAsset({
                kind: "image",
                title: canvasImageExportStem(node),
                coverUrl: node.metadata.content,
                tags: [],
                source: "无线画布",
                data: {
                    dataUrl,
                    storageKey: node.metadata.storageKey,
                    width: node.metadata.naturalWidth || node.width,
                    height: node.metadata.naturalHeight || node.height,
                    bytes: node.metadata.bytes || getDataUrlByteSize(dataUrl),
                    mimeType: node.metadata.mimeType || "image/png",
                },
                metadata: {
                    source: "canvas",
                    module: "无线画布",
                    nodeId: node.id,
                    prompt: node.metadata?.prompt,
                    model: node.metadata?.model,
                    projectId,
                    recreatePath: `/image?tool=${node.metadata?.generationType === "edit" ? "image-edit" : "image-generation"}&prompt=${encodeURIComponent(String(node.metadata?.prompt || ""))}&model=${encodeURIComponent(String(node.metadata?.model || ""))}`,
                    imageName: canvasImageBaseName(node), imageVersion: canvasImageVersion(node),
                },
            });
            message.success("已加入我的素材");
        },
        [addAsset, message, projectId],
    );

    const restoreNodeGenerationInput = async (node: CanvasNodeData) => {
        if (!node.metadata?.sourceTaskId || restoringGenerationRef.current) return;
        restoringGenerationRef.current = true;
        const dismiss = message.loading("正在校验历史参数和参考原图…", 0);
        try {
            const [{ restoreGenerationDraft }, { createCanvasRestoredGenerationNode }] = await Promise.all([import("@/services/api/generation-history"), import("@/lib/canvas/canvas-generation-draft")]);
            const draft = await restoreGenerationDraft(node.metadata.sourceTaskId);
            if (designProjectIdRef.current !== projectId) return;
            if (nodesRef.current.find(item => item.id === node.id) !== node) { message.warning("图片已变化，未应用历史输入，请重新打开"); return; }
            const position = { x: Math.max(...nodesRef.current.map(item => item.position.x + item.width)) + 120, y: node.position.y };
            const restored = createCanvasRestoredGenerationNode(draft, position);
            setNodes(current => [...current, restored]);
            setSelectedNodeIds(new Set([restored.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(restored.id);
            focusCanvasArea(restored.position, restored.width, restored.height);
            message.success("已新增恢复配置，原图和现有草稿保持不变；尚未生成");
        } catch (error) { message.error(error instanceof Error ? error.message : "历史输入恢复失败，画布未改变"); }
        finally { restoringGenerationRef.current = false; dismiss(); }
    };

    const openImageCompare = useCallback((node?: CanvasNodeData) => {
        if (!localToolsEnabled) return;
        const selected = Array.from(selectedNodeIdsRef.current);
        setCompareImageIds(node ? [node.id, ...selected.filter(id => id !== node.id)] : selected);
        setContextMenu(null);
    }, [localToolsEnabled]);

    const applyDesignTemplate = async (id: import("@/lib/canvas/canvas-design-templates").CanvasDesignTemplateId, steps: import("@/lib/canvas/canvas-design-templates").CanvasDesignTemplateSteps, title?: string) => {
        if (!localToolsEnabled) return;
        const sourceId = templateSourceId;
        const { createCanvasDesignTemplate } = await import("@/lib/canvas/canvas-design-templates");
        if (designProjectIdRef.current !== projectId) return;
        const source = sourceId ? nodesRef.current.find(node => node.id === sourceId) : undefined;
        if (sourceId && !source) { message.warning("参考图已移除，请重新选择"); return; }
        const position = { x: nodesRef.current.length ? Math.max(...nodesRef.current.map(node => node.position.x + node.width)) + 120 : 0, y: source?.position.y || 0 };
        const result = createCanvasDesignTemplate(id, source, position, effectiveConfig.imageModel || effectiveConfig.model, undefined, steps, title);
        setNodes(current => [...current, ...result.nodes]);
        setConnections(current => [...current, ...result.connections]);
        setGroups(current => [...current, result.group]);
        const config = result.nodes.find(node => node.type === CanvasNodeType.Config)!;
        setSelectedNodeIds(new Set([config.id]));
        setSelectedConnectionId(null);
        setDialogNodeId(config.id);
        setTemplateSourceId(undefined);
        focusCanvasArea(config.position, config.width, config.height);
        message.success("已添加 3 个生成配置；编辑提示词后逐个点击生成，当前未调用模型");
    };

    const arrangeNodes = async (mode: import("@/lib/canvas/canvas-node-arrange").CanvasArrangeMode) => {
        if (!localToolsEnabled) return;
        const { arrangeCanvasNodes } = await import("@/lib/canvas/canvas-node-arrange");
        if (designProjectIdRef.current !== projectId) return;
        const next = arrangeCanvasNodes(nodesRef.current, groupsRef.current, selectedNodeIdsRef.current, mode);
        if (next === nodesRef.current) { message.info("至少需要两个可移动单元；同一款式组视为一个整体"); return; }
        setNodes(next);
        message.success("排版已更新，款式组内相对位置保留，可撤销");
    };

    const createImageReversePromptNodes = useCallback(
        (node: CanvasNodeData) => {
            if (node.type !== CanvasNodeType.Image || !node.metadata?.content) {
                message.warning("图片节点为空，无法反推提示词");
                return;
            }

            const gap = 96;
            const textSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
            const configSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Config];
            const centerY = node.position.y + node.height / 2;
            const textNode = {
                ...createCanvasNode(CanvasNodeType.Text, { x: node.position.x + node.width + gap + textSpec.width / 2, y: centerY }, { content: IMAGE_PROMPT_REVERSE_PRESET, prompt: IMAGE_PROMPT_REVERSE_PRESET, status: NODE_STATUS_SUCCESS, fontSize: 14 }),
                title: "反推提示词",
            };
            const configNode = {
                ...createCanvasNode(
                    CanvasNodeType.Config,
                    { x: textNode.position.x + textNode.width + gap + configSpec.width / 2, y: centerY },
                    {
                        generationMode: "text",
                        model: effectiveConfig.textModel || effectiveConfig.model || defaultConfig.textModel,
                        count: 1,
                        composerContent: `参考图片：@[node:${node.id}]\n任务说明：@[node:${textNode.id}]`,
                    },
                ),
                title: "反推提示词配置",
            };

            setNodes((prev) => [...prev, textNode, configNode]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: configNode.id }, { id: nanoid(), fromNodeId: textNode.id, toNodeId: configNode.id }]);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
            setContextMenu(null);
        },
        [effectiveConfig.model, effectiveConfig.textModel, message],
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
                message.success(`已切分为 ${childNodes.length} 个子节点`);
            });
        },
        [message, runLocalImageOperation],
    );

    const maskEditImageNode = useCallback(
        async (node: CanvasNodeData, payload: CanvasImageMaskEditPayload) => {
            if (!node.metadata?.content) return;
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
                message.error(error instanceof Error ? error.message : "无法确认原图与蒙版尺寸，尚未提交生成");
                return;
            }
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                handleMissingModelConfig();
                return;
            }
            if (!usage.configured) {
                message.error("管理员尚未为该局部编辑模型启用价格或接口");
                return;
            }
            if (!user || user.status !== "active") {
                message.error("当前设计师账号不可用");
                return;
            }
            if (deploymentFeatures.creditsEnabled && user.creditBalance < usage.credits) {
                message.error(`额度不足：本次局部编辑需要 ${usage.credits} 积分，当前剩余 ${user.creditBalance} 积分`);
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
        [addAsset, createOptions, effectiveConfig, estimateUsage, finishGenerationRequest, handleMissingModelConfig, isAiConfigReady, message, projectId, startGenerationRequest, user],
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

    const handleFontSizeChange = useCallback((nodeId: string, fontSize: number) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, fontSize } } : node)));
    }, []);

    const handleUploadRequest = useCallback((nodeId?: string, position?: Position) => {
        uploadTargetRef.current = { nodeId, position };
        imageInputRef.current?.click();
    }, []);

    const handleImageInputChange = useCallback(
        async (event: ReactChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];
            const target = uploadTargetRef.current;
            uploadTargetRef.current = null;
            event.target.value = "";
            if (!file || (!file.type.startsWith("image/") && !file.type.startsWith("video/") && !isAudioFile(file))) return;
            try {
                if (file.type.startsWith("image/")) assertCanvasImageUploadSize(file);
                if (target?.nodeId) {
                    if (isAudioFile(file)) {
                        const audio = await uploadMediaFile(file, "audio");
                        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                        flushPendingHistory();
                        setNodes((prev) =>
                            prev.map((node) =>
                                node.id === target.nodeId
                                    ? {
                                          ...node,
                                          type: CanvasNodeType.Audio,
                                          title: file.name,
                                          position: { x: node.position.x + node.width / 2 - spec.width / 2, y: node.position.y + node.height / 2 - spec.height / 2 },
                                          width: spec.width,
                                          height: spec.height,
                                          metadata: { ...node.metadata, ...audioMetadata(audio), errorDetails: undefined },
                                      }
                                    : node,
                            ),
                        );
                        setSelectedNodeIds(new Set([target.nodeId]));
                        setSelectedConnectionId(null);
                        return;
                    }
                    if (file.type.startsWith("video/")) {
                        const video = await uploadMediaFile(file, "video");
                        const nextSize = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                        flushPendingHistory();
                        setNodes((prev) =>
                            prev.map((node) =>
                                node.id === target.nodeId
                                    ? {
                                          ...node,
                                          type: CanvasNodeType.Video,
                                          title: file.name,
                                          position: { x: node.position.x + node.width / 2 - nextSize.width / 2, y: node.position.y + node.height / 2 - nextSize.height / 2 },
                                          width: nextSize.width,
                                          height: nextSize.height,
                                          metadata: { ...node.metadata, ...videoMetadata(video), errorDetails: undefined },
                                      }
                                    : node,
                            ),
                        );
                        setSelectedNodeIds(new Set([target.nodeId]));
                        setSelectedConnectionId(null);
                        setDialogNodeId(target.nodeId);
                        return;
                    }
                    const image = await uploadImage(file);
                    const size = fitNodeSize(image.width, image.height);
                    flushPendingHistory();
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Image,
                                      title: file.name,
                                      width: size.width,
                                      height: size.height,
                                      metadata: {
                                          ...node.metadata,
                                          ...imageMetadata(image),
                                          errorDetails: undefined,
                                          freeResize: false,
                                          isBatchRoot: undefined,
                                          batchRootId: undefined,
                                          batchChildIds: undefined,
                                          batchUsesReferenceImages: undefined,
                                          generationType: undefined,
                                          model: undefined,
                                          size: undefined,
                                          quality: undefined,
                                          count: undefined,
                                          references: undefined,
                                          compareSources: undefined,
                                          primaryImageId: undefined,
                                          imageBatchExpanded: undefined,
                                      },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                    setDialogNodeId(target.nodeId);
                } else {
                    const position = target?.position || screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                    await (isAudioFile(file) ? createAudioFileNode(file, position) : file.type.startsWith("video/") ? createVideoFileNode(file, position) : createImageFileNode(file, position));
                }
            } catch (error) {
                message.error(error instanceof Error ? error.message : "素材导入失败，请重试");
            }
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode, flushPendingHistory, message, screenToCanvas, size.height, size.width],
    );

    const handleQuickReferenceInputChange = useCallback(
        async (event: ReactChangeEvent<HTMLInputElement>) => {
            const maximum = validateImageReferences(modelOptionName(quickGenerateModel), quickGenerateReferences).maximum;
            const remaining = Math.max(0, maximum - quickGenerateReferences.length);
            const files = Array.from(event.target.files || [])
                .filter((file) => file.type.startsWith("image/"))
                .slice(0, remaining);
            event.target.value = "";
            if (!files.length) {
                message.warning(remaining ? "请选择图片文件" : maximum ? `当前模型最多添加 ${maximum} 张参考图` : "当前模型不支持参考图");
                return;
            }

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
                setQuickGenerateReferences((current) => [...current, ...uploaded]);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "参考图上传失败");
            }
        },
        [message, quickGenerateModel, quickGenerateReferences],
    );

    const runQuickCanvasGeneration = useCallback(async () => {
        if (quickSubmissionRef.current) return;
        const selectedModel = quickGenerateModel || effectiveConfig.imageModel || effectiveConfig.model;
        const toolKey = canvasToolKey("image", quickGenerateReferences.length > 0, imageModelProfile(selectedModel).kind);
        const model = currentToolConfig({ ...effectiveConfig, model: selectedModel }, toolKey).model;
        const modelId = modelOptionName(model);
        const profile = imageModelProfile(model);
        const prompt = profile.requiresPrompt ? quickGeneratePrompt.trim() : "";
        const settings = normalizeImageModelSettings({ size: quickGenerateSize, quality: quickGenerateQuality, count: String(quickGenerateCount) }, profile);
        const count = Number(settings.count);
        const references = [...quickGenerateReferences];
        const operationType = references.length && profile.kind !== "midjourney-blend" ? "inpaint" : "image_generation";
        const toolMode = operationType === "inpaint" ? "image-edit" : "image-generation";
        const generationConfig: AiConfig = {
            ...effectiveConfig,
            model,
            imageModel: model,
            ...settings,
            imageOptions: quickGenerateImageOptions,
            count: "1",
            canvasImageCount: String(count),
        };
        const usage = estimateUsage({ operationType, toolKey, modelId, quantity: count });

        if (!prompt && profile.requiresPrompt) {
            message.error("请输入生图提示词");
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
            message.error("当前设计师账号不可用");
            return;
        }
        if (deploymentFeatures.creditsEnabled && usage.configured && user.creditBalance < usage.credits) {
            message.error(`额度不足：预计需要 ${usage.credits} 积分，当前剩余 ${user.creditBalance} 积分`);
            return;
        }

        const origin = getCanvasCenter();
        const imageSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        const nodeSize = nodeSizeFromRatio(generationConfig.size, imageSpec.width, imageSpec.height) || imageSpec;
        const gap = 36;
        const columns = Math.min(2, count);
        const rows = Math.ceil(count / columns);
        const sourceNodes = references.flatMap((reference) => reference.canvasNodeId ? nodesRef.current.filter((node) => node.id === reference.canvasNodeId) : []);
        const { x: startX, y: startY } = placeCanvasImageOutputs(nodesRef.current, sourceNodes, {
            width: columns * nodeSize.width + (columns - 1) * gap,
            height: rows * nodeSize.height + (rows - 1) * gap,
        }, origin, gap, quickGeneratePosition);
        const targetIds = Array.from({ length: count }, () => `quick-image-${nanoid()}`);
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
        setNodes((current) => [...current, ...placeholders]);
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
                    const { metadata, uploaded } = await options.generate(generationConfig, prompt, references, undefined, operationType === "inpaint");
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
                                          prompt,
                                          ...buildImageGenerationMetadata(generationType, generationConfig, count, references),
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
            message.warning(`画布生图完成，成功 ${successCount} 张，失败 ${failureCount} 张`);
        } else {
            message.success(`画布生图完成：${successCount} 张`);
        }
    }, [
        addAsset,
        createOptions,
        effectiveConfig,
        estimateUsage,
        finishGenerationRequest,
        getCanvasCenter,
        handleMissingModelConfig,
        isAiConfigReady,
        message,
        projectId,
        quickGenerateCount,
        quickGenerateImageOptions,
        quickGenerateModel,
        quickGeneratePrompt,
        quickGeneratePosition,
        quickGenerateReferences,
        quickGenerateSize,
        quickGenerateQuality,
        startGenerationRequest,
        user,
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
                if (payload.pricing.modelChanged) message.warning(payload.pricing.selectedModel ? `模型已变更，当前使用 ${payload.pricing.selectedModel.name}` : "模型已变更，请选择管理员当前启用的模型");
                const cost = !deploymentFeatures.creditsEnabled ? "不计积分" : (payload.pricing.estimate ? `${payload.pricing.estimate.totalCredits} 积分` : "以当前选择为准");
                if (payload.mode === "fill_and_generate" && !isBatch) {
                    modal.confirm({ title: "确认在画布生成？", content: `当前实际预计消耗 ${cost}。确认后才会提交任务并扣费。`, okText: "确认生成", cancelText: "仅保留填入", onOk: () => quickGenerateRef.current() });
                } else if (payload.mode === "fill_and_generate" && isBatch) {
                    message.info(`模板已填入，当前预计 ${cost}。请先选择文件夹，再确认批量生成。`);
                } else message.success(`模板已填入，当前预计 ${cost}`);
            })
            .catch((error) => {
                loadedReuseTokenRef.current.delete(token);
                message.error(error instanceof Error ? error.message : "模板复用失败");
            });
    }, [message, modal, projectLoaded, searchParams]);

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
        if (generationDispatchLocksRef.current.size) { message.info("当前任务仍在执行，请完成或停止后再运行"); return; }
        generationDispatchLocksRef.current.add("canvas-batch");
        setBatchEditRunning(true);
        try {
            const { runCanvasBatchImageEdit } = await loadBatchEditRuntime();
            await runCanvasBatchImageEdit({
                prompt: batchEditPrompt, items: batchEditItems, config: batchGenerationConfig, estimate: estimateUsage, isAiConfigReady,
                onMissingModel: handleMissingModelConfig, user, projectId, getCenter: getCanvasCenter, imageMetadata, addAssets,
                setRunning: setBatchEditRunning, setServerId: setBatchEditServerId, setAction: setBatchEditAction, setItems: setBatchEditItems,
                setNodes, setConnections, setSelectedNodeIds, message,
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "批量改图加载失败");
        } finally {
            generationDispatchLocksRef.current.delete("canvas-batch");
            setBatchEditRunning(false);
        }
    }, [addAssets, batchEditItems, batchEditPrompt, batchGenerationConfig, estimateUsage, getCanvasCenter, handleMissingModelConfig, isAiConfigReady, message, projectId, user]);

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



    const pasteAssistantImage = useCallback(
        (file: File) => {
            const position = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            void runLocalImageOperation("assistant-clipboard-paste", "粘贴", async (signal) => {
                await createImageFileNode(file, position, signal);
                message.success("已从剪切板添加图片");
            });
        },
        [createImageFileNode, message, runLocalImageOperation, screenToCanvas, size.height, size.width],
    );

    const handleAssistantSessionsChange = useCallback(async (sessions: CanvasAssistantSession[], activeId: string | null, options?: { flush: boolean }) => {
        setChatSessions(sessions);
        setActiveChatId(activeId);
        if (options?.flush) {
            // An older full-project snapshot must land before this completed conversation.
            projectSaveQueueRef.current?.flush();
            updateProject(projectId, { chatSessions: sessions, activeChatId: activeId });
            await flushCanvasPersistence();
        }
    }, [projectId, updateProject]);

    const startTitleEditing = useCallback(() => {
        setTitleDraft(currentProject?.title || "未命名画布");
        setTitleEditing(true);
    }, [currentProject?.title]);

    const finishTitleEditing = useCallback(() => {
        const nextTitle = titleDraft.trim();
        if (nextTitle) renameProject(projectId, nextTitle);
        setTitleEditing(false);
    }, [projectId, renameProject, titleDraft]);

    const preventCanvasContextMenu = useCallback((event: ReactMouseEvent) => {
        if ((event.target as HTMLElement).closest("[data-node-id],[data-connection-id]")) return;
        event.preventDefault();
        const connection = canvasConnectionFallback ? null : findConnectionAtClientPoint(event.clientX, event.clientY);
        if (!connection) {
            setContextMenu({ type: "canvas", x: event.clientX, y: event.clientY, canvasPosition: screenToCanvas(event.clientX, event.clientY) });
            return;
        }

        setSelectedConnectionId(connection.id);
        setSelectedNodeIds(new Set());
        setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId: connection.id });
    }, [canvasConnectionFallback, findConnectionAtClientPoint, screenToCanvas]);

    const executeGenerateNode = useCallback(
        async (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, onResult?: (result: CanvasGenerationResult) => void, shared?: SharedGenerationExecution) => {
            let reported = false;
            const reportResult = (outputs: CanvasGenerationOutput[]) => {
                if (reported) return;
                reported = true;
                onResult?.({ mode, outputs });
            };
            const recovered = mode === "image" ? await recoverPending(nodeId) : null;
            if (recovered) {
                reportResult(recovered);
                return;
            }
            const sourceNode = shared?.plan.targetNode || nodesRef.current.find((node) => node.id === nodeId);
            let generationConfig = shared?.config || buildGenerationConfig(effectiveConfig, sourceNode, mode);
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                handleMissingModelConfig();
                reportResult([{ nodeId, status: "failed", error: "模型配置不可用" }]);
                return;
            }

            const runningId = shared?.runningId || nodeId;
            setRunningNodeId(runningId);
            const runController = startGenerationRequest(nodeId, nodeId, runningId, shared?.controller);
            const generationOrigin = shared ? { configNodeId: shared.plan.configNode.id, sourceNodeId: nodeId, runId: shared.runId, mode } : undefined;
            const sourceTextContent = sourceNode?.type === CanvasNodeType.Text ? sourceNode.metadata?.content?.trim() || "" : "";
            const editingTextNode = mode === "text" && Boolean(sourceTextContent);
            let generationContext;
            try {
                generationContext = await hydrateNodeGenerationContext(shared?.plan.context ||
                    buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, editingTextNode ? `请根据要求修改以下文本。\n\n原文：\n${sourceTextContent}\n\n修改要求：\n${prompt}` : prompt));
            } catch (error) {
                finishGenerationRequest(nodeId, runController);
                if (!shared) setRunningNodeId(null);
                const detail = error instanceof Error ? error.message : "无法读取输入素材";
                message.error(detail);
                reportResult([{ nodeId, status: "failed", error: detail }]);
                return;
            }
            const effectivePrompt = generationContext.prompt.trim();
            if (runController.signal.aborted) {
                finishGenerationRequest(nodeId, runController);
                if (!shared) setRunningNodeId(null);
                reportResult([{ nodeId, status: "failed", error: "生成已取消" }]);
                return;
            }
            const markSourceStatus = !shared && sourceNode?.type !== CanvasNodeType.Image && !editingTextNode;
            const statusPrompt = sourceNode?.type === CanvasNodeType.Config ? effectivePrompt : prompt;
            if (!effectivePrompt && (mode === "text" || mode === "audio")) {
                finishGenerationRequest(nodeId, runController);
                if (!shared) setRunningNodeId(null);
                reportResult([{ nodeId, status: "failed", error: "缺少生成提示词" }]);
                return;
            }
            let pendingChildIds: string[] = [];
            if (markSourceStatus) setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt: statusPrompt, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));

            try {
                if (mode === "image") {
                    const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                    const isImageNode = sourceNode?.type === CanvasNodeType.Image;
                    const isEmptyImageNode = isImageNode && !sourceNode?.metadata?.content && !sourceNode?.metadata?.storageKey;
                    const savedReferences = !shared && sourceNode ? resolveCanvasNodeImageReferences(sourceNode, nodesRef.current, connectionsRef.current) : [];
                    const referenceImages = savedReferences.length ? savedReferences : generationContext.referenceImages;
                    let toolKey = shared?.toolKey;
                    if (!shared) {
                        const { resolveCanvasImageConfig } = await import("@/lib/canvas/canvas-generation-model");
                        const resolved = resolveCanvasImageConfig(generationConfig, useBusinessConfigStore.getState(), referenceImages.length > 0);
                        generationConfig = resolved.config;
                        toolKey = resolved.toolKey;
                    }
                    const profile = imageModelProfile(generationConfig.model);
                    const effectivePrompt = profile.requiresPrompt ? generationContext.prompt.trim() : "";
                    generationConfig = { ...generationConfig, ...normalizeImageModelSettings(generationConfig, profile), canvasImageCount: "1" };
                    const count = 1;
                    const referenceValidation = validateImageReferences(modelOptionName(generationConfig.model), referenceImages, profile);
                    if (!referenceValidation.valid) {
                        message.error(referenceValidation.message);
                        finishGenerationRequest(nodeId, runController);
                        if (!shared) setRunningNodeId(null);
                        reportResult([{ nodeId, status: "failed", error: referenceValidation.message }]);
                        return;
                    }
                    const generationType = referenceImages.length && profile.kind !== "midjourney-blend" ? ("edit" as const) : ("generation" as const);
                    const generationMetadata = { ...buildImageGenerationMetadata(generationType, generationConfig, count, referenceImages), generationOrigin, systemPrompt: generationConfig.systemPrompt };
                    const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : isImageNode ? CanvasNodeType.Image : CanvasNodeType.Text];
                    const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                    const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                    const workflowStep = isConfigNode && connectionsRef.current.some(edge => edge.kind === "config-sequence" && (edge.fromNodeId === nodeId || edge.toNodeId === nodeId));
                    const gap = 96;
                    const rowGap = 36;
                    const outputPosition = isEmptyImageNode ? parentPosition : placeCanvasImageOutputs(
                        nodesRef.current,
                        workflowStep ? [] : shared ? [shared.plan.configNode, shared.plan.targetNode] : sourceNode ? [sourceNode] : [],
                        imageConfig,
                        workflowStep ? { x: parentPosition.x + parentConfig.width / 2, y: parentPosition.y + parentConfig.height + gap + imageConfig.height / 2 }
                            : { x: parentPosition.x + parentConfig.width + gap + imageConfig.width / 2, y: parentPosition.y + parentConfig.height / 2 },
                        gap,
                    );
                    const rootId = isEmptyImageNode ? nodeId : nanoid();
                    const childIds = count > 1 ? Array.from({ length: count }, () => nanoid()) : [];
                    const targetIds = count > 1 ? childIds : [rootId];
                    pendingChildIds = isEmptyImageNode ? childIds : [rootId, ...childIds];
                    const rootNode: CanvasNodeData = {
                        id: rootId,
                        type: CanvasNodeType.Image,
                        title: effectivePrompt.slice(0, 32) || "Generated Image",
                        position: outputPosition,
                        width: isEmptyImageNode ? sourceNode?.width || imageConfig.width : imageConfig.width,
                        height: isEmptyImageNode ? sourceNode?.height || imageConfig.height : imageConfig.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            isBatchRoot: count > 1,
                            batchChildIds: count > 1 ? childIds : undefined,
                            batchUsesReferenceImages: referenceImages.length > 0,
                            ...generationMetadata,
                            imageBatchExpanded: count > 1 ? true : undefined,
                        },
                    };
                    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
                        id,
                        type: CanvasNodeType.Image,
                        title: effectivePrompt.slice(0, 32) || "Generated Image",
                        position: {
                            x: rootNode.position.x + rootNode.width + 120 + (index % 2) * (imageConfig.width + 36),
                            y: rootNode.position.y + Math.floor(index / 2) * (imageConfig.height + rowGap),
                        },
                        width: imageConfig.width,
                        height: imageConfig.height,
                        metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, batchRootId: count > 1 ? rootId : undefined, ...generationMetadata },
                    }));
                    const batchConnections = [...(isEmptyImageNode ? [] : [{ id: nanoid(), fromNodeId: nodeId, toNodeId: rootId, kind: "generation-output" as const }]), ...childIds.map((childId) => ({ id: nanoid(), fromNodeId: rootId, toNodeId: childId, kind: "generation-output" as const }))];

                    setNodes((prev) => [
                        ...prev.map((node) =>
                            node.id === nodeId
                                ? shared && !isEmptyImageNode ? node : isConfigNode
                                    ? {
                                          ...node,
                                          metadata: { ...node.metadata, prompt: effectivePrompt, status: NODE_STATUS_LOADING, errorDetails: undefined },
                                      }
                                    : isEmptyImageNode
                                      ? {
                                            ...node,
                                            position: rootNode.position,
                                            width: rootNode.width,
                                            height: rootNode.height,
                                            title: rootNode.title,
                                            metadata: { ...node.metadata, ...rootNode.metadata, errorDetails: undefined },
                                        }
                                      : isImageNode
                                        ? {
                                              ...node,
                                              metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined },
                                          }
                                        : {
                                              ...node,
                                              type: CanvasNodeType.Text,
                                              title: prompt.slice(0, 32) || "Prompt",
                                              width: parentConfig.width,
                                              height: parentConfig.height,
                                              metadata: { ...node.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS, fontSize: 14, errorDetails: undefined },
                                          }
                                : node,
                        ),
                        ...(isEmptyImageNode ? [] : [rootNode]),
                        ...childNodes,
                    ]);
                    setConnections((prev) => [...prev, ...batchConnections]);
                    setSelectedNodeIds(new Set([nodeId]));
                    setSelectedConnectionId(null);
                    setDialogNodeId(nodeId);

                    const controller = runController;
                    targetIds.forEach((targetId) => startGenerationRequest(targetId, nodeId, runningId, controller));
                    if (count > 1) startGenerationRequest(rootId, nodeId, runningId, controller);
                    let hasSuccess = false;
                    let hasFailure = false;
                    const imageOutputs: CanvasGenerationOutput[] = [];
                    await Promise.all(
                        targetIds.map(async (targetId) => {
                            try {
                                const imageTask = await createOptions(targetId, controller, undefined, toolKey);
                                const { metadata, uploaded } = await imageTask.generate({ ...generationConfig, count: "1" }, effectivePrompt, referenceImages.length ? referenceImages : undefined, undefined, generationType === "edit");
                                const imageSize = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                                setNodes((prev) => {
                                    const root = prev.find((node) => node.id === rootId);
                                    return prev.map((node) => {
                                        if (node.id !== targetId && node.id !== rootId) return node;
                                        const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
                                        if (node.id === rootId && (targetId === rootId || !root?.metadata?.primaryImageId))
                                            return {
                                                ...node,
                                                position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                                                width: imageSize.width,
                                                height: imageSize.height,
                                                metadata: { ...node.metadata, ...metadata, primaryImageId: targetId },
                                            };
                                        if (node.id === targetId)
                                            return {
                                                ...node,
                                                position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                                                width: imageSize.width,
                                                height: imageSize.height,
                                                metadata: { ...node.metadata, ...metadata },
                                            };
                                        return node;
                                    });
                                });
                                // Keep the first completed result in view, including Agent-created edit flows.
                                if (!workflowStep && (targetId === rootId || !hasSuccess)) {
                                    const target = targetId === rootId ? rootNode : childNodes.find((node) => node.id === targetId) || rootNode;
                                    focusCanvasArea(target.position, imageSize.width, imageSize.height);
                                }
                                addAsset({
                                    kind: "image",
                                    title: effectivePrompt.slice(0, 24) || "画布生成图片",
                                    coverUrl: uploaded.url,
                                    tags: ["无线画布"],
                                    source: "无线画布",
                                    data: { dataUrl: uploaded.url, storageKey: uploaded.storageKey, width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType },
                                    metadata: {
                                        source: "canvas",
                                        module: "无线画布",
                                        nodeId: targetId,
                                        imageName: generationMetadata.imageName, imageVersion: generationMetadata.imageVersion,
                                        prompt: effectivePrompt,
                                        model: generationConfig.model,
                                        toolMode: generationType,
                                        projectId,
                                        recreatePath: `/image?tool=${generationType === "edit" ? "image-edit" : "image-generation"}&prompt=${encodeURIComponent(effectivePrompt)}&model=${encodeURIComponent(generationConfig.model)}`,
                                    },
                                });
                                hasSuccess = true;
                                imageOutputs.push({ nodeId: targetId, status: "success", url: uploaded.url, storageKey: uploaded.storageKey });
                                if (isConfigNode) setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)));
                                return true;
                            } catch (error) {
                                if (isGenerationCanceled(error)) return false;
                                const errorDetails = error instanceof Error ? error.message : "生成失败";
                                hasFailure = true;
                                imageOutputs.push({ nodeId: targetId, status: "failed", error: errorDetails });
                                setNodes((prev) => prev.map((node) => (node.id === targetId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node)));
                            } finally {
                                finishGenerationRequest(targetId, controller);
                            }
                            return false;
                        }),
                    );
                    if (count > 1) finishGenerationRequest(rootId, controller);
                    if (controller.signal.aborted) {
                        setNodes((prev) => prev.map((node) => (node.id === nodeId && isConfigNode && node.metadata?.status === NODE_STATUS_LOADING ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined } } : node)));
                        reportResult(imageOutputs.length ? imageOutputs : [{ nodeId, status: "failed", error: "生成已取消" }]);
                        return;
                    }
                    const failureDetails = imageOutputs.find((output) => output.status === "failed")?.error || "全部图片生成失败";
                    if (hasFailure) message.error(hasSuccess ? `部分图片生成失败：${failureDetails}` : failureDetails);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === nodeId && isConfigNode
                                ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : failureDetails } }
                                : node.id === nodeId && isEmptyImageNode
                                  ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : failureDetails } }
                                  : node.id === rootId && !hasSuccess
                                    ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails: failureDetails } }
                                    : node,
                        ),
                    );
                    reportResult(imageOutputs);
                    return;
                }

                if (!shared) generationConfig = currentToolConfig(generationConfig, canvasToolKey(mode));
                if (mode === "video" || mode === "audio") {
                    const { runCanvasMediaGeneration } = await import("./canvas-media-generation-runtime");
                    const output = await runCanvasMediaGeneration({ nodeId, mode, source: sourceNode, shared: Boolean(shared), config: generationConfig, context: generationContext, origin: generationOrigin,
                        controller: runController, runningId, projectId, nodes: nodesRef, setNodes, setConnections, flushSave: () => projectSaveQueueRef.current?.flush(), isCurrent: () => designProjectIdRef.current === projectId, start: startGenerationRequest, finish: finishGenerationRequest });
                    if (output.status === "failed" && !runController.signal.aborted) message.error(output.error);
                    reportResult([output]);
                    return;
                }

                let streamed = "";
                const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                const textCount = !shared && isConfigNode ? getGenerationCount(generationConfig.count) : 1;
                const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : CanvasNodeType.Text];
                const textConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
                const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                const childIds = shared || isConfigNode || editingTextNode ? Array.from({ length: textCount }, () => nanoid()) : [];
                pendingChildIds = childIds;
                if (shared || isConfigNode || editingTextNode) {
                    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
                        id,
                        type: CanvasNodeType.Text,
                        title: effectivePrompt.slice(0, 32) || "Generated Text",
                        position: {
                            x: parentPosition.x + parentConfig.width + 96,
                            y: parentPosition.y + parentConfig.height / 2 - textConfig.height / 2 + (index - (textCount - 1) / 2) * (textConfig.height + 36),
                        },
                        width: textConfig.width,
                        height: textConfig.height,
                        metadata: { prompt: effectivePrompt, generationOrigin, status: NODE_STATUS_LOADING, fontSize: 14 },
                    }));
                    setNodes((prev) => [...prev.map((node) => (node.id === nodeId && isConfigNode ? { ...node, metadata: { ...node.metadata, prompt: effectivePrompt, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)), ...childNodes]);
                    setConnections((prev) => [...prev, ...childIds.map((childId) => ({ id: nanoid(), fromNodeId: nodeId, toNodeId: childId, kind: "generation-output" as const }))]);
                }

                const controller = runController;
                const textTargetIds = childIds.length ? childIds : [nodeId];
                textTargetIds.forEach((targetNodeId) => startGenerationRequest(targetNodeId, nodeId, runningId, controller));
                const answers = await Promise.all(
                    textTargetIds.map((targetNodeId) => {
                        let localStreamed = "";
                        return requestImageQuestion(
                            generationConfig,
                            buildNodeResponseMessages({ ...generationContext, prompt: effectivePrompt }),
                            (text) => {
                                localStreamed = text;
                                streamed = text;
                                if (isConfigNode) return;
                                textStreamBufferRef.current?.push({ nodeId: targetNodeId, content: text });
                            },
                            { signal: controller.signal, tool: "canvas-chat", onChatSubmissionStarted: shared ? (textRequestId) => {
                                setNodes(previous => previous.map(node => node.id === targetNodeId ? { ...node, metadata: { ...node.metadata, textRequestId, generationSubmissionUncertain: true } } : node));
                            } : undefined },
                        )
                            .then((answer) => ({ nodeId: targetNodeId, content: answer || localStreamed }))
                            .finally(() => finishGenerationRequest(targetNodeId, controller));
                    }),
                );
                if (controller.signal.aborted) {
                    textTargetIds.forEach((targetNodeId) => textStreamBufferRef.current?.clear(targetNodeId));
                    reportResult(textTargetIds.map((targetNodeId) => ({ nodeId: targetNodeId, status: "failed", error: "生成已取消" })));
                    return;
                }
                const answerByNodeId = new Map(answers.map((item) => [item.nodeId, item.content]));
                textTargetIds.forEach((targetNodeId) => textStreamBufferRef.current?.clear(targetNodeId));
                setNodes((prev) =>
                    prev.map((node) =>
                        childIds.includes(node.id)
                            ? { ...node, metadata: { ...node.metadata, content: answerByNodeId.get(node.id) || streamed, status: NODE_STATUS_SUCCESS, generationSubmissionUncertain: undefined } }
                            : node.id === nodeId && isConfigNode
                              ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } }
                              : node.id === nodeId && !editingTextNode && !shared
                                ? { ...node, type: CanvasNodeType.Text, title: prompt.slice(0, 32) || "Generated Text", metadata: { ...node.metadata, content: answerByNodeId.get(node.id) || streamed, status: NODE_STATUS_SUCCESS } }
                                : node,
                    ),
                );
                reportResult(answers.map((answer) => ({ nodeId: answer.nodeId, status: "success" })));
            } catch (error) {
                (pendingChildIds.length ? pendingChildIds : [nodeId]).forEach((targetNodeId) => textStreamBufferRef.current?.clear(targetNodeId));
                if (isGenerationCanceled(error)) {
                    reportResult((pendingChildIds.length ? pendingChildIds : [nodeId]).map((outputNodeId) => ({ nodeId: outputNodeId, status: "failed", error: "生成已取消" })));
                    return;
                }
                const errorDetails = error instanceof Error ? error.message : "生成失败";
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((node) => (node.id === nodeId || pendingChildIds.includes(node.id) ? (node.id === nodeId && !markSourceStatus ? node : { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails, ...(node.type === CanvasNodeType.Video ? videoTaskErrorMetadata(error) : {}) } }) : node)),
                );
                reportResult((pendingChildIds.length ? pendingChildIds : [nodeId]).map((outputNodeId) => ({ nodeId: outputNodeId, status: "failed", error: errorDetails })));
            } finally {
                finishGenerationRequest(nodeId, runController);
                if (!shared) setRunningNodeId(null);
            }
        },
        [createOptions, effectiveConfig, finishGenerationRequest, handleMissingModelConfig, isAiConfigReady, message, projectId, recoverPending, startGenerationRequest],
    );
    const handleGenerateNode = useCallback(async (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, onResult?: (result: CanvasGenerationResult) => void, sequenceLock?: string, sequenceSignal?: AbortSignal) => {
        if (!sequenceLock && connectionsRef.current.some(edge => edge.kind === "config-sequence" && (edge.fromNodeId === nodeId || edge.toNodeId === nodeId))) {
            message.info("请从配置节点的“运行工作流”按钮启动相连步骤"); return;
        }
        // Lock before the lazy import: rapid double clicks must not submit twice.
        const ownsSequenceLock = sequenceLock && generationDispatchLocksRef.current.size === 1 && generationDispatchLocksRef.current.has(sequenceLock);
        if (generationDispatchLocksRef.current.size && !ownsSequenceLock) {
            message.info("请先完成或停止当前任务");
            return;
        }
        if (!ownsSequenceLock) generationDispatchLocksRef.current.add(nodeId);
        const snapshot = { nodes: nodesRef.current, connections: connectionsRef.current };
        try {
            const { runCanvasGeneration } = await import("./canvas-shared-generation-runtime");
            if (sequenceSignal?.aborted) return;
            await runCanvasGeneration(nodeId, mode, prompt, onResult, {
                snapshot, getSnapshot: () => ({ nodes: nodesRef.current, connections: connectionsRef.current }),
                buildConfig: (node, selectedMode) => buildGenerationConfig(effectiveConfig, node, selectedMode),
                isAiConfigReady, execute: executeGenerateNode, recover: recoverPending, start: startGenerationRequest, finish: finishGenerationRequest,
                setRunning: setRunningNodeId, setNodes, message,
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : "加载失败";
            message.error(detail);
            onResult?.({ mode, outputs: [{ nodeId, status: "failed", error: detail }] });
        } finally {
            if (!ownsSequenceLock) generationDispatchLocksRef.current.delete(nodeId);
        }
    }, [effectiveConfig, executeGenerateNode, finishGenerationRequest, isAiConfigReady, message, recoverPending, startGenerationRequest]);
    useEffect(() => {
        generateNodeRef.current = handleGenerateNode;
    }, [handleGenerateNode]);

    const imageSequence = useCanvasImageSequence({
        projectId, nodes: nodesRef, connections: connectionsRef, groups: groupsRef, locks: generationDispatchLocksRef,
        setNodes, setConnections, setGroups, stopGeneration: stopGenerationByRunningId,
        generate: async (nodeId, lockKey, signal) => {
            let result: CanvasGenerationResult | undefined;
            const node = nodesRef.current.find(item => item.id === nodeId);
            await handleGenerateNode(nodeId, "image", node?.metadata?.composerContent || "", value => { result = value; }, lockKey, signal);
            return result;
        },
    });

    const updateMediaWorkflow = useCallback((messageId: string, updater: (workflow: CanvasAgentMediaWorkflow) => CanvasAgentMediaWorkflow) => {
        setChatSessions((sessions) =>
            sessions.map((session) => ({
                ...session,
                messages: session.messages.map((item) => {
                    const workflow = item.id === messageId ? item.detail?.mediaWorkflow : undefined;
                    return workflow ? { ...item, detail: { ...item.detail, mediaWorkflow: updater(workflow) } } : item;
                }),
            })),
        );
    }, []);

    const runWorkflowImageStage = useCallback(
        async (messageId: string, workflow: CanvasAgentMediaWorkflow) => {
            if (workflow.intent === "video") return;
            updateMediaWorkflow(messageId, (current) => completeAgentMediaWorkflowStage(current, "image", { status: "running" }));
            const { configId, ops } = buildAgentMediaWorkflowStageOps(workflow, "image", nodesRef.current);
            applyAgentOps(ops);
            try {
                let result: CanvasGenerationResult | undefined;
                await handleGenerateNode(configId, "image", workflow.prompt, (nextResult) => {
                    result = nextResult;
                });
                const candidates = workflowImageCandidatesFromResult(result);
                const firstFailure = result?.outputs.find((output) => output.status === "failed");
                updateMediaWorkflow(messageId, (current) =>
                    completeAgentMediaWorkflowStage(current, "image", {
                        status: candidates.some((candidate) => candidate.status === "success") ? "success" : "failed",
                        candidates,
                        error: firstFailure?.error || "图片生成失败，请重试。",
                    }),
                );
            } catch (error) {
                updateMediaWorkflow(messageId, (current) => completeAgentMediaWorkflowStage(current, "image", { status: "failed", error }));
            }
        },
        [applyAgentOps, handleGenerateNode, updateMediaWorkflow],
    );

    const runWorkflowVideoStage = useCallback(
        async (messageId: string, workflow: CanvasAgentMediaWorkflow) => {
            const dispatch = buildWorkflowVideoStageDispatch(workflow);
            if (!dispatch) {
                message.warning("请先选择一张成功候选图");
                return;
            }
            updateMediaWorkflow(messageId, (current) => completeAgentMediaWorkflowStage(current, "video", { status: "running" }));
            const { configId, ops } = buildAgentMediaWorkflowStageOps(workflow, "video", nodesRef.current, dispatch.referenceNodeIds[0]);
            applyAgentOps(ops);
            try {
                let result: CanvasGenerationResult | undefined;
                await handleGenerateNode(configId, "video", workflow.prompt, (nextResult) => {
                    result = nextResult;
                });
                const output = result?.outputs[0];
                const status = output?.status === "success" && output.url ? "success" : "failed";
                updateMediaWorkflow(messageId, (current) =>
                    completeAgentMediaWorkflowStage(current, "video", {
                        status,
                        ...(status === "success" && output ? { videoResult: { nodeId: output.nodeId, url: output.url!, ...(output.storageKey ? { storageKey: output.storageKey } : {}) } } : {}),
                        error: output?.error || "视频生成失败，请重试。",
                    }),
                );
            } catch (error) {
                updateMediaWorkflow(messageId, (current) => completeAgentMediaWorkflowStage(current, "video", { status: "failed", error }));
            }
        },
        [applyAgentOps, handleGenerateNode, message, updateMediaWorkflow],
    );

    const handleMediaWorkflowAction = useCallback(
        (action: CanvasMediaWorkflowAction) => {
            const workflow = chatSessions.flatMap((session) => session.messages).find((item) => item.id === action.messageId)?.detail?.mediaWorkflow;
            if (!workflow) return;
            if (action.type === "image_model_change") {
                updateMediaWorkflow(action.messageId, (current) => ({ ...current, imageModel: action.model }));
                return;
            }
            if (action.type === "video_model_change") {
                updateMediaWorkflow(action.messageId, (current) => ({ ...current, videoModel: action.model }));
                return;
            }
            if (action.type === "image_count_change") {
                updateMediaWorkflow(action.messageId, (current) => ({ ...current, imageCount: 1 }));
                return;
            }
            if (action.type === "image_settings_change") {
                updateMediaWorkflow(action.messageId, (current) => ({ ...current, [action.key === "quality" ? "imageQuality" : "imageOptions"]: action.value }));
                return;
            }
            if (action.type === "video_seconds_change") {
                updateMediaWorkflow(action.messageId, (current) => ({ ...current, videoSeconds: action.seconds }));
                return;
            }
            if (action.type === "aspect_ratio_change") {
                updateMediaWorkflow(action.messageId, (current) => ({ ...current, aspectRatio: action.ratio }));
                return;
            }
            if (action.type === "select_candidate") {
                updateMediaWorkflow(action.messageId, (current) => selectWorkflowCandidate(current, action.nodeId));
                return;
            }
            if (action.type === "generate_images" || (action.type === "retry" && action.stage === "image")) {
                void runWorkflowImageStage(action.messageId, workflow);
                return;
            }
            if (action.type === "open_result") {
                const node = workflow.videoResult ? nodesRef.current.find((item) => item.id === workflow.videoResult?.nodeId) : undefined;
                if (!node) return;
                setSelectedNodeIds(new Set([node.id]));
                focusCanvasArea(node.position, node.width, node.height);
                return;
            }
            if (action.type === "generate_video" || (action.type === "retry" && action.stage === "video")) void runWorkflowVideoStage(action.messageId, workflow);
        },
        [chatSessions, focusCanvasArea, runWorkflowImageStage, runWorkflowVideoStage, updateMediaWorkflow],
    );

    const handleRetryNode = useCallback(
        async (node: CanvasNodeData) => {
            if (node.type === CanvasNodeType.Image && await recoverPending(node.id)) return;
            if (node.type === CanvasNodeType.Text && node.metadata?.generationSubmissionUncertain) {
                const { confirmCanvasTextRetry } = await import("./canvas-media-generation-runtime");
                confirmCanvasTextRetry(node, { nodes: nodesRef, setNodes, locks: generationDispatchLocksRef.current, generate: handleGenerateNode, message, modal });
                return;
            }
            if (node.metadata?.mediaTask || node.metadata?.generationSubmissionUncertain) {
                const { retryCanvasMediaNode } = await import("./canvas-media-generation-runtime");
                await retryCanvasMediaNode(node.id, { projectId, nodes: nodesRef, setNodes, flushSave: () => projectSaveQueueRef.current?.flush(), isCurrent: () => designProjectIdRef.current === projectId,
                    locks: generationDispatchLocksRef.current, start: startGenerationRequest, finish: finishGenerationRequest, setRunning: setRunningNodeId, message });
                return;
            }
            if (node.type === CanvasNodeType.Video && node.metadata?.videoTaskId && node.metadata.status !== NODE_STATUS_SUCCESS) {
                if (node.metadata.videoTaskCanRecover === false) { message.warning("原视频任务提交状态待核查，请勿重复生成"); return; }
                const controller = startGenerationRequest(node.id, node.id, node.id);
                setRunningNodeId(node.id);
                setNodes((prev) => prev.map((item) => item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : item));
                try {
                    const video = await storeGeneratedVideo(await recoverVideoGenerationTask({ id: node.metadata.videoTaskId, provider: "server", model: node.metadata.model || "" }, { signal: controller.signal }));
                    const size = fitNodeSize(video.width || node.width, video.height || node.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) => prev.map((item) => item.id === node.id ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...videoMetadata(video), errorDetails: undefined, videoTaskCanRecover: undefined } } : item));
                    message.success("已取回原视频任务结果");
                } catch (error) {
                    if (isGenerationCanceled(error)) return;
                    const errorDetails = error instanceof Error ? error.message : "原视频任务查询失败";
                    message.error(errorDetails);
                    setNodes((prev) => prev.map((item) => item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, ...videoTaskErrorMetadata(error) } } : item));
                } finally {
                    finishGenerationRequest(node.id, controller);
                    setRunningNodeId(null);
                }
                return;
            }
            const origin = node.metadata?.generationOrigin;
            if (origin?.configNodeId && node.type !== CanvasNodeType.Image) {
                const config = nodesRef.current.find((item) => item.id === origin.configNodeId);
                if (!config || !nodesRef.current.some((item) => item.id === origin.sourceNodeId)) {
                    message.warning("原公共配置或任务输入已删除，不能重建此任务");
                    return;
                }
                message.info("将按当前公共配置重新执行此任务，保留已有结果");
                await handleGenerateNode(origin.sourceNodeId, origin.mode, config.metadata?.composerContent || config.metadata?.prompt || "");
                return;
            }
            const sourceNode = findRetrySourceNode(node.id, nodesRef.current, connectionsRef.current) || node;
            const batchRoot = node.metadata?.batchRootId ? nodesRef.current.find((item) => item.id === node.metadata?.batchRootId) : null;
            const savedImageMetadata = node.type === CanvasNodeType.Image ? { ...batchRoot?.metadata, ...node.metadata } : undefined;
            const hasSavedImageMetadata = Boolean(savedImageMetadata?.generationType);
            let generationConfig =
                hasSavedImageMetadata && savedImageMetadata
                    ? {
                          ...effectiveConfig,
                          model: savedImageMetadata.model || effectiveConfig.imageModel || effectiveConfig.model,
                          quality: savedImageMetadata.quality || effectiveConfig.quality,
                          imageOptions: savedImageMetadata.imageOptions ?? effectiveConfig.imageOptions,
                          systemPrompt: savedImageMetadata.systemPrompt ?? effectiveConfig.systemPrompt,
                          size: savedImageMetadata.size || effectiveConfig.size,
                          count: "1",
                      }
                    : { ...buildGenerationConfig(effectiveConfig, sourceNode, node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                handleMissingModelConfig();
                return;
            }

            const context = hasSavedImageMetadata ? null : await hydrateNodeGenerationContext(buildNodeGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, sourceNode.metadata?.prompt || node.metadata?.prompt || ""));
            const blend = node.type === CanvasNodeType.Image && imageModelProfile(generationConfig.model).kind === "midjourney-blend";
            const prompt = blend ? "" : (savedImageMetadata?.prompt || context?.prompt || "").trim();
            if (!prompt && !blend) {
                message.warning("找不到提示词，无法重试");
                return;
            }
            const generationType = savedImageMetadata?.generationType;
            const useReferenceImages = blend || (generationType ? generationType === "edit" : Boolean(context?.referenceImages.length));
            const retryReferenceImages =
                hasSavedImageMetadata && savedImageMetadata ? await resolveMetadataReferences(savedImageMetadata) : useReferenceImages ? (context?.referenceImages.length ? context.referenceImages : sourceNodeReferenceImages(batchRoot || sourceNode)) : [];
            if (useReferenceImages && !retryReferenceImages) {
                message.error("参考图片已丢失，无法继续重试");
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: "参考图片已丢失，无法继续重试" } } : item)));
                return;
            }
            const retryImages = retryReferenceImages || [];
            generationConfig = currentToolConfig(generationConfig, canvasToolKey(node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image", useReferenceImages, imageModelProfile(generationConfig.model).kind));

            setRunningNodeId(node.id);
            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : item)));
            const controller = startGenerationRequest(node.id, sourceNode.id, node.id);

            try {
                if (node.type === CanvasNodeType.Text) {
                    if (!context) return;
                    let streamed = "";
                    const answer = await requestImageQuestion(
                        generationConfig,
                        buildNodeResponseMessages({ ...context, prompt }),
                        (text) => {
                            streamed = text;
                            textStreamBufferRef.current?.push({ nodeId: node.id, content: text });
                        },
                        { signal: controller.signal, tool: "canvas-chat" },
                    );
                    textStreamBufferRef.current?.clear(node.id);
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: answer || streamed, prompt, status: NODE_STATUS_SUCCESS } } : item)));
                    return;
                }
                if (node.type === CanvasNodeType.Video) {
                    const video = await storeGeneratedVideo(await requestVideoGeneration(generationConfig, prompt, retryImages, context?.referenceVideos || [], context?.referenceAudios || [], {
                        toolKey: "canvas-video",
                        signal: controller.signal,
                        onSubmitted: (task) => setNodes((prev) => prev.map((item) => item.id === node.id ? { ...item, metadata: { ...item.metadata, videoTaskId: task.id, videoTaskCanRecover: true } } : item)),
                    }));
                    const videoSize = fitNodeSize(video.width || node.width, video.height || node.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) =>
                        prev.map((item) =>
                            item.id === node.id
                                ? {
                                      ...item,
                                      width: videoSize.width,
                                      height: videoSize.height,
                                      position: { x: item.position.x + item.width / 2 - videoSize.width / 2, y: item.position.y + item.height / 2 - videoSize.height / 2 },
                                      metadata: {
                                          ...item.metadata,
                                          ...videoMetadata(video),
                                          prompt,
                                          model: generationConfig.model,
                                          size: generationConfig.size,
                                          seconds: generationConfig.videoSeconds,
                                          videoMode: generationConfig.videoMode,
                                          vquality: generationConfig.vquality,
                                          generateAudio: generationConfig.videoGenerateAudio,
                                          watermark: generationConfig.videoWatermark,
                                      },
                                  }
                                : item,
                        ),
                    );
                    return;
                }
                if (node.type === CanvasNodeType.Audio) {
                    const audio = await storeGeneratedAudio(await requestAudioGeneration(generationConfig, prompt, { signal: controller.signal }), generationConfig.audioFormat);
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, ...audioMetadata(audio), prompt, ...buildAudioGenerationMetadata(generationConfig) } } : item)));
                    return;
                }

                const imageTask = await createOptions(node.id, controller);
                const { metadata, uploaded: uploadedImage } = await imageTask.generate(generationConfig, prompt, useReferenceImages ? retryImages : undefined, undefined, useReferenceImages && !blend);
                const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                const imageSize = fitNodeSize(uploadedImage.width, uploadedImage.height, imageConfig.width, imageConfig.height);
                const generationMetadata = savedImageMetadata?.generationType
                    ? { generationType: savedImageMetadata.generationType, model: generationConfig.model, size: generationConfig.size, quality: generationConfig.quality, count: 1, references: savedImageMetadata.references, compareSources: retryImages.map(canvasCompareSource) }
                    : buildImageGenerationMetadata(useReferenceImages ? "edit" : "generation", generationConfig, 1, retryImages);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  type: CanvasNodeType.Image,
                                  width: imageSize.width,
                                  height: imageSize.height,
                                  metadata: { ...item.metadata, ...metadata, prompt, ...generationMetadata },
                              }
                            : item,
                    ),
                );
            } catch (error) {
                textStreamBufferRef.current?.clear(node.id);
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : "生成失败";
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, ...(item.type === CanvasNodeType.Video ? videoTaskErrorMetadata(error) : {}) } } : item)));
            } finally {
                finishGenerationRequest(node.id, controller);
                setRunningNodeId(null);
            }
        },
        [createOptions, effectiveConfig, finishGenerationRequest, handleGenerateNode, handleMissingModelConfig, isAiConfigReady, message, modal, projectId, recoverPending, startGenerationRequest],
    );

    const generateImageFromTextNode = useCallback(
        (node: CanvasNodeData) => {
            const prompt = (node.metadata?.content || node.metadata?.prompt || "").trim();
            if (!prompt) {
                message.warning("文本节点为空，无法生图");
                return;
            }
            const sourceNode = nodesRef.current.find((item) => item.id === node.id);
            if (!sourceNode) return;
            const nodeSize = getNodeSpec(CanvasNodeType.Config);
            const configNode = createCanvasNode(
                CanvasNodeType.Config,
                {
                    x: sourceNode.position.x + sourceNode.width + 96 + nodeSize.width / 2,
                    y: sourceNode.position.y + sourceNode.height / 2,
                },
                {
                    prompt: "",
                    model: effectiveConfig.imageModel || effectiveConfig.model,
                    size: effectiveConfig.size,
                    count: 1,
                },
            );
            const connection = { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: configNode.id };
            const nextNodes = nodesRef.current.map((item) => (item.id === sourceNode.id ? { ...item, metadata: { ...item.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS } } : item)).concat(configNode);
            const nextConnections = [...connectionsRef.current, connection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message],
    );

    const handleNodeHoverStart = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current) return;
            scheduleSettledCanvasHover(nodeId);
        },
        [scheduleSettledCanvasHover],
    );

    const handleNodeHoverEnd = useCallback(
        (nodeId: string) => {
            clearSettledCanvasHover(nodeId);
        },
        [clearSettledCanvasHover],
    );

    const handleNodeViewImage = useCallback((node: CanvasNodeData) => setPreviewNodeId(node.id), []);

    const handleNodeContextMenu = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.preventDefault();
        event.stopPropagation();
        if (!selectedNodeIdsRef.current.has(nodeId)) commitSelectedNodeIds(new Set([nodeId]));
        setSelectedConnectionId(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId });
    }, [commitSelectedNodeIds]);

    const contextMenuNodeIds = useMemo(() => contextMenu?.type === "node"
        ? new Set(selectedNodeIds.has(contextMenu.nodeId) ? selectedNodeIds : [contextMenu.nodeId])
        : new Set<string>(), [contextMenu, selectedNodeIds]);

    const insertAssistantImage = useCallback(
        async (image: CanvasAssistantImage) => {
            const storedImage = image.storageKey ? { url: image.dataUrl, storageKey: image.storageKey, width: 1, height: 1, bytes: 0, mimeType: image.mimeType || "image/png" } : await uploadImage(image.dataUrl);
            const meta = storedImage.width === 1 && storedImage.height === 1 ? await readImageMeta(storedImage.url) : storedImage;
            const config = fitNodeSize(meta.width, meta.height);
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const node: CanvasNodeData = {
                id,
                type: CanvasNodeType.Image,
                title: image.prompt.slice(0, 32) || "Generated Image",
                position: { x: center.x - config.width / 2, y: center.y - config.height / 2 },
                width: config.width,
                height: config.height,
                metadata: { ...imageMetadata({ ...storedImage, width: meta.width, height: meta.height }), prompt: image.prompt, imageName: image.imageName, imageVersion: image.imageVersion || 1 },
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([id]));
            setSelectedConnectionId(null);
            setDialogNodeId(id);
        },
        [screenToCanvas, size.height, size.width],
    );

    const insertAssistantText = useCallback(
        (text: string) => {
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const node = {
                ...createCanvasNode(CanvasNodeType.Text, center, { content: text, status: NODE_STATUS_SUCCESS }),
                title: text.slice(0, 32) || "Assistant Text",
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
        },
        [screenToCanvas, size.height, size.width],
    );

    const handleAssetInsert = useCallback(
        async (payload: InsertAssetPayload) => {
            try {
            if (payload.kind === "text") {
                insertAssistantText(payload.content);
            } else if (payload.kind === "video") {
                const url = payload.storageKey ? await resolveMediaUrl(payload.storageKey, payload.url) : payload.url;
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                const nextSize = fitNodeSize(payload.width || spec.width, payload.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                setNodes((prev) => [
                    ...prev,
                    {
                        id,
                        type: CanvasNodeType.Video,
                        title: payload.title,
                        position: { x: center.x - nextSize.width / 2, y: center.y - nextSize.height / 2 },
                        width: nextSize.width,
                        height: nextSize.height,
                        metadata: { content: url, storageKey: payload.storageKey, status: NODE_STATUS_SUCCESS, naturalWidth: payload.width, naturalHeight: payload.height },
                    },
                ]);
                setSelectedNodeIds(new Set([id]));
            } else {
                const dataUrl = payload.storageKey ? await resolveImageUrl(payload.storageKey, payload.dataUrl) : payload.dataUrl;
                await insertAssistantImage({ id: `asset-${Date.now()}`, prompt: payload.title, dataUrl, storageKey: payload.storageKey, mimeType: payload.mimeType, imageName: payload.imageName, imageVersion: payload.imageVersion });
            }
            setAssetPickerOpen(false);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "素材读取失败，请重试");
            }
        },
        [insertAssistantImage, insertAssistantText, message, screenToCanvas, size.height, size.width],
    );

    const openAgent = useCallback((mode: CanvasAgentMode = agentMode) => {
        if (agentCloseTimerRef.current) {
            clearTimeout(agentCloseTimerRef.current);
            agentCloseTimerRef.current = null;
        }
        setAgentMode(mode);
        setAssistantMounted(true);
        setAssistantClosing(false);
        setAssistantCollapsed(false);
    }, [agentMode]);
    const closeAgent = useCallback(() => {
        if (!assistantMounted || assistantClosing) return;
        setAssistantCollapsed(true);
        setAssistantClosing(true);
        agentCloseTimerRef.current = setTimeout(() => {
            agentCloseTimerRef.current = null;
            // Keep the conversation alive while switching to Create: drafts, tool context and running requests must survive.
            setAssistantClosing(false);
        }, CANVAS_AGENT_PANEL_MOTION_MS);
    }, [assistantClosing, assistantMounted]);

    const exportProjects = useCanvasExport();
    const exportCurrentCanvas = useCallback(async () => {
        if (!currentProject) return;
        projectSaveQueueRef.current?.flush();
        const latest = useCanvasStore.getState().projects.find(project => project.id === projectId) || currentProject;
        await exportProjects([latest.id], latest.title || "无线画布", [latest]);
    }, [currentProject, projectId, exportProjects]);

    const openImageExport = useCallback(() => {
        setImageExport({ nodes: nodesRef.current, ids: Array.from(selectedNodeIdsRef.current) });
    }, []);

    const saveNodeName = () => {
        const name = renameNode?.name.trim();
        if (!name || !renameNode) return;
        setNodes(current => current.map(node => node.id === renameNode.id ? {
            ...node, title: name,
            ...(node.type === CanvasNodeType.Image ? { metadata: { ...node.metadata, imageName: name } } : {}),
        } : node));
        setRenameNode(null);
    };

    const shareCurrentCanvas = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(window.location.href);
            message.success(canvasLinkCopiedMessage[deploymentFeatures.authenticationEnabled ? "cloud" : "local"]);
        } catch {
            message.warning("无法复制链接，请从地址栏复制");
        }
    }, [message]);


    const renderCanvasNodePanel = useCallback(
        (panelNode: CanvasNodeData) =>
            panelNode.type === CanvasNodeType.Config ? null : (
                <Suspense fallback={<CanvasNodePanelLoading />}>
                    <CanvasNodePromptPanel
                        node={panelNode}
                        sharedConfig={connections.find((edge) => edge.kind === "config-target" && edge.toNodeId === panelNode.id) ? nodes.find((node) => node.id === connections.find((edge) => edge.kind === "config-target" && edge.toNodeId === panelNode.id)?.fromNodeId) : undefined}
                        onOpenSharedConfig={(configId) => { setSelectedNodeIds(new Set([configId])); setDialogNodeId(configId); }}
                        isRunning={runningNodeId === panelNode.id || connections.some((edge) => edge.kind === "config-target" && edge.toNodeId === panelNode.id && edge.fromNodeId === runningNodeId)}
                        mentionReferences={mentionReferenceIndex.get(panelNode.id)}
                        onPromptChange={handleNodePromptChange}
                        onConfigChange={handleConfigNodeChange}
                        onGenerate={handleGenerateNode}
                        onStop={(targetId) => confirmStopGeneration(generationRequestsRef.current.get(targetId)?.runningNodeId || runningNodeId || targetId)}
                        canvasNodes={nodes}
                        canvasConnections={connections}
                        onImageSettingsOpenChange={(open) => {
                            setNodeImageSettingsOpen(open);
                            if (open) setToolbarNodeId(null);
                        }}
                    />
                </Suspense>
            ),
        [confirmStopGeneration, connections, handleConfigNodeChange, handleGenerateNode, handleNodePromptChange, mentionReferenceIndex, nodes, runningNodeId],
    );

    const configNodeActionsRef = useRef<{
        handleConfigNodeChange: typeof handleConfigNodeChange;
        confirmStopGeneration: typeof confirmStopGeneration;
        handleGenerateNode: typeof handleGenerateNode;
        configGenerationInputIndex: typeof configGenerationInputIndex;
        imageSequence: typeof imageSequence;
    } | null>(null);
    configNodeActionsRef.current = { handleConfigNodeChange, confirmStopGeneration, handleGenerateNode, configGenerationInputIndex, imageSequence };

    const renderConfigNodeContent = useCallback(
        (contentNode: CanvasNodeData, { inputSummary, isRunning }: { inputSummary: { textCount: number; imageCount: number; videoCount: number; audioCount: number }; isRunning: boolean }) => {
            return (
            <Suspense fallback={null}>
            <CanvasConfigNodeContent node={contentNode} nodes={nodes} connections={connections} groups={groups}
                isRunning={isRunning} inputSummary={inputSummary} actions={configNodeActionsRef.current!} />
            </Suspense>
            );
        },
        [nodes, connections, groups, imageSequence.activeGroupId],
    );

    const addImageNodeFromToolbar = useCallback(() => createNode(CanvasNodeType.Image), [createNode]);
    const addVideoNodeFromToolbar = useCallback(() => createNode(CanvasNodeType.Video), [createNode]);
    const addAudioNodeFromToolbar = useCallback(() => createNode(CanvasNodeType.Audio), [createNode]);
    const addTextNodeFromToolbar = useCallback(() => createNode(CanvasNodeType.Text), [createNode]);
    const addConfigNodeFromToolbar = useCallback(() => createNode(CanvasNodeType.Config), [createNode]);
    const openQuickGenerateFromToolbar = useCallback(() => { setQuickGeneratePosition(null); setQuickGenerateOpen(true); closeAgent(); }, [closeAgent]);
    const openBatchEditFromToolbar = useCallback(() => setBatchEditOpen(true), []);
    const uploadFromToolbar = useCallback(() => handleUploadRequest(), [handleUploadRequest]);
    const deleteSelectedNodesFromToolbar = useCallback(() => deleteNodes(new Set(selectedNodeIdsRef.current)), [deleteNodes]);
    const openClearCanvasFromToolbar = useCallback(() => setClearConfirmOpen(true), []);
    const openAssetsFromToolbar = useCallback(() => setAssetPickerOpen(true), []);
    const closeQuickGeneratePanel = useCallback(() => { setQuickGeneratePosition(null); setQuickGenerateOpen(false); }, []);
    const clearQuickGeneratePosition = useCallback(() => setQuickGeneratePosition(null), []);
    const pickQuickGenerateReferences = useCallback(() => quickReferenceInputRef.current?.click(), []);
    const removeQuickGenerateReference = useCallback((id: string) => {
        const nodeId = quickGenerateReferences.find((reference) => reference.id === id)?.canvasNodeId;
        setQuickGenerateReferences((current) => current.filter((reference) => reference.id !== id));
        if (nodeId) { const next = new Set(selectedNodeIdsRef.current); next.delete(nodeId); commitSelectedNodeIds(next); }
    }, [commitSelectedNodeIds, quickGenerateReferences]);
    const clearQuickGenerateReferences = useCallback(() => {
        const referenceNodeIds = new Set(quickGenerateReferences.flatMap((reference) => reference.canvasNodeId ? [reference.canvasNodeId] : []));
        setQuickGenerateReferences([]);
        commitSelectedNodeIds(new Set(Array.from(selectedNodeIdsRef.current).filter((id) => !referenceNodeIds.has(id))));
    }, [commitSelectedNodeIds, quickGenerateReferences]);
    const moveQuickGenerateReference = useCallback((id: string, targetId: string) => {
        setQuickGenerateReferences((current) => moveImageReference(current, current.findIndex((reference) => reference.id === id), current.findIndex((reference) => reference.id === targetId)));
    }, []);
    const editNodeFromToolbar = useCallback((node: CanvasNodeData) => {
        if (connectionsRef.current.some((edge) => edge.kind === "config-target" && edge.toNodeId === node.id)) {
            setDialogNodeId((current) => current === node.id ? null : node.id);
        } else if (node.type === CanvasNodeType.Image && (node.metadata?.content || node.metadata?.storageKey)) {
            commitSelectedNodeIds(new Set([node.id])); setDialogNodeId(null); openQuickGenerateFromToolbar();
            requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-testid="canvas-quick-generate-panel"] textarea')?.focus());
        } else setDialogNodeId((current) => current === node.id ? null : node.id);
    }, [commitSelectedNodeIds, openQuickGenerateFromToolbar]);
    const generateQuickFromPanel = useCallback(() => void runQuickCanvasGeneration(), [runQuickCanvasGeneration]);
    const cancelTitleEditing = useCallback(() => setTitleEditing(false), []);
    const goHomeFromTopBar = useCallback(() => navigate("/"), [navigate]);
    const goProjectsFromTopBar = useCallback(() => navigate("/canvas"), [navigate]);
    const shareFromTopBar = useCallback(() => void shareCurrentCanvas(), [shareCurrentCanvas]);
    const compactAgentStatus = useMemo(
        () => (codexCompactAgent ? { connected: localAgentConnected, enabled: localAgentEnabled, activity: localAgentActivity } : undefined),
        [codexCompactAgent, localAgentConnected, localAgentEnabled, localAgentActivity],
    );
    const toggleAgentFromTopBar = useCallback(() => (assistantOpen ? closeAgent() : openAgent()), [assistantOpen, closeAgent, openAgent]);

    if (!projectLoaded) return <CanvasRefreshShell />;

    const quickGeneratePanel = (
<Suspense fallback={isCanvasDesktopLayout ? <div className="cw-panel-loading">正在加载编辑区…</div> : null}>
                    <CanvasQuickGeneratePanel
                        embedded={isCanvasDesktopLayout}
                        open={quickGenerateOpen && !assistantOpen}
                        prompt={quickGeneratePrompt}
                        model={quickGenerateModel}
                        size={quickGenerateSize}
                        quality={quickGenerateQuality}
                        count={quickGenerateCount}
                        imageOptions={quickGenerateImageOptions}
                        references={quickGenerateReferences}
                        running={quickGenerateRunning}
                        positioned={Boolean(quickGeneratePosition)}
                        onClearPosition={clearQuickGeneratePosition}
                        estimateCredits={quickGenerateEstimate.credits}
                        estimateRmb={quickGenerateEstimate.rmbCost}
                        remainingCredits={user?.creditBalance}
                        config={effectiveConfig}
                        onClose={closeQuickGeneratePanel}
                        onPromptChange={setQuickGeneratePrompt}
                        onModelChange={setQuickGenerateModel}
                        onSizeChange={setQuickGenerateSize}
                        onQualityChange={setQuickGenerateQuality}
                        onCountChange={setQuickGenerateCount}
                        onImageOptionsChange={setQuickGenerateImageOptions}
                        onPickReferences={pickQuickGenerateReferences}
                        onRemoveReference={removeQuickGenerateReference}
                        onClearReferences={clearQuickGenerateReferences}
                        onMoveReference={moveQuickGenerateReference}
                        onMissingConfig={handleMissingModelConfig}
                        onGenerate={generateQuickFromPanel}
                    />
                    </Suspense>
    );

    return (
        <main className="cw-workspace relative flex h-full min-h-0 overflow-hidden" data-theme={canvasThemeKey} style={{ background: theme.canvas.background, color: theme.node.text, "--cw-create-width": `${clampCanvasPanelWidth("create", createPanelWidth)}px`, "--cw-chat-width": `${clampCanvasPanelWidth("chat", chatPanelWidth)}px`, "--cw-prompt-height": `${clampCanvasPromptHeight(createPromptHeight)}px` } as CSSProperties}>
            <aside data-testid="canvas-left-generator-rail" className={`cw-create-panel ${quickGenerateOpen ? "cw-surface" : "is-collapsed"} ${assistantOpen ? "is-hidden" : ""}`}>
                <div className="cw-tabs" role="tablist" aria-label="创作模式">
                    <button role="tab" aria-selected={!assistantOpen} type="button" onClick={openQuickGenerateFromToolbar}>创建</button>
                    <button role="tab" aria-selected={assistantOpen} type="button" onClick={toggleAgentFromTopBar}>对话</button>
                    <div className="cw-tabs-actions">{quickGenerateOpen ? <Suspense fallback={null}><CanvasPanelSizeControl kind="create" /></Suspense> : null}<button type="button" className="cw-icon" aria-label={quickGenerateOpen ? "收起创建面板" : "展开创建面板"} aria-expanded={quickGenerateOpen} onClick={quickGenerateOpen ? closeQuickGeneratePanel : openQuickGenerateFromToolbar}><ChevronDown size={18} className={quickGenerateOpen ? "rotate-180" : undefined} /></button></div>
                </div>
                {isCanvasDesktopLayout ? quickGeneratePanel : null}
                {isCanvasDesktopLayout && quickGenerateOpen && !assistantOpen ? <Suspense fallback={null}><CanvasPanelResizeHandle kind="create" /></Suspense> : null}
            </aside>
            <section className="relative min-w-0 flex-1 overflow-hidden">
                <CanvasTopBar
                    title={currentProject?.title || "未命名画布"}
                    titleDraft={titleDraft}
                    isTitleEditing={titleEditing}
                    onTitleDraftChange={setTitleDraft}
                    onStartTitleEditing={startTitleEditing}
                    onFinishTitleEditing={finishTitleEditing}
                    onCancelTitleEditing={cancelTitleEditing}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    onHome={goHomeFromTopBar}
                    onProjects={goProjectsFromTopBar}
                    onCreateProject={createAndOpenProject}
                    onDeleteProject={deleteCurrentProject}
                    onImportImage={uploadFromToolbar}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    onExport={exportCurrentCanvas}
                    onExportImages={openImageExport}
                    onShare={shareFromTopBar}
                    onOpenTools={openWorkspaceTools}
                    agentOpen={assistantOpen}
                    compactAgentStatus={compactAgentStatus}
                    onToggleAgent={toggleAgentFromTopBar}
                />
                {!isCanvasDesktopLayout ? quickGeneratePanel : null}

                <WirelessCanvas
                    ref={wirelessCanvasRef}
                    containerRef={containerRef}
                    viewport={viewport}
                    backgroundMode={backgroundMode}
                    onViewportPreview={previewViewport}
                    onViewportChange={commitViewport}
                    onInteractionChange={handleCanvasInteractionChange}
                    onCanvasMouseDown={handleCanvasMouseDown}
                    interactionMode={interactionMode}
                    onOverviewNodePointerDown={canvasOverviewEnabled ? handleOverviewNodePointerDown : undefined}
                    onConnectionPointerDown={canvasConnectionFallback || canvasOverviewEnabled ? undefined : handleConnectionPointerDown}
                    onCanvasDeselect={deselectCanvas}
                    onContextMenu={preventCanvasContextMenu}
                    onDrop={handleDrop}
                    underlay={
                        <>
                            {!canvasConnectionFallback ? (
                                <CanvasGraphConnectionLayer
                                    ref={canvasConnectionLayerRef}
                                    connections={visibleConnections}
                                    highlight={graphHighlight}
                                    overview={canvasOverviewEnabled}
                                    resolveNode={resolveRenderNode}
                                    viewport={viewport}

                                    affectedConnectionIds={affectedConnectionIds}
                                    isDraggingNodes={isNodeDragging || isNodeResizing}
                                    onDrawFailure={enableCanvasConnectionFallback}
                                />
                            ) : null}
                            {canvasOverviewEnabled ? (
                                <CanvasOverviewLayer
                                    ref={canvasOverviewLayerRef}
                                    nodesById={nodeById}
                                    excludedNodeIds={overviewExcludedNodeIds}
                                    viewport={viewport}
                                    onDrawFailure={enableCanvasOverviewFallback}
                                />
                            ) : null}
                        </>
                    }
                >
                    {groupIndex.groups.length ? <Suspense fallback={null}><CanvasGroupLayer ref={canvasGroupLayerRef} groups={groupIndex.groups} selectedIds={selectedNodeIds} theme={theme} resolveNode={resolveRenderNode} onMove={moveGroup} onSelect={selectGroup} onRename={startGroupRename} onToggle={toggleGroup} onUngroup={ungroup} onImageSequence={groupId => imageSequence.setDialog({ groupId })} /></Suspense> : null}
                    <CanvasConnectionSvg kind={connectionSvgSurfaceKind} connections={visibleConnections} highlight={graphHighlight}
                        overview={canvasOverviewEnabled} resolveNode={resolveRenderNode} activeRef={activeConnectionPathRef}
                        onSelect={connection => { setSelectedConnectionId(connection.id); setSelectedNodeIds(new Set()); setContextMenu(null); }}
                        onContextMenu={(event, connection) => { setSelectedConnectionId(connection.id); setSelectedNodeIds(new Set()); setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId: connection.id }); }} />
                    <CanvasNodeLayer nodes={renderedNodes} highlight={graphHighlight}
                        resourceReferences={resourceReferencesForActiveNode} globalReferences={globalResourceReferenceIndex}
                        nodeProps={node => ({
                            theme, themeKey: canvasThemeKey, renderQuality: nodeRenderQuality,
                            imagePreviewEdge: canvasImagePreviewEdge(node, viewport.k, window.devicePixelRatio || 1),
                            previewPosition: dragPreviewById.get(node.id), previewBounds: resizePreviewById.get(node.id),
                            getCanvasScale, isConnectionTarget: connectionTargetNodeId === node.id,
                            isConnecting: Boolean(connectingParams), isRunning: runningNodeId === node.id,
                            editRequestNonce: editingNodeId === node.id ? editRequestNonce : 0,
                            showPanel: dialogNodeId === node.id && !isSelecting && (!(node.type === CanvasNodeType.Image && (node.metadata?.content || node.metadata?.storageKey)) || connections.some(edge => edge.kind === "config-target" && edge.toNodeId === node.id)),
                            batchCount: batchChildCountById.get(node.id) || 0, batchExpanded: Boolean(node.metadata?.imageBatchExpanded),
                            batchClosing: Boolean(node.metadata?.batchRootId && collapsingBatchIds.has(node.metadata.batchRootId)),
                            batchOpening: openingBatchIds.has(node.id), batchRecovering: collapsingBatchIds.has(node.id),
                            batchMotion: batchMotionForNode(node), showImageInfo,
                            configInputSummary: configInputSummaryForNodeId(node.id), mentionReferences: mentionReferenceIndex.get(node.id),
                            renderPanel: renderCanvasNodePanel, renderNodeContent: renderConfigNodeContent,
                            onMouseDown: handleNodeMouseDown, onHoverStart: handleNodeHoverStart, onHoverEnd: handleNodeHoverEnd,
                            onConnectStart: handleConnectStart, onResize: handleNodeResize, onResizeEnd: finishNodeResize,
                            onContentChange: handleNodeContentChange, onToggleBatch: toggleBatchExpanded, onSetBatchPrimary: setBatchPrimary,
                            onRetry: handleRetryNode, onGenerateImage: generateImageFromTextNode, onViewImage: handleNodeViewImage,
                            onContextMenu: handleNodeContextMenu,
                        })} />

                    {localToolsEnabled && !isNodeDragging && !isNodeResizing && !isSelecting && !connectingParams && singleSelectedNode?.type === CanvasNodeType.Image && renderedNodes.some(node => node.id === singleSelectedNode.id) ? <Suspense fallback={null}><CanvasInlineImageCompare key={singleSelectedNode.id} node={singleSelectedNode} nodes={nodes} scale={viewport.k} showImageInfo={showImageInfo} onAdvanced={sourceId => sourceId ? setCompareImageIds([sourceId, singleSelectedNode.id]) : openImageCompare(singleSelectedNode)} /></Suspense> : null}
                    <CanvasSelectionOverlay ref={selectionOverlayRef} borderColor={theme.canvas.selectionStroke} background={theme.canvas.selectionFill} />
                    {pendingConnectionCreate ? <Suspense fallback={null}><ConnectionCreateMenu pending={pendingConnectionCreate} onCreate={(type) => createConnectedNode(type, pendingConnectionCreate)} onClose={cancelPendingConnectionCreate} /></Suspense> : null}
                </WirelessCanvas>
                {performanceModeEnabled ? <Suspense fallback={null}><CanvasPerformancePanel metrics={performanceMetrics} /></Suspense> : null}

                {!isNodeDragging && !nodeImageSettingsOpen && !(quickGenerateOpen && !isCanvasDesktopLayout && !assistantOpen) ? (
                    <CanvasHoverToolbarHost selectedNode={singleSelectedNode} multipleSelected={hasMultipleSelectedNodes}>{toolbarNode => <Suspense fallback={null}>
                        <CanvasNodeHoverToolbar
                            node={toolbarNode}
                            viewport={viewport}
                            onKeep={keepNodeToolbar}
                            onLeave={hideNodeToolbar}
                            onInfo={(node) => setInfoNodeId(node.id)}
                            onEditText={openTextEditor}
                            onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || 14) - 2))}
                            onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(32, (node.metadata?.fontSize || 14) + 2))}
                            onToggleDialog={editNodeFromToolbar}
                            onGenerateImage={generateImageFromTextNode}
                            onUpload={(node) => handleUploadRequest(node.id)}
                            onDownload={downloadNodeImage}
                            onSaveAsset={(node) => void saveNodeAsset(node)}
                            onMaskEdit={(node) => setMaskEditNodeId(node.id)}
                            onManualEdit={(node) => { if (node.metadata?.status === "loading") { message.info("请等待这张图片生成完成后再编辑"); return; } setDialogNodeId(null); setManualEditNode(node); }}
                            onCrop={(node) => setCropNodeId(node.id)}
                            onSplit={(node) => setSplitNodeId(node.id)}
                            onUpscale={(node) => setUpscaleNodeId(node.id)}
                            onSuperResolve={(node) => setSuperResolveNodeId(node.id)}
                            onAngle={(node) => setAngleNodeId(node.id)}
                            onViewImage={(node) => setPreviewNodeId(node.id)}
                            onReversePrompt={createImageReversePromptNodes}
                            onCompare={openImageCompare}
                            onDesignTemplate={(node) => setTemplateSourceId(node.id)}
                            onImageSequence={(node) => imageSequence.setDialog({ sourceId: node.id })}
                            onRestoreGeneration={toolbarNode.metadata?.sourceTaskId ? restoreNodeGenerationInput : undefined}
                            onRetry={(node) => void handleRetryNode(node)}
                            onToggleFreeResize={(node) => toggleNodeFreeResize(node.id)}
                            onDelete={(node) => deleteNodes(new Set([node.id]))}
                        />
                    </Suspense>}</CanvasHoverToolbarHost>
                ) : null}

                <CanvasToolbar
                    interactionMode={interactionMode}
                    onInteractionModeChange={setInteractionMode}
                    selectedCount={selectedNodeIds.size}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    backgroundMode={backgroundMode}
                    showImageInfo={showImageInfo}
                    onAddImage={addImageNodeFromToolbar}
                    onAddVideo={addVideoNodeFromToolbar}
                    onAddAudio={addAudioNodeFromToolbar}
                    onAddText={addTextNodeFromToolbar}
                    onAddConfig={addConfigNodeFromToolbar}
                    onOpenQuickGenerate={openQuickGenerateFromToolbar}
                    onOpenBatchEdit={openBatchEditFromToolbar}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    onUpload={uploadFromToolbar}
                    onDelete={deleteSelectedNodesFromToolbar}
                    onClear={openClearCanvasFromToolbar}
                    onDeselect={deselectCanvas}
                    onBackgroundModeChange={setBackgroundMode}
                    onShowImageInfoChange={setShowImageInfo}
                    onOpenMyAssets={openAssetsFromToolbar}
                    onGroupSelection={createSelectedGroup}
                    onOpenTools={openWorkspaceTools}
                    viewControls={<Suspense fallback={null}><CanvasZoomControls scale={viewport.k} onScaleChange={setZoomScale} onScalePreview={previewZoomScale} onReset={resetViewport} isMiniMapOpen={isMiniMapOpen} onToggleMiniMap={toggleMiniMap} /></Suspense>}
                >
                    {localToolsEnabled && <Suspense fallback={null}><CanvasDesignActions selectedCount={selectedNodeIds.size} selectedImages={Array.from(selectedNodeIds).filter(id => nodeById.get(id)?.type === CanvasNodeType.Image && Boolean(nodeById.get(id)?.metadata?.content)).length} onCompare={openImageCompare} onTemplate={() => setTemplateSourceId(null)} onArrange={arrangeNodes} /></Suspense>}
                </CanvasToolbar>

                {isMiniMapOpen ? <Suspense fallback={null}><Minimap nodes={minimapNodes} viewport={viewport} viewportSize={size} onViewportPreview={previewMinimapViewport} onViewportChange={commitViewport} /></Suspense> : null}




                {contextMenu ? (
                    <Suspense fallback={null}>
                    <CanvasNodeContextMenu
                        menu={contextMenu}
                        targetCount={contextMenuNodeIds.size}
                        onGroup={localToolsEnabled && selectedNodeIds.size >= 2 && (contextMenu.type === "canvas" || (contextMenu.type === "node" && selectedNodeIds.has(contextMenu.nodeId))) ? createSelectedGroup : undefined}
                        onClose={() => setContextMenu(null)}
                        onUpload={contextMenu.type === "canvas" ? () => handleUploadRequest(undefined, contextMenu.canvasPosition) : undefined}
                        onGenerate={() => {
                            if (contextMenu.type !== "canvas") return;
                            openQuickGenerateFromToolbar();
                            setQuickGeneratePosition(contextMenu.canvasPosition);
                            setContextMenu(null);
                            requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-testid="canvas-quick-generate-panel"] textarea')?.focus());
                        }}
                        onDuplicate={() => {
                            if (contextMenu.type !== "node") return;
                            duplicateNodes(contextMenuNodeIds);
                            setContextMenu(null);
                        }}
                        onRename={() => {
                            if (contextMenu.type !== "node") return;
                            const node = nodesRef.current.find(item => item.id === contextMenu.nodeId);
                            if (node) setRenameNode({ id: node.id, name: node.type === CanvasNodeType.Image ? canvasImageBaseName(node) : node.title });
                            setContextMenu(null);
                        }}
                        onDelete={() => {
                            if (contextMenu.type === "node") {
                                deleteNodes(contextMenuNodeIds);
                            } else if (contextMenu.type === "connection") {
                                deleteConnection(contextMenu.connectionId);
                            }
                            setContextMenu(null);
                        }}
                    />
                    </Suspense>
                ) : null}

                <input ref={imageInputRef} type="file" accept="image/*,video/*,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" className="hidden" onChange={handleImageInputChange} />
                <input ref={quickReferenceInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleQuickReferenceInputChange} />

                {imageSequence.dialog ? <Suspense fallback={null}><CanvasImageSequenceDialog
                    key={"sourceId" in imageSequence.dialog ? imageSequence.dialog.sourceId : imageSequence.dialog.groupId}
                    controller={imageSequence}
                    groups={groups}
                    nodes={nodes}
                    model={effectiveConfig.imageModel || effectiveConfig.model}
                    onFocus={focusCanvasArea}
                    onEditConfig={id => { setSelectedNodeIds(new Set([id])); setDialogNodeId(id); }}
                    onPromptChange={(id, prompt) => handleConfigNodeChange(id, { prompt, composerContent: prompt })}
                /></Suspense> : null}
                <CanvasDialogsHost projectId={projectId} state={canvasDialogs} actions={{
                    applyDesignTemplate, saveGroupName, saveNodeName, saveManualImageEdit, cropImageNode, maskEditImageNode,
                    splitImageNode, upscaleImageNode, generateAngleNode, clearCanvas, handleAssetInsert,
                }} />
            {batchEditOpen ? <Suspense fallback={null}><CanvasBatchEditDialog open={batchEditOpen} running={batchEditRunning} prompt={batchEditPrompt} items={batchEditItems} imageSettings={batchImageSettings} serverId={batchEditServerId} action={batchEditAction} onClose={() => setBatchEditOpen(false)} onPromptChange={setBatchEditPrompt} onImageSettingsChange={setBatchImageSettings} onSelectFiles={() => batchFilesInputRef.current?.click()} onClearItems={() => setBatchEditItems([])} onRun={runBatchImageEdit} onControlBatch={controlActiveBatchEdit} /></Suspense> : null}
                <input ref={batchFilesInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleBatchFolderInputChange} />
                {localAgentModuleEnabled && codexCompactAgent && !assistantMounted ? (
                    <Suspense fallback={null}>
                        <CanvasLocalAgentPanel headless snapshotRef={agentSnapshotRef} canUndoOps={canUndoAgentOps} onApplyOps={applyAgentOps} onUndoOps={undoAgentOps} autoConnect={codexAutoConnect} />
                    </Suspense>
                ) : null}
            </section>
            {assistantMounted ? (
                <div className={`cw-agent-panel cw-surface ${agentLayout === "wide" ? "is-wide" : ""}`} style={{ display: assistantCollapsed && !assistantClosing ? "none" : undefined, pointerEvents: assistantClosing ? "none" : undefined }}>
                {isCanvasDesktopLayout && agentLayout !== "wide" ? <Suspense fallback={null}><CanvasPanelResizeHandle kind="chat" /></Suspense> : null}
                <Suspense fallback={<CanvasAgentPanelLoading /> }>
                    <CanvasAssistantPanel
                        layout={agentLayout}
                        onToggleLayout={toggleAgentLayout}
                        selectedNodeIds={selectedNodeIds}
                        selectedNodes={assistantSelectedNodes}
                        snapshotRef={agentSnapshotRef}
                        sessions={chatSessions}
                        activeSessionId={activeChatId}
                        onSelectNodeIds={setSelectedNodeIds}
                        onSessionsChange={handleAssistantSessionsChange}
                        onApplyOps={applyAgentOps}
                        canUndoOps={canUndoAgentOps}
                        onUndoOps={undoAgentOps}
                        onPasteImage={pasteAssistantImage}
                        agentMode={agentMode}
                        onAgentModeChange={setAgentMode}
                        onMediaWorkflowAction={handleMediaWorkflowAction}
                        autoConnectLocal={codexAutoConnect}
                        closing={assistantClosing}
                        onCollapse={closeAgent}
                    />
                </Suspense>
                </div>
            ) : null}
            {workspaceToolsOpen ? <Suspense fallback={null}><CanvasWorkspaceTools open={workspaceToolsOpen} onOpenChange={setWorkspaceToolsOpen} /></Suspense> : null}
        </main>
    );
}

function CanvasAgentPanelLoading() {
    return (
        <aside aria-live="polite" className="flex w-[380px] shrink-0 items-center justify-center border-l border-stone-200 bg-white/95 text-sm text-stone-400 dark:border-stone-800 dark:bg-stone-950/95">
            正在加载 Agent…
        </aside>
    );
}

function CanvasNodePanelLoading() {
    return <div aria-live="polite" className="min-h-36 rounded-xl border border-slate-200 bg-white/95 p-4 text-sm text-slate-400 shadow-[0_16px_38px_rgba(15,23,42,.10)]">正在加载编辑面板…</div>;
}




function imageExtension(dataUrl: string) {
    return dataUrl.match(/^data:image[/]([^;]+)/)?.[1] || dataUrl.match(/image[/]([^;]+)/)?.[1] || "png";
}

function audioExtension(mimeType?: string) {
    if (mimeType?.includes("wav")) return "wav";
    if (mimeType?.includes("opus")) return "opus";
    if (mimeType?.includes("aac")) return "aac";
    if (mimeType?.includes("flac")) return "flac";
    if (mimeType?.includes("pcm")) return "pcm";
    return "mp3";
}

function batchFilePath(file: File) {
    return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

function batchStatusLabel(status: BatchEditFileItem["status"]) {
    if (status === "processing") return "处理中";
    if (status === "paused") return "已暂停";
    if (status === "success") return "成功";
    if (status === "failed") return "失败";
    if (status === "cancelled") return "已取消";
    return "等待中";
}

function batchStatusClass(status: BatchEditFileItem["status"]) {
    const base = "justify-self-end rounded-full px-2 py-0.5 text-xs font-semibold";
    if (status === "processing") return `${base} bg-orange-50 text-orange-600`;
    if (status === "paused") return `${base} bg-amber-50 text-amber-700`;
    if (status === "success") return `${base} bg-emerald-50 text-emerald-600`;
    if (status === "failed") return `${base} bg-red-50 text-red-600`;
    if (status === "cancelled") return `${base} bg-stone-200 text-stone-600`;
    return `${base} bg-stone-100 text-stone-500`;
}


function imageMetadata(image: UploadedImage): CanvasNodeMetadata {
    return { imageTask: undefined, errorDetails: undefined, content: image.url, storageKey: image.storageKey, status: "success", naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType, ...(image.originalFileName ? { originalFileName: image.originalFileName, imageName: image.originalFileName.replace(/\.[^.]+$/, ""), imageVersion: 1 } : {}) };
}

function workflowImageCandidatesFromResult(result: CanvasGenerationResult | undefined): CanvasAgentMediaWorkflow["candidates"] {
    return (result?.outputs || []).map((output) => ({
        nodeId: output.nodeId,
        status: output.status,
        ...(output.url ? { url: output.url } : {}),
        ...(output.storageKey ? { storageKey: output.storageKey } : {}),
    }));
}

function videoMetadata(video: UploadedFile): CanvasNodeMetadata {
    return { content: video.url, storageKey: video.storageKey, status: "success", naturalWidth: video.width, naturalHeight: video.height, bytes: video.bytes, mimeType: video.mimeType || "video/mp4", durationMs: video.durationMs, ...(video.serverAssetId ? { serverAssetId: video.serverAssetId } : {}) };
}

function audioMetadata(audio: UploadedFile): CanvasNodeMetadata {
    return { content: audio.url, storageKey: audio.storageKey, status: "success", bytes: audio.bytes, mimeType: audio.mimeType || "audio/mpeg", durationMs: audio.durationMs };
}

function buildImageGenerationMetadata(type: CanvasImageGenerationType, config: AiConfig, count: number, references: ReferenceImage[]): CanvasNodeMetadata {
    return {
        originalFileName: originalReferenceFileName(references),
        ...canvasImageReferenceIdentity(references[0]),
        generationType: type,
        model: config.model,
        size: config.size,
        quality: config.quality,
        imageOptions: config.imageOptions || "",
        count,
        references: references.map(referenceUrl).filter((url): url is string => Boolean(url)),
        compareSources: references.map(canvasCompareSource),
    };
}

function buildAudioGenerationMetadata(config: AiConfig): CanvasNodeMetadata {
    return {
        model: config.model,
        audioVoice: config.audioVoice,
        audioFormat: config.audioFormat,
        audioSpeed: config.audioSpeed,
        audioInstructions: config.audioInstructions,
    };
}

function referenceUrl(image: ReferenceImage) {
    return image.storageKey || image.url || (!image.dataUrl.startsWith("data:") ? image.dataUrl : undefined);
}

function generationReferenceUrls(context: { referenceImages: ReferenceImage[]; referenceVideos: Array<{ storageKey?: string; url?: string }>; referenceAudios?: Array<{ storageKey?: string; url?: string }> }) {
    return [
        ...context.referenceImages.map(referenceUrl).filter((url): url is string => Boolean(url)),
        ...context.referenceVideos.map((video) => video.storageKey || video.url).filter((url): url is string => Boolean(url)),
        ...(context.referenceAudios || []).map((audio) => audio.storageKey || audio.url).filter((url): url is string => Boolean(url)),
    ];
}

async function resolveMetadataReferences(metadata: CanvasNodeMetadata) {
    if (metadata.generationType !== "edit") return [];
    if (!metadata.references?.length) return null;
    const references = await Promise.all(
        metadata.references.map(async (url, index) => {
            const dataUrl = url.startsWith("image:") ? await resolveImageUrl(url, "") : url;
            return dataUrl ? { id: `${index}`, name: `reference-${index}.png`, type: "image/png", dataUrl, storageKey: url.startsWith("image:") ? url : undefined } : null;
        }),
    );
    return references.every(Boolean) ? (references as ReferenceImage[]) : null;
}



function createCanvasHydrationContext() {
    return {
        restored: new WeakMap<object, Promise<object>>(),
        interrupted: new WeakMap<object, object>(),
        uploads: new Map<string, Promise<UploadedImage>>(),
        workflowSessions: new WeakMap<CanvasNodeData[], WeakMap<CanvasAssistantSession[], Promise<CanvasAssistantSession[]>>>(),
    };
}

type CanvasHydrationContext = ReturnType<typeof createCanvasHydrationContext>;

function memoCanvasHydration<T extends object>(context: CanvasHydrationContext, source: T, restore: () => Promise<T>): Promise<T> {
    const previous = context.restored.get(source);
    if (previous) return previous as Promise<T>;
    const pending = restore();
    context.restored.set(source, pending);
    return pending;
}

async function mapCanvasHydration<T>(items: T[], restore: (item: T) => T | Promise<T>): Promise<T[]> {
    let result: Array<T | Promise<T>> | undefined;
    for (let index = 0; index < items.length; index += 1) {
        const restored = restore(items[index]);
        if (restored !== items[index]) {
            result ||= items.slice();
            result[index] = restored;
        }
    }
    if (!result) return items;
    const resolved = await Promise.all(result);
    return resolved.every((item, index) => item === items[index]) ? items : resolved;
}

function uploadCanvasHydrationImage(content: string, context: CanvasHydrationContext) {
    let pending = context.uploads.get(content);
    if (!pending) {
        pending = uploadImage(content);
        context.uploads.set(content, pending);
    }
    return pending;
}

function sameCanvasHydrationValue(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => sameCanvasHydrationValue(value, right[index]));
    if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) || Array.isArray(right)) return false;
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameCanvasHydrationValue(a[key], b[key]));
}

async function hydrateCanvasHistory(history?: { past: CanvasHistoryEntry[]; future: CanvasHistoryEntry[] }, context = createCanvasHydrationContext()) {
    const bounded = boundedCanvasHistory(history);
    const hydrate = async (entry: CanvasHistoryEntry): Promise<CanvasHistoryEntry> => {
        const nodes = await hydrateCanvasImages(resetInterruptedGeneration(entry.nodes, context), context);
        const chatSessions = await hydrateAssistantImages(entry.chatSessions || [], nodes, context);
        return nodes === entry.nodes && chatSessions === entry.chatSessions ? entry : { ...entry, nodes, chatSessions };
    };
    return { past: await Promise.all(bounded.past.map(hydrate)), future: await Promise.all(bounded.future.map(hydrate)) };
}

async function hydrateCanvasImages(nodes: CanvasNodeData[], context = createCanvasHydrationContext()) {
    return memoCanvasHydration(context, nodes, () => mapCanvasHydration(nodes, (node) => {
            const content = node.metadata?.content;
            // Keep persisted media lazy. CanvasNode resolves its Blob URL only after
            // virtualization mounts the node, instead of opening every file on load.
            if ((node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) && node.metadata?.storageKey) return node;
            if (node.type !== CanvasNodeType.Image || !content) return node;
            if (node.metadata?.storageKey) return node;
            if (!content.startsWith("data:image/")) return node;
            return memoCanvasHydration(context, node, async () => ({ ...node, metadata: { ...node.metadata, ...imageMetadata(await uploadCanvasHydrationImage(content, context)) } }));
        }));
}

async function hydrateAssistantImages(sessions: CanvasAssistantSession[], nodes: CanvasNodeData[], context = createCanvasHydrationContext()) {
    const hydrateItem = <T extends { dataUrl?: string; storageKey?: string }>(item: T): T | Promise<T> => {
        // Agent chat previews resolve storage-backed media only when their
        // message card mounts. Do not open every historical Blob on project load.
        if (item.storageKey) return item;
        if (item.dataUrl?.startsWith("data:image/")) {
            return memoCanvasHydration(context, item, async () => {
                const image = await uploadCanvasHydrationImage(item.dataUrl!, context);
                return { ...item, dataUrl: image.url, storageKey: image.storageKey };
            });
        }
        return item;
    };
    // Reference imports are independent of a historical graph, and shared
    // messages must not be cloned/uploaded once per undo frame.
    const restored = await memoCanvasHydration(context, sessions, () => mapCanvasHydration(sessions, session => memoCanvasHydration(context, session, async () => {
        const messages = await mapCanvasHydration(session.messages, message => {
            if (!message.references?.length) return message;
            return memoCanvasHydration(context, message, async () => {
                const references = await mapCanvasHydration(message.references!, hydrateItem);
                return references === message.references ? message : { ...message, references };
            });
        });
        return messages === session.messages ? session : { ...session, messages };
    })));
    if (!restored.some(session => session.messages.some(message => message.detail?.mediaWorkflow))) return restored;
    // Workflow URLs/status do depend on each frame's nodes; do not reuse the
    // current graph's workflow result when hydrating an earlier undo state.
    let cache = context.workflowSessions.get(nodes);
    if (!cache) { cache = new WeakMap(); context.workflowSessions.set(nodes, cache); }
    let pending = cache.get(restored);
    if (!pending) {
        pending = mapCanvasHydration(restored, async session => {
            const messages = await mapCanvasHydration(session.messages, message => {
                const workflow = message.detail?.mediaWorkflow;
                if (!workflow) return message;
                const next = restoreAgentMediaWorkflow(workflow, nodes);
                return sameCanvasHydrationValue(workflow, next) ? message : { ...message, detail: { ...message.detail, mediaWorkflow: next } };
            });
            return messages === session.messages ? session : { ...session, messages };
        });
        cache.set(restored, pending);
    }
    return pending;
}

function getGenerationCount(count: string) {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(count)) || 1)));
}

function applyNodeConfigPatch(node: CanvasNodeData, patch: Partial<CanvasNodeData["metadata"]>) {
    const safePatch = patch || {};
    const next = { ...node, metadata: { ...node.metadata, ...safePatch } };
    const spec = node.type === CanvasNodeType.Video ? NODE_DEFAULT_SIZE[CanvasNodeType.Video] : NODE_DEFAULT_SIZE[CanvasNodeType.Image];
    const size = typeof safePatch.size === "string" && !node.metadata?.content ? nodeSizeFromRatio(safePatch.size, spec.width, spec.height) : null;
    return size && (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) ? { ...next, ...size, position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 } } : next;
}

function normalizeConnection(firstNodeId: string, secondNodeId: string, nodes: CanvasNodeData[], firstHandleType: "source" | "target") {
    const first = nodes.find((node) => node.id === firstNodeId);
    const second = nodes.find((node) => node.id === secondNodeId);
    return first && second ? normalizeCanvasConnection(first, second, firstHandleType) : null;
}

function getInputSummary(inputs: NodeGenerationInput[]) {
    return {
        textCount: inputs.filter((input) => input.type === "text").length,
        imageCount: inputs.filter((input) => input.type === "image").length,
        videoCount: inputs.filter((input) => input.type === "video").length,
        audioCount: inputs.filter((input) => input.type === "audio").length,
    };
}

function buildGenerationConfig(config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasNodeGenerationMode): AiConfig {
    const defaultModel = mode === "image" ? config.imageModel : mode === "video" ? config.videoModel : mode === "audio" ? config.audioModel : config.textModel;
    return {
        ...config,
        systemPrompt: node?.metadata?.systemPrompt ?? config.systemPrompt,
        model: node?.metadata?.model || defaultModel || (mode === "audio" ? defaultConfig.audioModel : config.model || defaultConfig.model),
        quality: node?.metadata?.quality || config.quality || defaultConfig.quality,
        imageOptions: node?.metadata?.imageOptions ?? config.imageOptions,
        size: node?.metadata?.size || config.size || defaultConfig.size,
        videoSeconds: node?.metadata?.seconds || config.videoSeconds || defaultConfig.videoSeconds,
        videoMode: node?.metadata?.videoMode || config.videoMode || defaultConfig.videoMode,
        vquality: node?.metadata?.vquality || config.vquality || defaultConfig.vquality,
        videoGenerateAudio: node?.metadata?.generateAudio || config.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node?.metadata?.watermark || config.videoWatermark || defaultConfig.videoWatermark,
        audioVoice: node?.metadata?.audioVoice || config.audioVoice || defaultConfig.audioVoice,
        audioFormat: node?.metadata?.audioFormat || config.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node?.metadata?.audioSpeed || config.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node?.metadata?.audioInstructions || config.audioInstructions || defaultConfig.audioInstructions,
        count: mode === "image" ? "1" : String(node?.metadata?.count || config.count || defaultConfig.count),
    };
}

function hasPendingImageTask(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    return node.type === CanvasNodeType.Image && (node.metadata?.imageTask || (node.metadata?.isBatchRoot && nodes.some(child => child.metadata?.batchRootId === node.id && child.metadata.imageTask)));
}

function resetInterruptedGeneration(nodes: CanvasNodeData[], context = createCanvasHydrationContext()) {
    const cached = context.interrupted.get(nodes);
    if (cached) return cached as CanvasNodeData[];
    let result: CanvasNodeData[] | undefined;
    for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (node.metadata?.status !== "loading") continue;
        let restored = context.interrupted.get(node) as CanvasNodeData | undefined;
        if (!restored) {
            restored = { ...node, metadata: { ...node.metadata, status: "error", errorDetails: node.type === CanvasNodeType.Video && node.metadata.videoTaskId ? "页面刷新中断了本地查询，可恢复原视频任务，不会重新生成。" : hasPendingImageTask(node, nodes) ? INTERRUPTED_IMAGE_TASK_ERROR : "页面刷新后生成已中断，请重新生成。" } };
            context.interrupted.set(node, restored);
        }
        result ||= nodes.slice();
        result[index] = restored;
    }
    context.interrupted.set(nodes, result || nodes);
    return result || nodes;
}

function videoTaskErrorMetadata(error: unknown): Partial<CanvasNodeMetadata> {
    if (error instanceof QueuedTaskPausedError) return { videoTaskId: error.taskId, videoTaskCanRecover: error.canRecover };
    if (error instanceof QueuedTaskFailedError) return { videoTaskId: undefined, videoTaskCanRecover: undefined };
    return {};
}

function isGenerationCanceled(error: unknown) {
    return error instanceof Error && (error.message === "请求已取消" || error.name === "AbortError");
}

function findRetrySourceNode(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const queue = connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId);
    const visited = new Set<string>();
    while (queue.length) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const node = nodes.find((item) => item.id === id);
        if (node?.type === CanvasNodeType.Config) return node;
        connections.filter((connection) => connection.toNodeId === id).forEach((connection) => queue.push(connection.fromNodeId));
    }
    return null;
}

function sourceNodeReferenceImages(node: CanvasNodeData | null) {
    if (!node || node.type !== CanvasNodeType.Image || !node.metadata?.content) return [];
    return [
        {
            id: node.id,
            name: `${node.title || node.id}.png`,
            type: node.metadata.mimeType || "image/png",
            dataUrl: node.metadata.content,
            storageKey: node.metadata.storageKey,
        },
    ];
}



function buildAngleLabel(params: CanvasImageAngleParams) {
    const horizontal = params.horizontalAngle === 0 ? "正面视角" : params.horizontalAngle > 0 ? `向右旋转 ${params.horizontalAngle} 度` : `向左旋转 ${Math.abs(params.horizontalAngle)} 度`;
    const pitch = params.pitchAngle === 0 ? "水平视角" : params.pitchAngle > 0 ? `俯视 ${params.pitchAngle} 度` : `仰视 ${Math.abs(params.pitchAngle)} 度`;
    return `AI 多角度：${horizontal}，${pitch}，镜头距离 ${params.cameraDistance.toFixed(1)}，${params.wideAngle ? "广角" : "标准"}镜头`;
}

function buildAnglePrompt(params: CanvasImageAngleParams) {
    return `基于参考图重新生成同一主体的新视角，保持主体、颜色、材质和画面风格一致，不要只做透视变形。${buildAngleLabel(params)}。`;
}
