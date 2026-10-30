import { useUiText, uiText } from "@/lib/i18n";
import { ChevronDown } from "lucide-react";
import type { CSSProperties, ChangeEvent as ReactChangeEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { hasPendingImageTask, INTERRUPTED_IMAGE_TASK_ERROR } from "./canvas-project-utils";
import { applyNodeConfigPatch, audioExtension, audioMetadata, createCanvasNode, getInputSummary, imageMetadata, videoMetadata, type CanvasGenerationResult } from "./canvas-project-utils";
import { useCanvasBatchEdit } from "./use-canvas-batch-edit";
import { useCanvasConnections } from "./use-canvas-connections";
import { useCanvasGeneration } from "./use-canvas-generation";
import { useCanvasImageActions } from "./use-canvas-image-actions";
import { useCanvasMediaWorkflow } from "./use-canvas-media-workflow";
import { useCanvasProjectHydration } from "./use-canvas-project-hydration";
import { useCanvasQuickGeneration } from "./use-canvas-quick-generation";

import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import type { CanvasAgentMode } from "@/components/canvas/canvas-agent-chat-ui";
import type { CanvasCommandBindings } from "@/components/canvas/canvas-command-palette";
import type { CanvasConnectionLayerHandle } from "@/components/canvas/canvas-connection-layer";
import { CanvasConnectionSvg, CanvasGraphConnectionLayer } from "@/components/canvas/canvas-connection-svg";
import type { CanvasGroupLayerHandle } from "@/components/canvas/canvas-group-layer";
import { CanvasHoverToolbarHost } from "@/components/canvas/canvas-hover-toolbar-host";
import { createConfigGenerationInputIndex } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeLayer } from "@/components/canvas/canvas-node-layer";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import type { CanvasOnboardingHandle } from "@/components/canvas/canvas-onboarding";
import { CanvasOverviewLayer, type CanvasOverviewLayerHandle } from "@/components/canvas/canvas-overview-layer";
import { canvasLinkCopiedMessage } from "@/components/canvas/canvas-save-status";
import { CanvasSelectionOverlay, type CanvasSelectionOverlayHandle } from "@/components/canvas/canvas-selection-overlay";
import { CanvasToolbar } from "@/components/canvas/canvas-toolbar";
import { CanvasTopBar } from "@/components/canvas/canvas-top-bar";
import { WirelessCanvas, type WirelessCanvasHandle } from "@/components/canvas/wireless-canvas";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { useCanManageConfig } from "@/hooks/use-can-manage-config";
import { useCanvasDesktopLayout } from "@/hooks/use-canvas-desktop-layout";
import { useCanvasExport } from "@/hooks/use-canvas-export";
import { getCanvasAntThemeConfig } from "@/lib/app-theme";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { applyCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { CANVAS_AGENT_PANEL_MOTION_MS } from "@/lib/canvas/canvas-agent-panel-constants";
import { loadCanvasAssistantPanel, loadCanvasLocalAgentPanel } from "@/lib/canvas/canvas-agent-panel-loaders";
import type { CanvasAgentUndoRecord } from "@/lib/canvas/canvas-agent-undo";
import { createCanvasBatchRenderIndex } from "@/lib/canvas/canvas-batch-motion";
import { isCanvasBatchChildHidden, isCanvasBatchConnectionEndpointHidden } from "@/lib/canvas/canvas-batch-visibility";
import { createConnectionAdjacency } from "@/lib/canvas/canvas-connection-geometry";
import { createCanvasConnectionSpatialIndex, refreshCanvasConnectionSpatialIndex, selectCanvasSpatialIndexConnections } from "@/lib/canvas/canvas-connection-spatial-index";
import { canvasConnectionSvgSurfaceKind } from "@/lib/canvas/canvas-connection-svg-visibility";
import { createCanvasDragNodeElementCache } from "@/lib/canvas/canvas-drag-node-element-cache";
import { createDragPreview, createLivePreviewNodeResolver, type CanvasDragPreview } from "@/lib/canvas/canvas-drag-preview";
import { collectCanvasDragNodes } from "@/lib/canvas/canvas-drag-selection";
import { collectAffectedConnectionIds, refreshVisibleConnectionsForDrag, sameCanvasIdSet } from "@/lib/canvas/canvas-drag-visible-connections";
import { loadCanvasExport } from "@/lib/canvas/canvas-export-loader";
import { beginCanvasHover, commitCanvasHover, endCanvasHover, resetCanvasHover, type CanvasHoverState } from "@/lib/canvas/canvas-hover-stability";
import { canvasImageExportSelection } from "@/lib/canvas/canvas-image-export-selection";
import { canvasImageBaseName } from "@/lib/canvas/canvas-image-filename";
import { canvasImageReferenceMentions, resolveCanvasNodeImageReferences } from "@/lib/canvas/canvas-image-references";
import { canvasImagePreviewEdge } from "@/lib/canvas/canvas-image-thumbnail";
import { assertCanvasImageUploadSize } from "@/lib/canvas/canvas-image-upload-limit";
import { createCanvasMinimapGeometryCache } from "@/lib/canvas/canvas-minimap-geometry-cache";
import { cloneCanvasNodeGraph, copyCanvasNodeGraph, type CanvasNodeGraph } from "@/lib/canvas/canvas-node-copy";
import { assignCanvasNodeGroup, canvasGroupMemberIds, createCanvasGroupIndex, removeCanvasGroupMembers } from "@/lib/canvas/canvas-node-groups";
import { loadCanvasNodeHoverToolbar } from "@/lib/canvas/canvas-node-hover-loaders";
import { createCanvasNodeMap, refreshCanvasNodeMap } from "@/lib/canvas/canvas-node-map";
import { loadCanvasNodePromptPanel, loadCanvasQuickGeneratePanel } from "@/lib/canvas/canvas-node-panel-loaders";
import { canvasNodePromptDraftPatch } from "@/lib/canvas/canvas-node-prompt-draft";
import { canvasNodeHasImagePreview } from "@/lib/canvas/canvas-node-rendering";
import { canvasNodeResizeStartPosition } from "@/lib/canvas/canvas-node-resize";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { findCanvasOverviewNodeHit } from "@/lib/canvas/canvas-overview-hit-test";
import { clampCanvasPanelWidth, clampCanvasPromptHeight } from "@/lib/canvas/canvas-panel-width";
import { createCanvasPerformanceTracker, type CanvasInteractionMetrics, type CanvasVisibilityCounts } from "@/lib/canvas/canvas-performance-metrics";
import { canvasPerformanceFixtureSize, isCanvasPerformanceModeEnabled } from "@/lib/canvas/canvas-performance-scenario-mode";
import { abortPendingCanvasRequests, canvasGenerationRunsForNodes } from "@/lib/canvas/canvas-project-async-lifecycle";
import { canvasRenderQualityAtScale, isCanvasOverviewScale, nextCanvasRenderQuality, type CanvasRenderQuality } from "@/lib/canvas/canvas-render-quality";
import { createResizePreview, type CanvasResizePreview } from "@/lib/canvas/canvas-resize-preview";
import { createCanvasMentionReferenceIndex, createCanvasResourceReferenceIndex } from "@/lib/canvas/canvas-resource-references";
import { createCanvasSelectedNodeCache } from "@/lib/canvas/canvas-selected-node-cache";
import { selectCanvasNodeIdsInBounds } from "@/lib/canvas/canvas-selection";
import { createCanvasSelectionGenerationSync } from "@/lib/canvas/canvas-selection-prompt";
import { syncCanvasSelectionReferences } from "@/lib/canvas/canvas-selection-references";
import { boundsForViewport, createCanvasSpatialIndex, refreshCanvasSpatialIndex } from "@/lib/canvas/canvas-spatial-index";
import { shouldPublishCanvasTextStream } from "@/lib/canvas/canvas-text-stream-visibility";
import { createCanvasTimeoutRegistry } from "@/lib/canvas/canvas-timeout-registry";
import { normalizeCanvasSelectedNodeIds } from "@/lib/canvas/canvas-view-state";
import { zoomViewportAtCanvasCenter } from "@/lib/canvas/canvas-viewport-interaction";
import { canvasViewportOverscan } from "@/lib/canvas/canvas-viewport-overscan";
import { createCanvasVisibleNodeCache } from "@/lib/canvas/canvas-visible-node-cache";
import { clampCanvasZoom } from "@/lib/canvas/canvas-zoom";
import { useCopyText } from "@/hooks/use-copy-text";
import { canvasImportGridPosition, canvasUsableArea, fitCanvasNodes } from "@/lib/canvas/canvas-interaction-ux";
import { canvasLibrarySummaries } from "@/lib/canvas/canvas-project-summary";
import { nextProjectTitle } from "@/lib/project-title";
import { deploymentFeatures } from "@/lib/deployment-features";
import { moveImageReference } from "@/lib/image-reference-policy";
import { readImageMeta } from "@/lib/image-utils";
import { resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { CanvasGraphProvider, useCanvasGraphField, useCanvasGraphSetter } from "@/stores/canvas/canvas-graph-store";
import { useCanvasAgentStore } from "@/stores/canvas/use-canvas-agent-store";
import { useCanvasPanelStore } from "@/stores/canvas/use-canvas-panel-store";
import { flushCanvasPersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useModuleEnabled } from "@/stores/use-module-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import {
    CanvasNodeType,
    type CanvasAssistantImage,
    type CanvasAssistantSession,
    type CanvasNodeData,
    type CanvasNodeGroup,
    type ContextMenuState,
    type Position,
    type SelectionBox,
    type ViewportTransform
} from "@/types/canvas";
import { App, ConfigProvider } from "antd";
import { nanoid } from "nanoid";
import { isCanvasAudioFile as isAudioFile, useCanvasClipboardDrop } from "./use-canvas-clipboard-drop";
import { isExternalImageDrag } from "@/lib/dropped-images";
import { useCanvasDialogs } from "./use-canvas-dialogs";
import { useCanvasGenerationRuntime } from "./use-canvas-generation-runtime";
import { useCanvasHistory, useCanvasHistoryState, type CanvasHistoryEntry } from "./use-canvas-history";
import { useCanvasImageSequence } from "./use-canvas-image-sequence";
import { useCanvasPersistence, useCanvasPersistenceQueue } from "./use-canvas-persistence";
import { useCanvasShortcuts } from "./use-canvas-shortcuts";
import "./workspace.css";
import "./canvas-experience.css";
import "@fontsource-variable/geist/wght.css";
const CanvasDialogsHost = lazy(() => import("@/components/canvas/canvas-dialogs-host").then(module => ({ default: module.CanvasDialogsHost })));

const CanvasAssistantPanel = lazy(loadCanvasAssistantPanel);
const CanvasCommandPalette = lazy(() => import("@/components/canvas/canvas-command-palette").then(module => ({ default: module.CanvasCommandPalette })));
const CanvasOnboarding = lazy(() => import("@/components/canvas/canvas-onboarding").then(module => ({ default: module.CanvasOnboarding })));
const CanvasTaskFeedbackRuntime = lazy(() => import("@/components/canvas/canvas-task-feedback").then(module => ({ default: module.CanvasTaskFeedbackRuntime })));
const CanvasSaveFailureNotice = lazy(() => import("@/components/canvas/canvas-save-failure-notice").then(module => ({ default: module.CanvasSaveFailureNotice })));
const loadExperienceMetrics = () => import("@/lib/canvas/canvas-experience-metrics");
const CanvasNodeContextMenu = lazy(() => import("@/components/canvas/canvas-context-menu").then(module => ({ default: module.CanvasNodeContextMenu })));
const CanvasWorkspaceTools = lazy(() => import("@/components/canvas/canvas-workspace-tools").then(module => ({ default: module.CanvasWorkspaceTools })));
const CanvasBatchEditDialog = lazy(() => import("@/components/canvas/canvas-batch-edit-dialog"));
const CanvasZoomControls = lazy(() => import("@/components/canvas/canvas-zoom-controls").then(module => ({ default: module.CanvasZoomControls })));

const CanvasDesignActions = lazy(() => import("@/components/canvas/canvas-design-actions").then(module => ({ default: module.CanvasDesignActions })));
const CanvasImageSequenceDialog = lazy(() => import("@/components/canvas/canvas-image-sequence-dialog").then(module => ({ default: module.CanvasImageSequenceDialog })));
const CanvasInlineImageCompare = lazy(() => import("@/components/canvas/canvas-inline-image-compare").then(module => ({ default: module.CanvasInlineImageCompare })));
const CanvasGroupLayer = lazy(() => import("@/components/canvas/canvas-group-layer").then(module => ({ default: module.CanvasGroupLayer })));

const CanvasPerformancePanel = lazy(() => import("@/components/canvas/canvas-performance-panel").then(module => ({ default: module.CanvasPerformancePanel })));
const CanvasConflictNotice = lazy(() => import("@/components/canvas/canvas-conflict-notice").then(module => ({ default: module.CanvasConflictNotice })));
const Minimap = lazy(() => import("@/components/canvas/canvas-mini-map").then(module => ({ default: module.Minimap })));
const CanvasLocalAgentPanel = lazy(loadCanvasLocalAgentPanel);

const CanvasConfigNodeContent = lazy(() => import("./canvas-config-node-content").then(module => ({ default: module.CanvasConfigNodeContent })));
const CanvasNodePromptPanel = lazy(loadCanvasNodePromptPanel);
const CanvasQuickGeneratePanel = lazy(loadCanvasQuickGeneratePanel);
const loadCanvasPanelControls = () => import("@/components/canvas/canvas-panel-size-control");
const CanvasPanelResizeHandle = lazy(() => loadCanvasPanelControls().then(module => ({ default: module.CanvasPanelResizeHandle })));
const CanvasPanelSizeControl = lazy(() => loadCanvasPanelControls().then(module => ({ default: module.CanvasPanelSizeControl })));
const CanvasNodeHoverToolbar = lazy(loadCanvasNodeHoverToolbar);

const VIDEO_NODE_MAX_WIDTH = 420;
const VIDEO_NODE_MAX_HEIGHT = 420;
const ConnectionCreateMenu = lazy(() => import("@/components/canvas/canvas-connection-create-menu").then(module => ({ default: module.ConnectionCreateMenu })));
const NODE_STATUS_IDLE = "idle" as const;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;
const isAiConfigReady = (..._args: unknown[]) => true;

export default function CanvasPage() {
    const t = useUiText();
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
    const t = useUiText();
    const themeKey = useThemeStore(state => state.theme);
    const theme = canvasThemes[themeKey];
    return (
        <main className="cw-workspace relative h-full min-h-0 overflow-hidden" data-theme={themeKey} style={{ background: theme.canvas.background, color: theme.node.text }} aria-label={t("正在加载画布")}>
            <div
                className="absolute inset-0"
                style={{
                    backgroundImage: `radial-gradient(circle, ${theme.canvas.dot} .9px, transparent 1.1px)`,
                    backgroundSize: "16px 16px",
                }}
            />
            <div className="cw-topbar" aria-hidden="true"><div className="cw-project-card cw-surface"><span className="cw-icon cw-brand"><span>V</span></span><span className="cw-project-title">{t("正在加载…")}</span></div><div className="cw-account-card cw-surface" /></div>
            <aside className="cw-create-panel cw-surface" aria-hidden="true"><div className="cw-tabs">{t("创建")}<span className="opacity-50">{t("对话")}</span></div><div className="h-[370px]" /></aside>
            <div className="cw-dock" aria-hidden="true"><div className="cw-tools cw-surface">
                {Array.from({ length: 7 }).map((_, index) => (
                    <div key={index} className="size-8 rounded-md bg-current opacity-10" />
                ))}
            </div></div>
        </main>
    );
}

function WirelessCanvasPage() {
    const t = useUiText();
    const { message, modal } = App.useApp();
    const copyText = useCopyText();
    const params = useParams<{ id: string }>();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const projectId = params.id || "";
    const [commandsOpen, setCommandsOpen] = useState(false);
    const [taskHighlightIds, setTaskHighlightIds] = useState<string[]>([]);
    const openCommands = useCallback(() => setCommandsOpen(true), []);
    const onboardingRef = useRef<CanvasOnboardingHandle>(null);
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
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const canManageConfig = useCanManageConfig();
    const remainingCredits = useUserStore((state) => state.user?.creditBalance);
    const addAsset = useAssetStore((state) => state.addAsset);
    const cleanupAssetImages = useAssetStore((state) => state.cleanupImages);
    const createProject = useCanvasStore((state) => state.createProject);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const projectTitle = useCanvasStore((state) => state.projects.find((project) => project.id === projectId)?.title);
    const projectSaveQueueRef = useCanvasPersistenceQueue(updateProject);
    const canvasThemeKey = useThemeStore((state) => state.theme);
    const theme = canvasThemes[canvasThemeKey];
    const [nodes, setNodes] = useCanvasGraphField("nodes");
    const canvasDialogs = useCanvasDialogs();
    const { setCompareImageIds, templateSourceId, setTemplateSourceId, setClearConfirmOpen, setAssetPickerOpen, setInfoNodeId, setCropNodeId, manualEditNode, setManualEditNode, setImageExport, setImageDownload, renameNode, setRenameNode, renameGroup, setRenameGroup, maskEditNodeId, setMaskEditNodeId, setMaskEditModel, setSplitNodeId, setUpscaleNodeId, setSuperResolveNodeId, setAngleNodeId, previewNodeId, setPreviewNodeId } = canvasDialogs;

    const designProjectIdRef = useRef(projectId);
    designProjectIdRef.current = projectId;
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
    const [isSelecting, setIsSelecting] = useState(false);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [dropActive, setDropActive] = useState(false);
    const [dropReading, setDropReading] = useState(false);
    const [importPlaceholder, setImportPlaceholder] = useState<{ position: Position; name: string; completed: number; total: number } | null>(null);
    const importLockRef = useRef(false);
    const pastePositionRef = useRef<Position | null>(null);
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

    const nodesRef = useRef(nodes);
    const connectionsRef = useRef(connections);
    const groupsRef = useRef(groups);
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    const viewportRef = useRef(viewport);
    const generateNodeRef = useRef<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, onResult?: (result: CanvasGenerationResult) => void) => Promise<void>) | null>(null);
    const selectionBoxRef = useRef<SelectionBox | null>(null);
    const agentCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const generationRuntime = useCanvasGenerationRuntime({ projectId, nodesRef, setNodes, projectSaveQueueRef, textStreamPublishingEnabledRef });
    const {
        runningNodeId, setRunningNodeId, generationRequestsRef, generationDispatchLocksRef,
        textStreamBufferRef, clearStreamedText, stopGenerationByRunningId,
    } = generationRuntime;
    const agentSelectedNodeCacheRef = useRef(createCanvasSelectedNodeCache());
    const minimapGeometryCacheRef = useRef(createCanvasMinimapGeometryCache());
    const visibleNodeCacheRef = useRef(createCanvasVisibleNodeCache());

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

    const getCanvasCenter = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        const area = canvasUsableArea(containerRef.current, size);
        return screenToCanvas((rect?.left || 0) + area.left + area.width / 2, (rect?.top || 0) + area.top + area.height / 2);
    }, [screenToCanvas, size.height, size.width]);

    useEffect(() => { setImageDownload(null); }, [projectId]);

    useEffect(() => {
        if (maskEditNodeId) setMaskEditModel(effectiveConfig.imageModel || effectiveConfig.model);
    }, [effectiveConfig.imageModel, effectiveConfig.model, maskEditNodeId]);

    const handleMissingModelConfig = useCallback(() => {
        if (canManageConfig) {
            openConfigDialog(true);
            return;
        }
        message.warning(uiText("当前没有可用模型，请联系管理员统一配置模型和 API"));
    }, [canManageConfig, message, openConfigDialog]);

    const batchEdit = useCanvasBatchEdit({ projectId, generationDispatchLocksRef, getCanvasCenter, handleMissingModelConfig, isAiConfigReady });
    const {
        batchEditOpen, setBatchEditOpen, batchEditPrompt, setBatchEditPrompt, batchOptimizePrompt, setBatchOptimizePrompt,
        batchOptimizing, batchImageSettings, setBatchImageSettings, batchEditItems, setBatchEditItems,
        batchEditRunning, batchEditServerId, batchEditAction, applyBatchEditFiles, handleBatchFolderInputChange, runBatchImageEdit, controlActiveBatchEdit,
    } = batchEdit;

    const quickGeneration = useCanvasQuickGeneration({
        projectId, projectLoaded, nodesRef, runtime: generationRuntime, batchEdit, setDialogNodeId,
        getCanvasCenter, handleMissingModelConfig, isAiConfigReady,
    });
    const {
        quickGenerateOpen, setQuickGenerateOpen, quickGeneratePromptRef, quickGeneratePromptRevision,
        setQuickGeneratePrompt, quickGeneratePosition, setQuickGeneratePosition, quickGenerateModel,
        setQuickGenerateModel, quickGenerateSize, setQuickGenerateSize, quickGenerateQuality,
        setQuickGenerateQuality, quickGenerateCount, setQuickGenerateCount, quickGenerateImageOptions,
        setQuickGenerateImageOptions, quickGenerateReferences, setQuickGenerateReferences, quickGenerateRunning,
        quickGenerateEstimate, onQuickOptimizedPrompt, handleQuickReferenceInputChange,
        runQuickCanvasGeneration,
    } = quickGeneration;

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

    const notifyHistoryAction = useCallback((kind: "undo" | "redo", before: CanvasHistoryEntry, after: CanvasHistoryEntry) => {
        void import("@/lib/canvas/canvas-history-description").then(({ describeCanvasHistoryChange }) => {
            void message.info({ key: "canvas-history-action", content: uiText("已{value1}：{value2}", { value1: kind === "undo" ? "撤销" : "重做", value2: describeCanvasHistoryChange(before, after) }), duration: 2 });
        }).catch(() => { void message.info(uiText("已{value1}画布操作", { value1: kind === "undo" ? uiText("撤销") : uiText("重做") })); });
    }, [message]);
    const { flushPendingHistory, undoCanvas, redoCanvas } = useCanvasHistory(history, {
        current: { nodes, connections, groups, chatSessions, activeChatId, backgroundMode, showImageInfo },
        projectLoaded, createHistoryEntry, applyHistory,
        onHistoryAction: notifyHistoryAction,
    });

    const cleanupCanvasFiles = useCallback(
        (extra?: unknown) => {
            cleanupAssetImages({ extra, history: historyRef.current, lastHistory: lastHistoryRef.current });
        },
        [cleanupAssetImages],
    );

    const confirmStopGeneration = useCallback(
        (nodeId: string) => {
            modal.confirm({
                title: uiText("停止本页查询？"),
                content: uiText("已提交的服务端任务可能继续运行，停止查询不代表取消或退款。原任务信息会保留，可以稍后继续查询。"),
                okText: uiText("停止查询"),
                cancelText: uiText("继续等待"),
                okButtonProps: { danger: true },
                onOk: () => stopGenerationByRunningId(nodeId, true),
            });
        },
        [modal, stopGenerationByRunningId],
    );

    const stopNodeObservation = useCallback((nodeId: string) => {
        confirmStopGeneration(generationRequestsRef.current.get(nodeId)?.runningNodeId || nodeId);
    }, [confirmStopGeneration]);

    const resetHydratedEditor = useCallback(() => {
        agentUndoRecordRef.current = null;
        setCanUndoAgentOps(false);
        setCompareImageIds(null);
        setTemplateSourceId(undefined);
        setContextMenu(null);
        setManualEditNode(null);
        setImageExport(null);
        setRenameNode(null);
        setRenameGroup(null);
    }, []);
    useCanvasProjectHydration({
        projectId, projectLoaded, setProjectLoaded, nodesRef, history, runtime: generationRuntime, quickGeneration,
        scenario: { usePerformanceScenario, performanceFixtureSize, performanceScenarioIncludesImages },
        view: { setGroups, setChatSessions, setActiveChatId, setBackgroundMode, setShowImageInfo, setViewport },
        resetEditor: resetHydratedEditor,
    });

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
        },
        [],
    );

    const savedProjectIdRef = useCanvasPersistence({
        projectId, projectLoaded, usePerformanceScenario, projectSaveQueueRef, history, updateProject,
        current: { nodes, connections, groups, chatSessions, activeChatId, backgroundMode, showImageInfo },
        batchEditRunning, runningNodeId, viewport, selectedNodeIds,
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
    }, [nodes, connections, groups, selectedNodeIds, viewport]);

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
            if (!performanceActiveRef.current) {
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
            if (performanceActiveRef.current) {
                performanceActiveRef.current = false;
                if (performanceFrameRef.current) cancelAnimationFrame(performanceFrameRef.current);
                performanceFrameRef.current = null;
                const metrics = performanceTrackerRef.current.finish(performance.now(), performanceCountsRef.current);
                void loadExperienceMetrics().then(experience => experience.recordCanvasInteraction(metrics)).catch(() => undefined);
                if (performanceModeEnabled) setPerformanceMetrics(metrics);
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

    const {
        connectingParams, connectionTargetNodeId, pendingConnectionCreate,
        pendingConnectionCreateRef, activeConnectionPathRef, setConnecting,
        createConnectedNode, cancelPendingConnectionCreate, findConnectionAtClientPoint,
        handleConnectionPointerDown, moveConnection, finishConnection,
        deleteConnection, handleConnectStart,
    } = useCanvasConnections({
        nodesRef, connectionsRef, viewportRef, generationDispatchLocksRef, screenToCanvas,
        setDialogNodeId, setContextMenu, flushPendingHistory,
        geometry: { nodeById, visibleConnections, canvasSpatialIndex, batchRootsById, hiddenGroupNodeIds, resolveRenderNode },
    });

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
    const selectedExportImageCount = useMemo(() => canvasImageExportSelection(nodes, Array.from(selectedNodeIds)).length, [nodes, selectedNodeIds]);

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
        () => ({ projectId, title: projectTitle || "未命名画布", nodes, connections, selectedNodeIds: Array.from(selectedNodeIds), viewport, viewportSize: size, previewNodeId, hiddenNodeIds: [...hiddenGroupNodeIds] }),
        [connections, projectTitle, hiddenGroupNodeIds, nodes, projectId, selectedNodeIds, viewport, size, previewNodeId],
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
    const currentAgentSnapshot = useCallback((): CanvasAgentSnapshot => ({ projectId, title: projectTitle || "未命名画布", nodes: nodesRef.current, connections: connectionsRef.current, selectedNodeIds: Array.from(selectedNodeIdsRef.current), viewport: viewportRef.current }), [projectTitle, projectId]);
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
            if (edits.some(op => op.type === "delete_node")) {
                const retained = new Set(next.nodes.map(node => node.id));
                const deleted = new Set(before.nodes.filter(node => !retained.has(node.id)).map(node => node.id));
                canvasGenerationRunsForNodes(deleted, generationRequestsRef.current.values(), before.connections).forEach(id => stopGenerationByRunningId(id, true));
            }
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
        [commitAgentSnapshot, currentAgentSnapshot, stopGenerationByRunningId],
    );
    const undoAgentOps = useCallback(async () => {
        const record = agentUndoRecordRef.current;
        if (!record) return null;
        const action = await import("@/lib/canvas/canvas-agent-undo-action").catch(() => {
            if (agentUndoRecordRef.current === record) message.error(uiText("加载失败，请重试"));
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
        (ids: Set<string>, confirmed = false): void => {
            if (!ids.size) return;
            const allIds = new Set(ids);
            nodesRef.current.forEach((node) => {
                if (ids.has(node.id)) node.metadata?.batchChildIds?.forEach((childId) => allIds.add(childId));
            });
            const stoppedRuns = canvasGenerationRunsForNodes(allIds, generationRequestsRef.current.values(), connectionsRef.current);
            if (!confirmed && (stoppedRuns.size || nodesRef.current.some(node => allIds.has(node.id) && (node.metadata?.status === NODE_STATUS_LOADING || node.metadata?.imageTask || node.metadata?.mediaTask)))) {
                modal.confirm({ title: uiText("删除生成中的节点？"), content: uiText("这会删除节点并停止相关本地查询；已提交的服务端任务可能继续，不代表取消或退款。可撤销删除后查询原任务。"), okText: uiText("删除节点"), cancelText: uiText("保留节点"), okButtonProps: { danger: true }, onOk: () => deleteNodes(allIds, true) });
                return;
            }
            flushPendingHistory();
            const deletionBase = lastHistoryRef.current;
            stoppedRuns.forEach(id => stopGenerationByRunningId(id, true));
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
            message.info({ key: "canvas-delete-undo", duration: 5, content: <span>{uiText("已删除 {value1} 个节点", { value1: allIds.size })} · <button type="button" className="underline" onClick={() => {
                flushPendingHistory();
                if (historyRef.current.past.at(-1)?.nodes === deletionBase?.nodes) undoCanvas();
                else message.info(uiText("删除后已有其他操作，请使用撤销逐步恢复"));
                message.destroy("canvas-delete-undo");
            }}>{uiText("撤销")}</button></span> });
        },
        [chatSessions, cleanupCanvasFiles, flushPendingHistory, message, modal, projectId, stopGenerationByRunningId, undoCanvas],
    );

    const createSelectedGroup = useCallback(() => {
        if (!localToolsEnabled) return;
        const memberIds = canvasGroupMemberIds(selectedNodeIdsRef.current, nodeById);
        if (memberIds.size < 2) { message.info(uiText("请先框选至少两个节点，再创建款式组")); return; }
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

        const center = pastePositionRef.current || getCanvasCenter();
        pastePositionRef.current = null;
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
        const next = fitCanvasNodes(nodesRef.current, canvasUsableArea(containerRef.current, size));
        wirelessCanvasRef.current?.previewViewport(next);
        viewportRef.current = next;
        setViewport(next);
        setContextMenu(null);
    }, [size.height, size.width]);

    const toggleMiniMap = useCallback(() => setIsMiniMapOpen((value) => !value), []);

    const focusCanvasArea = useCallback(
        (position: Position, width: number, height: number) => {
            const current = viewportRef.current;
            const area = canvasUsableArea(containerRef.current, size);
            setViewport({
                x: area.left + area.width / 2 - (position.x + width / 2) * current.k,
                y: area.top + area.height / 2 - (position.y + height / 2) * current.k,
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
        const state = useCanvasStore.getState();
        const id = createProject(nextProjectTitle(canvasLibrarySummaries(state.projects, state.unloadedProjects)));
        navigate(`/canvas/${id}`);
    }, [createProject, navigate]);

    const deleteCurrentProject = useCallback(() => {
        modal.confirm({
            title: uiText("删除整个画布？"),
            content: uiText("这会删除当前画布中的所有图片、节点和连线，并返回画布列表。删除单张图片请使用图片工具条中的“删除”。"),
            okText: uiText("删除整个画布"),
            cancelText: uiText("取消"),
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

            moveConnection(event.clientX, event.clientY);
        },
        [applyLiveDragPreview, canvasConnectionFallback, finishNodeDrag, moveConnection],
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

            flushSelectionPointer();
            selectionBoxRef.current = null;
            selectionOverlayRef.current?.hide();
            setIsSelecting(false);

            finishConnection(event.clientX, event.clientY);
        },
        [finishNodeDrag, finishConnection, flushSelectionPointer],
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

    const {
        createImageReversePromptNodes, saveManualImageEdit, cropImageNode, splitImageNode,
        maskEditImageNode, upscaleImageNode, generateAngleNode, runLocalImageOperation,
    } = useCanvasImageActions({
        projectId, nodesRef, designProjectIdRef, savedProjectIdRef, projectSaveQueueRef, runtime: generationRuntime,
        dialogs: canvasDialogs, setDialogNodeId, setContextMenu, handleMissingModelConfig, isAiConfigReady,
    });

    const createImageFileNode = useCallback(async (file: File, position: Position, signal?: AbortSignal, preserveQuickGeneratePrompt = false, openPanel = true) => {
        signal?.throwIfAborted();
        assertCanvasImageUploadSize(file);
        const ownerId = useUserStore.getState().user?.id;
        const image = await uploadImage(file);
        signal?.throwIfAborted();
        if (designProjectIdRef.current !== projectId || useUserStore.getState().user?.id !== ownerId) throw new Error(uiText("画布或账号已切换，已停止导入"));
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
        if (openPanel) setDialogNodeId(id);
    }, [flushPendingHistory, projectId]);

    const createVideoFileNode = useCallback(async (file: File, position: Position, openPanel = true) => {
        const ownerId = useUserStore.getState().user?.id;
        const video = await uploadMediaFile(file, "video");
        if (designProjectIdRef.current !== projectId || useUserStore.getState().user?.id !== ownerId) throw new Error(uiText("画布或账号已切换，已停止导入"));
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
        if (openPanel) setDialogNodeId(id);
    }, [flushPendingHistory, projectId]);

    const createAudioFileNode = useCallback(async (file: File, position: Position) => {
        const ownerId = useUserStore.getState().user?.id;
        const audio = await uploadMediaFile(file, "audio");
        if (designProjectIdRef.current !== projectId || useUserStore.getState().user?.id !== ownerId) throw new Error(uiText("画布或账号已切换，已停止导入"));
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
    }, [flushPendingHistory, projectId]);

    const importFiles = useCallback(async (files: File[], origin: Position) => {
        if (importLockRef.current) { message.info(uiText("正在导入素材，请稍候")); return; }
        importLockRef.current = true;
        const key = `canvas-import-${nanoid()}`;
        let failed = 0;
        const ownerId = useUserStore.getState().user?.id;
        try {
            for (const [index, file] of files.entries()) {
                if (designProjectIdRef.current !== projectId || useUserStore.getState().user?.id !== ownerId) break;
                const position = canvasImportGridPosition(origin, index, files.length);
                setImportPlaceholder({ position, name: file.name, completed: index, total: files.length });
                message.open({ key, type: "loading", duration: 0, content: uiText("正在导入 {value1}/{value2} 个文件…", { value1: index, value2: files.length }) });
                try {
                    await (isAudioFile(file) ? createAudioFileNode(file, position) : file.type.startsWith("video/") ? createVideoFileNode(file, position, files.length === 1) : createImageFileNode(file, position, undefined, true, files.length === 1));
                } catch (error) { failed++; message.error(`${file.name}：${error instanceof Error ? error.message : uiText("素材导入失败")}`); }
            }
            if (designProjectIdRef.current === projectId && useUserStore.getState().user?.id === ownerId) message.open({ key, type: failed ? "warning" : "success", duration: 4, content: uiText("导入完成：成功 {value1} 个{value2}", { value1: files.length - failed, value2: failed ? uiText("，失败 {count} 个", { count: failed }) : "" }) });
            else message.destroy(key);
        } finally { importLockRef.current = false; setImportPlaceholder(null); }
    }, [createAudioFileNode, createImageFileNode, createVideoFileNode, message, projectId]);

    const createTextNodeFromClipboard = useCallback(
        (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return false;

            const node = {
                ...createCanvasNode(CanvasNodeType.Text, pastePositionRef.current || getCanvasCenter(), { content: trimmed, status: NODE_STATUS_SUCCESS }),
                title: trimmed.slice(0, 32) || "剪切板文本",
            };

            pastePositionRef.current = null;
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
        const center = pastePositionRef.current || getCanvasCenter();
        pastePositionRef.current = null;
        await runLocalImageOperation(`clipboard-paste:${nanoid()}`, "粘贴", async (signal) => {
            files.forEach(assertCanvasImageUploadSize);
            for (const [index, file] of files.entries()) {
                await createImageFileNode(file, canvasImportGridPosition(center, index, files.length), signal, true, files.length === 1);
            }
            message.success(files.length === 1 ? uiText("已从剪切板添加图片") : uiText("已从剪切板添加 {value1} 张图片", { value1: files.length }));
        });
    }, [createImageFileNode, getCanvasCenter, message, runLocalImageOperation]);

    const handleDrop = useCanvasClipboardDrop({
        scopeKey: projectId,
        onReadingChange: setDropReading,
        copyNodes: copySelectedNodes,
        getCutSnapshot: () => ({
            nodes: nodesRef.current, connections: connectionsRef.current, selectedIds: selectedNodeIdsRef.current,
            requests: [...generationRequestsRef.current.values()], dispatchLocks: [...generationDispatchLocksRef.current],
        }),
        cutNodes: () => deleteNodes(new Set(selectedNodeIdsRef.current)),
        pasteNodes: pasteCopiedNodes, pasteImages: pasteSystemClipboard, pasteText: createTextNodeFromClipboard,
        screenToCanvas, importFiles,
        warning: text => message.warning(text), error: text => message.error(text),
    });

    useCanvasShortcuts({
        resetView: resetViewport,
        fitSelection: () => {
            const selected = nodesRef.current.filter(node => selectedNodeIdsRef.current.has(node.id));
            if (!selected.length) { message.info(uiText("请先选择节点")); return; }
            const next = fitCanvasNodes(selected, canvasUsableArea(containerRef.current, size));
            wirelessCanvasRef.current?.previewViewport(next); viewportRef.current = next; setViewport(next);
        },
        zoomIn: () => setZoomScale(viewportRef.current.k * 1.25),
        zoomOut: () => setZoomScale(viewportRef.current.k / 1.25),
        zoomActual: () => setZoomScale(1),
        commands: openCommands,
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
            cancelSelectionPreview(); cancelPendingConnectionCreate(); setHoveredNodeId(null); setToolbarNodeId(null);
            setDialogNodeId(null); setEditingNodeId(null); setInfoNodeId(null); setCropNodeId(null);
            setMaskEditNodeId(null);
        },
    });

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
            const { downloadCanvasContent, loadCanvasImageVariants } = await loadCanvasExport();
            if (node.type === CanvasNodeType.Image) {
                const variants = await loadCanvasImageVariants(node);
                const current = nodesRef.current.find(item => item.id === node.id);
                if (savedProjectIdRef.current !== projectId || !current || current.metadata?.content !== node.metadata.content || current.metadata?.storageKey !== node.metadata.storageKey) return;
                setImageDownload({ projectId, node: current, variants });
            }
            else downloadCanvasContent(node.metadata.content, `canvas-${node.type}-${node.id}.${node.type === CanvasNodeType.Video ? "mp4" : audioExtension(node.metadata.mimeType)}`);
        } catch (error) { message.error(error instanceof Error ? error.message : uiText("图片下载失败")); }
    }, [message, projectId]);

    const saveNodeAsset = useCallback(
        async (node: CanvasNodeData) => {
            const ownerId = useUserStore.getState().user?.id;
            const isCurrent = () => designProjectIdRef.current === projectId && useUserStore.getState().user?.id === ownerId;
            try {
                const { createCanvasNodeAsset } = await import("@/lib/canvas/canvas-node-asset");
                if (!isCurrent()) return;
                addAsset(createCanvasNodeAsset(node, projectId));
                message.success(uiText("已加入我的素材"));
            } catch (error) {
                if (isCurrent()) message.error(error instanceof Error ? error.message : uiText("素材保存失败，请重试"));
            }
        },
        [addAsset, message, projectId],
    );

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
        if (sourceId && !source) { message.warning(t("参考图已移除，请重新选择")); return; }
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
        message.success(t("已添加 3 个生成配置；编辑提示词后逐个点击生成，当前未调用模型"));
    };

    const arrangeNodes = async (mode: import("@/lib/canvas/canvas-node-arrange").CanvasArrangeMode) => {
        if (!localToolsEnabled) return;
        const { arrangeCanvasNodes } = await import("@/lib/canvas/canvas-node-arrange");
        if (designProjectIdRef.current !== projectId) return;
        const next = arrangeCanvasNodes(nodesRef.current, groupsRef.current, selectedNodeIdsRef.current, mode);
        if (next === nodesRef.current) { message.info(t("至少需要两个可移动单元；同一款式组视为一个整体")); return; }
        setNodes(next);
        message.success(t("排版已更新，款式组内相对位置保留，可撤销"));
    };

    const handleFontSizeChange = useCallback((nodeId: string, fontSize: number) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, fontSize } } : node)));
    }, []);

    const handleUploadRequest = useCallback((nodeId?: string, position?: Position) => {
        uploadTargetRef.current = { nodeId, position };
        if (imageInputRef.current) imageInputRef.current.multiple = !nodeId;
        imageInputRef.current?.click();
    }, []);

    const handleImageInputChange = useCallback(
        async (event: ReactChangeEvent<HTMLInputElement>) => {
            const selectedFiles = Array.from(event.target.files || []);
            const target = uploadTargetRef.current;
            uploadTargetRef.current = null;
            event.target.value = "";
            const files = selectedFiles.filter(file => file.type.startsWith("image/") || file.type.startsWith("video/") || isAudioFile(file));
            if (files.length !== selectedFiles.length) message.warning(uiText("仅支持图片、视频和音频，其他文件已跳过"));
            const file = files[0];
            if (!file) return;
            if (!target?.nodeId) { await importFiles(files, target?.position || getCanvasCenter()); return; }
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
                message.error(error instanceof Error ? error.message : uiText("素材导入失败，请重试"));
            }
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode, flushPendingHistory, message, screenToCanvas, size.height, size.width, importFiles, getCanvasCenter],
    );

    const pasteAssistantImage = useCallback(
        (file: File) => {
            const position = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            void runLocalImageOperation("assistant-clipboard-paste", "粘贴", async (signal) => {
                await createImageFileNode(file, position, signal);
                message.success(uiText("已从剪切板添加图片"));
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
        setTitleDraft(projectTitle || "未命名画布");
        setTitleEditing(true);
    }, [projectTitle]);

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

    const { handleGenerateNode, handleRetryNode, generateImageFromTextNode, restoreNodeGenerationInput } = useCanvasGeneration({
        projectId, nodesRef, connectionsRef, designProjectIdRef, projectSaveQueueRef, runtime: generationRuntime,
        setDialogNodeId, focusCanvasArea, handleMissingModelConfig, isAiConfigReady,
    });
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

    const { handleMediaWorkflowAction } = useCanvasMediaWorkflow({
        projectId, nodesRef, chatSessions, setChatSessions, applyAgentOps, handleGenerateNode, focusCanvasArea,
    });

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
    const contextMenuImageCount = useMemo(() => canvasImageExportSelection(nodes, Array.from(contextMenuNodeIds)).length, [nodes, contextMenuNodeIds]);

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
                message.error(error instanceof Error ? error.message : uiText("素材读取失败，请重试"));
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
        projectSaveQueueRef.current?.flush();
        const stored = useCanvasStore.getState().projects.find(project => project.id === projectId);
        if (!stored) return;
        const latest = { ...stored, nodes: nodesRef.current, connections: connectionsRef.current, groups: groupsRef.current, viewport: viewportRef.current, selectedNodeIds: normalizeCanvasSelectedNodeIds(selectedNodeIdsRef.current, nodesRef.current, groupsRef.current) };
        await exportProjects([latest.id], latest.title || t("无限画布"), [latest]);
    }, [projectId, exportProjects, t]);

    const openImageExport = useCallback(() => {
        setImageExport({ nodes: nodesRef.current, ids: Array.from(selectedNodeIdsRef.current) });
    }, []);
    const openSelectedImageDownload = useCallback(() => {
        const selectedImages = canvasImageExportSelection(nodesRef.current, Array.from(selectedNodeIdsRef.current));
        if (!selectedImages.length) return;
        // Snapshot only the selection: an empty or mixed selection must never fall back to all images.
        setImageExport({ nodes: selectedImages, ids: selectedImages.map(node => node.id), mode: "images" });
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

    const startNodeRename = (nodeId: string | undefined) => {
        const node = nodesRef.current.find(item => item.id === nodeId);
        if (node) setRenameNode({ id: node.id, name: node.type === CanvasNodeType.Image ? canvasImageBaseName(node) : node.title });
        setContextMenu(null);
    };

    const shareCurrentCanvas = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(window.location.href);
            message.success(uiText(canvasLinkCopiedMessage[deploymentFeatures.authenticationEnabled ? "cloud" : "local"]));
        } catch {
            message.warning(uiText("无法复制链接，请从地址栏复制"));
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

    const locateNodes = useCallback((ids: string[]) => {
        const matches = nodesRef.current.filter(node => ids.includes(node.id));
        if (!matches.length) return;
        commitSelectedNodeIds(new Set(matches.map(node => node.id)));
        const left = Math.min(...matches.map(node => node.position.x));
        const top = Math.min(...matches.map(node => node.position.y));
        focusCanvasArea({ x: left, y: top }, Math.max(...matches.map(node => node.position.x + node.width)) - left, Math.max(...matches.map(node => node.position.y + node.height)) - top);
    }, [commitSelectedNodeIds, focusCanvasArea]);
    const focusNodeByKeyboard = useCallback((id: string) => {
        if (!selectedNodeIdsRef.current.has(id)) commitSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
    }, [commitSelectedNodeIds]);
    const taskHighlights = useMemo(() => new Set(taskHighlightIds), [taskHighlightIds]);
    const actOnNodeByKeyboard = useCallback((id: string, action: { x: number; y: number } | "edit", repeat: boolean) => {
        const node = nodesRef.current.find(item => item.id === id);
        if (!node) return;
        if (action === "edit") { if (!repeat) { if (node.type === CanvasNodeType.Text) openTextEditor(node); else editNodeFromToolbar(node); } return; }
        if (!repeat) flushPendingHistory();
        const ids = selectedNodeIdsRef.current.has(id) ? selectedNodeIdsRef.current : new Set([id]);
        setNodes(current => current.map(item => ids.has(item.id) ? { ...item, position: { x: item.position.x + action.x, y: item.position.y + action.y } } : item));
    }, [editNodeFromToolbar, flushPendingHistory, openTextEditor]);
    const openExampleCanvas = useCallback(async () => {
        const { createCanvasExampleProject } = await import("@/lib/canvas/canvas-example-graph");
        navigate(`/canvas/${createCanvasExampleProject()}`);
    }, [navigate]);
    const commandBindings: CanvasCommandBindings = {
        upload: { run: uploadFromToolbar }, text: { run: addTextNodeFromToolbar }, image: { run: addImageNodeFromToolbar },
        video: { run: addVideoNodeFromToolbar }, audio: { run: addAudioNodeFromToolbar }, config: { run: addConfigNodeFromToolbar },
        generate: { run: openQuickGenerateFromToolbar }, batch: { run: openBatchEditFromToolbar },
        undo: { run: undoCanvas, enabled: historyState.canUndo }, redo: { run: redoCanvas, enabled: historyState.canRedo },
        duplicate: { run: () => duplicateNodes(new Set(selectedNodeIdsRef.current)), enabled: selectedNodeIds.size > 0 },
        delete: { run: deleteSelectedNodesFromToolbar, enabled: selectedNodeIds.size > 0 },
        group: { run: createSelectedGroup, enabled: localToolsEnabled && selectedNodeIds.size >= 2 },
        selectAll: { run: () => commitSelectedNodeIds(new Set(nodesRef.current.map(node => node.id))), enabled: nodes.length > 0 },
        assets: { run: openAssetsFromToolbar }, designTemplate: { run: () => setTemplateSourceId(null) },
        compare: { run: () => openImageCompare(), enabled: nodes.some(node => node.type === CanvasNodeType.Image && Boolean(node.metadata?.content)) },
        resetView: { run: resetViewport }, minimap: { run: toggleMiniMap }, export: { run: () => void exportCurrentCanvas() },
        tools: { run: openWorkspaceTools }, guide: { run: () => onboardingRef.current?.start() },
        clear: { run: openClearCanvasFromToolbar }, exportImages: { run: openImageExport },
        downloadSelectedImages: { run: openSelectedImageDownload, enabled: selectedExportImageCount > 0 },
        select: { run: () => setInteractionMode("select") }, pan: { run: () => { deselectCanvas(); setInteractionMode("hand"); } },
        backgroundDots: { run: () => setBackgroundMode("dots") }, backgroundLines: { run: () => setBackgroundMode("lines") }, backgroundBlank: { run: () => setBackgroundMode("blank") },
        imageInfo: { run: () => setShowImageInfo(value => !value) },
        newProject: { run: createAndOpenProject },
        deleteProject: { run: deleteCurrentProject }, renameProject: { run: startTitleEditing }, share: { run: shareFromTopBar },
        rename: { enabled: selectedNodeIds.size === 1, run: () => startNodeRename(selectedNodeIdsRef.current.values().next().value) },
    };

    if (!projectLoaded) return <CanvasRefreshShell />;

    const quickGeneratePanel = (
<Suspense fallback={isCanvasDesktopLayout ? <div className="cw-panel-loading">{t("正在加载编辑区…")}</div> : null}>
                    <CanvasQuickGeneratePanel
                        onOptimizedPrompt={onQuickOptimizedPrompt}
                        embedded={isCanvasDesktopLayout}
                        open={quickGenerateOpen && !assistantOpen}
                        promptRef={quickGeneratePromptRef}
                        promptRevision={quickGeneratePromptRevision}
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
                        remainingCredits={remainingCredits}
                        config={effectiveConfig}
                        onClose={closeQuickGeneratePanel}
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
                <div className="cw-tabs" role="tablist" aria-label={t("创作模式")}>
                    <button role="tab" aria-selected={!assistantOpen} type="button" onClick={openQuickGenerateFromToolbar}>{t("创建")}</button>
                    <button role="tab" aria-selected={assistantOpen} type="button" onClick={toggleAgentFromTopBar}>{t("对话")}</button>
                    <div className="cw-tabs-actions">{quickGenerateOpen ? <Suspense fallback={null}><CanvasPanelSizeControl kind="create" /></Suspense> : null}<button type="button" className="cw-icon" aria-label={quickGenerateOpen ? t("收起创建面板") : t("展开创建面板")} aria-expanded={quickGenerateOpen} onClick={quickGenerateOpen ? closeQuickGeneratePanel : openQuickGenerateFromToolbar}><ChevronDown size={18} className={quickGenerateOpen ? "rotate-180" : undefined} /></button></div>
                </div>
                {isCanvasDesktopLayout ? quickGeneratePanel : null}
                {isCanvasDesktopLayout && quickGenerateOpen && !assistantOpen ? <Suspense fallback={null}><CanvasPanelResizeHandle kind="create" /></Suspense> : null}
            </aside>
            <section className="relative min-w-0 flex-1 overflow-hidden" onDragOverCapture={event => { if (isExternalImageDrag(event.dataTransfer)) { event.preventDefault(); setDropActive(true); } }} onDragLeaveCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false); }} onDropCapture={() => setDropActive(false)} onDrop={handleDrop}>
                {dropActive || dropReading ? <div data-testid="canvas-drop-overlay" className="pointer-events-none absolute inset-4 z-[120] flex items-center justify-center rounded-xl border-2 border-dashed text-lg font-medium" style={{ background: theme.toolbar.panel, borderColor: theme.canvas.selectionStroke, color: theme.node.text }}>{t(dropReading ? "正在读取拖入图片，请稍候。" : "松开以导入图片、视频或音频")}</div> : null}
                <CanvasTopBar
                    title={projectTitle || t("未命名画布")}
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
                    onOpenCommands={openCommands}
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
                            onKeyboardFocus: focusNodeByKeyboard, onKeyboardAction: actOnNodeByKeyboard,
                            taskHighlighted: taskHighlights.has(node.id),
                            maxInlinePanelWidth: Math.max(160, (window.innerWidth / 2 - 24) / viewport.k),
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
                            onStopObservation: generationRequestsRef.current.has(node.id) || runningNodeId === node.id ? stopNodeObservation : undefined,
                            onContextMenu: handleNodeContextMenu,
                        })} />

                    {localToolsEnabled && !isNodeDragging && !isNodeResizing && !isSelecting && !connectingParams && singleSelectedNode?.type === CanvasNodeType.Image && renderedNodes.some(node => node.id === singleSelectedNode.id) ? <Suspense fallback={null}><CanvasInlineImageCompare key={singleSelectedNode.id} node={singleSelectedNode} nodes={nodes} scale={viewport.k} showImageInfo={showImageInfo} onAdvanced={sourceId => sourceId ? setCompareImageIds([sourceId, singleSelectedNode.id]) : openImageCompare(singleSelectedNode)} /></Suspense> : null}
                    <CanvasSelectionOverlay ref={selectionOverlayRef} borderColor={theme.canvas.selectionStroke} background={theme.canvas.selectionFill} />
                    {importPlaceholder ? <div role="status" className="pointer-events-none absolute flex h-40 w-80 flex-col items-center justify-center gap-3 rounded-xl border p-4 text-center text-sm" style={{ left: importPlaceholder.position.x - 160, top: importPlaceholder.position.y - 80, background: theme.node.panel, borderColor: theme.canvas.selectionStroke, color: theme.node.text }}><span className="max-w-full truncate">{importPlaceholder.name}</span><span>{t("正在导入 {value1}/{value2} 个文件…", { value1: importPlaceholder.completed, value2: importPlaceholder.total })}</span><progress max={importPlaceholder.total} value={importPlaceholder.completed} /></div> : null}
                    {pendingConnectionCreate ? <Suspense fallback={null}><ConnectionCreateMenu pending={pendingConnectionCreate} onCreate={(type) => createConnectedNode(type, pendingConnectionCreate)} onClose={cancelPendingConnectionCreate} /></Suspense> : null}
                </WirelessCanvas>
                <Suspense fallback={null}><CanvasOnboarding ref={onboardingRef} empty={nodes.length === 0} onImportImage={uploadFromToolbar} onUseTemplate={() => setTemplateSourceId(null)} onOpenExample={() => void openExampleCanvas()} onOpenCreation={openQuickGenerateFromToolbar} onCloseCreation={closeQuickGeneratePanel} onDrop={handleDrop} /></Suspense>
                <div className="cw-feedback-strip"><Suspense fallback={null}><CanvasTaskFeedbackRuntime projectId={projectId} enabled={projectLoaded} nodes={nodes} connections={connections} onLocate={locateNodes} onHighlightChange={setTaskHighlightIds} /></Suspense></div>
                <Suspense fallback={null}><CanvasSaveFailureNotice onExport={exportCurrentCanvas} /></Suspense>
                <Suspense fallback={null}><CanvasConflictNotice projectId={projectId} /></Suspense>
                {commandsOpen ? <Suspense fallback={null}><CanvasCommandPalette nodes={nodes} bindings={commandBindings} onLocate={locateNodes} onAsset={handleAssetInsert} onClose={() => setCommandsOpen(false)} /></Suspense> : null}
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
                            onManualEdit={(node) => { if (node.metadata?.status === "loading") { message.info(t("请等待这张图片生成完成后再编辑")); return; } setDialogNodeId(null); setManualEditNode(node); }}
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
                    selectedImageCount={selectedExportImageCount}
                    onDownloadSelection={openSelectedImageDownload}
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
                        imageCount={contextMenuImageCount}
                        onDownloadImages={openSelectedImageDownload}
                        onGroup={localToolsEnabled && selectedNodeIds.size >= 2 && (contextMenu.type === "canvas" || (contextMenu.type === "node" && selectedNodeIds.has(contextMenu.nodeId))) ? createSelectedGroup : undefined}
                        onClose={() => setContextMenu(null)}
                        onUpload={contextMenu.type === "canvas" ? () => handleUploadRequest(undefined, contextMenu.canvasPosition) : undefined}
                        onPaste={contextMenu.type === "canvas" ? () => {
                            pastePositionRef.current = contextMenu.canvasPosition;
                            message.info(uiText("请按 Ctrl / Cmd + V，剪贴板内容会粘贴到此处"));
                        } : undefined}
                        onAddText={contextMenu.type === "canvas" ? () => createNode(CanvasNodeType.Text, contextMenu.canvasPosition) : undefined}
                        onSelectAll={() => { commitSelectedNodeIds(new Set(nodesRef.current.map(node => node.id))); setSelectedConnectionId(null); }}
                        onFitAll={resetViewport}
                        onBringFront={() => { flushPendingHistory(); setNodes(current => [...current.filter(node => !contextMenuNodeIds.has(node.id)), ...current.filter(node => contextMenuNodeIds.has(node.id))]); }}
                        onSendBack={() => { flushPendingHistory(); setNodes(current => [...current.filter(node => contextMenuNodeIds.has(node.id)), ...current.filter(node => !contextMenuNodeIds.has(node.id))]); }}
                        onCopyPrompt={contextMenu.type === "node" && nodes.some(node => contextMenuNodeIds.has(node.id) && (node.metadata?.prompt || node.metadata?.draftPrompt)) ? () => {
                            void copyText(nodes.filter(node => contextMenuNodeIds.has(node.id)).map(node => node.metadata?.draftPrompt || node.metadata?.prompt || "").filter(Boolean).join("\n\n"), uiText("提示词已复制"));
                        } : undefined}
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
                            startNodeRename(contextMenu.nodeId);
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

                <input ref={imageInputRef} type="file" multiple accept="image/*,video/*,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" className="hidden" onChange={handleImageInputChange} />
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
                {canvasDialogs.isOpen ? <Suspense fallback={null}><CanvasDialogsHost projectId={projectId} state={canvasDialogs} actions={{
                    applyDesignTemplate, saveGroupName, saveNodeName, saveManualImageEdit, cropImageNode, maskEditImageNode,
                    splitImageNode, upscaleImageNode, generateAngleNode, clearCanvas, handleAssetInsert,
                }} /></Suspense> : null}
            {batchEditOpen ? <Suspense fallback={null}><CanvasBatchEditDialog open={batchEditOpen} running={batchEditRunning} prompt={batchEditPrompt} optimizePrompt={batchOptimizePrompt} optimizing={batchOptimizing} onOptimizePromptChange={setBatchOptimizePrompt} items={batchEditItems} imageSettings={batchImageSettings} serverId={batchEditServerId} action={batchEditAction} onClose={() => setBatchEditOpen(false)} onPromptChange={setBatchEditPrompt} onImageSettingsChange={setBatchImageSettings} onSelectFiles={() => batchFilesInputRef.current?.click()} onClearItems={() => setBatchEditItems([])} onRun={runBatchImageEdit} onControlBatch={controlActiveBatchEdit} /></Suspense> : null}
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
    const t = useUiText();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    return (
        <aside aria-live="polite" className="flex w-[380px] shrink-0 items-center justify-center border-l text-sm" style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.muted }}>
            {t("正在加载 Agent…")}</aside>
    );
}

function CanvasNodePanelLoading() {
    const t = useUiText();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    return <div aria-live="polite" className="min-h-36 rounded-xl border p-4 text-sm shadow-lg" style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.muted }}>{t("正在加载编辑面板…")}</div>;
}
