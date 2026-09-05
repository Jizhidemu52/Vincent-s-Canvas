import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronRight, Image as ImageIcon, Music2, RefreshCw, Star, Video } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasRenderQuality } from "@/lib/canvas/canvas-render-quality";
import { canvasNodeRenderStateEqual, type CanvasNodeRenderState } from "@/lib/canvas/canvas-render-stability";
import { canvasMediaPlaybackProps } from "@/lib/canvas/canvas-media-render-quality";
import { canvasImageRenderProps } from "@/lib/canvas/canvas-image-render-quality";
import { needsCanvasNodeMediaPreviewResolution, resolveCanvasNodeMediaPreview } from "@/lib/canvas/canvas-node-media-preview";
import { canvasNodeRenderingStyle } from "@/lib/canvas/canvas-node-rendering";
import { canvasNodeResizePointerDelta } from "@/lib/canvas/canvas-node-resize";
import { shouldRenderCanvasNodeControls } from "@/lib/canvas/canvas-node-controls-visibility";
import { canvasNodeEffectiveHover } from "@/lib/canvas/canvas-node-hover-state";
import { shouldUseCanvasNodeMovingPlaceholder } from "@/lib/canvas/canvas-node-moving-content";
import { shouldShowCanvasTextStream } from "@/lib/canvas/canvas-text-stream-visibility";
import { createCanvasTextDraft } from "@/lib/canvas/canvas-text-draft";
import type { CanvasResizeBounds } from "@/lib/canvas/canvas-resize-preview";
import { formatBytes } from "@/lib/image-utils";
import { resolveImageUrl } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type CanvasConfigInputSummary = { textCount: number; imageCount: number; videoCount: number; audioCount: number };
const emptyConfigInputSummary: CanvasConfigInputSummary = { textCount: 0, imageCount: 0, videoCount: 0, audioCount: 0 };

type CanvasNodeProps = {
    data: CanvasNodeData;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    themeKey: string;
    renderQuality: CanvasRenderQuality;
    previewPosition?: Position;
    previewBounds?: CanvasResizeBounds;
    getCanvasScale: () => number;
    isSelected: boolean;
    isRelated: boolean;
    isFocusRelated: boolean;
    isConnectionTarget: boolean;
    isConnecting: boolean;
    isRunning: boolean;
    editRequestNonce?: number;
    showPanel: boolean;
    showImageInfo: boolean;
    configInputSummary?: CanvasConfigInputSummary;
    resourceLabel?: CanvasResourceReference;
    mentionReferences?: CanvasResourceReference[];
    renderPanel?: (node: CanvasNodeData) => ReactNode;
    renderNodeContent?: (node: CanvasNodeData, options: { inputSummary: CanvasConfigInputSummary; isRunning: boolean }) => ReactNode;
    batchCount?: number;
    batchExpanded?: boolean;
    batchClosing?: boolean;
    batchOpening?: boolean;
    batchRecovering?: boolean;
    batchMotion?: { x: number; y: number; index: number };
    onMouseDown: (event: React.MouseEvent, nodeId: string) => void;
    onHoverStart: (nodeId: string) => void;
    onHoverEnd: (nodeId: string) => void;
    onConnectStart: (event: React.MouseEvent, nodeId: string, handleType: "source" | "target") => void;
    onResize: (nodeId: string, width: number, height: number, position?: Position) => void;
    onResizeEnd: (nodeId: string, width: number, height: number, position: Position) => void;
    onContentChange: (nodeId: string, content: string) => void;
    onToggleBatch?: (nodeId: string) => void;
    onSetBatchPrimary?: (node: CanvasNodeData) => void;
    onRetry?: (node: CanvasNodeData) => void;
    onGenerateImage?: (node: CanvasNodeData) => void;
    onViewImage?: (node: CanvasNodeData) => void;
    onContextMenu: (event: React.MouseEvent, nodeId: string) => void;
};

type NodeContentRendererProps = {
    node: CanvasNodeData;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    renderQuality: CanvasRenderQuality;
    isEditingContent: boolean;
    textDraft: string;
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    isBatchRoot: boolean;
    batchCount: number;
    batchExpanded: boolean;
    batchOpening: boolean;
    batchRecovering: boolean;
    configInputSummary: CanvasConfigInputSummary;
    isRunning: boolean;
    renderNodeContent?: (node: CanvasNodeData, options: { inputSummary: CanvasConfigInputSummary; isRunning: boolean }) => ReactNode;
    onContentChange: (content: string) => void;
    onStopEditing: () => void;
    mentionReferences: CanvasResourceReference[];
    onRetry?: (node: CanvasNodeData) => void;
    onGenerateImage?: (node: CanvasNodeData) => void;
    onToggleBatch?: () => void;
    onSetBatchPrimary?: () => void;
};

export const CanvasNode = React.memo(function CanvasNode({
    data,
    theme,
    themeKey,
    renderQuality,
    previewPosition,
    previewBounds,
    getCanvasScale,
    isSelected,
    isRelated,
    isFocusRelated,
    isConnectionTarget,
    isConnecting,
    isRunning,
    editRequestNonce = 0,
    showPanel,
    showImageInfo,
    configInputSummary = emptyConfigInputSummary,
    resourceLabel,
    mentionReferences = [],
    renderPanel,
    renderNodeContent,
    batchCount = 0,
    batchExpanded = false,
    batchClosing = false,
    batchOpening = false,
    batchRecovering = false,
    batchMotion,
    onMouseDown,
    onHoverStart,
    onHoverEnd,
    onConnectStart,
    onResize,
    onResizeEnd,
    onContentChange,
    onToggleBatch,
    onSetBatchPrimary,
    onRetry,
    onGenerateImage,
    onViewImage,
    onContextMenu,
}: CanvasNodeProps) {
    const [hovered, setHovered] = useState(false);
    const [isEditingContent, setIsEditingContent] = useState(false);
    const [textDraft, setTextDraft] = useState(data.metadata?.content || "");
    const [localResizePreview, setLocalResizePreview] = useState<CanvasResizeBounds | null>(null);
    const hasImageContent = data.type === CanvasNodeType.Image && Boolean(data.metadata?.content);
    const hasVideoContent = data.type === CanvasNodeType.Video && Boolean(data.metadata?.content);
    const hasAudioContent = data.type === CanvasNodeType.Audio && Boolean(data.metadata?.content);
    const isBatchRoot = data.type === CanvasNodeType.Image && Boolean(data.metadata?.isBatchRoot) && batchCount > 1;
    const isBatchChild = data.type === CanvasNodeType.Image && Boolean(data.metadata?.batchRootId);
    const isActive = isConnectionTarget || isSelected || isFocusRelated;
    const isMoving = renderQuality === "moving";
    const effectiveHovered = canvasNodeEffectiveHover(hovered, renderQuality);
    const useOverview = renderQuality === "overview" && !isActive && !showPanel && !effectiveHovered;
    const useMovingPlaceholder = shouldUseCanvasNodeMovingPlaceholder({ type: data.type, renderQuality, active: isActive, hovered: effectiveHovered, showPanel });
    const showNodeControls = shouldRenderCanvasNodeControls({ renderQuality, hovered: effectiveHovered, selected: isSelected, connecting: isConnecting });
    const contentRenderQuality: CanvasRenderQuality = useOverview ? "overview" : renderQuality === "overview" ? "full" : renderQuality;
    const effectiveResizePreview = previewBounds ?? localResizePreview;
    const position = previewPosition ?? effectiveResizePreview?.position ?? data.position;
    const width = effectiveResizePreview?.width ?? data.width;
    const height = effectiveResizePreview?.height ?? data.height;
    const imageBorderColor = isActive ? theme.canvas.selectionStroke : isRelated && !isBatchChild ? theme.node.muted : "transparent";
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const textDraftRef = useRef<ReturnType<typeof createCanvasTextDraft> | null>(null);
    const resizePreviewFrameRef = useRef<number | null>(null);
    const pendingResizePreviewRef = useRef<CanvasResizeBounds | null>(null);
    if (!textDraftRef.current) textDraftRef.current = createCanvasTextDraft(data.metadata?.content || "", (content) => onContentChange(data.id, content));
    const resizeRef = useRef({
        isResizing: false,
        corner: "bottom-right" as ResizeCorner,
        startX: 0,
        startY: 0,
        startLeft: 0,
        startTop: 0,
        startWidth: 0,
        startHeight: 0,
        keepRatio: false,
        ratio: 1,
        currentWidth: 0,
        currentHeight: 0,
        currentPosition: { x: 0, y: 0 },
    });

    const beginTextEditing = useCallback(() => {
        const content = data.metadata?.content || "";
        textDraftRef.current?.reset(content);
        setTextDraft(content);
        setIsEditingContent(true);
    }, [data.metadata?.content]);

    const updateTextDraft = useCallback((content: string) => {
        textDraftRef.current?.change(content);
        setTextDraft(content);
    }, []);

    const finishTextEditing = useCallback(() => {
        textDraftRef.current?.flush();
        setIsEditingContent(false);
    }, []);

    useEffect(() => {
        if (isEditingContent) return;
        const content = data.metadata?.content || "";
        textDraftRef.current?.reset(content);
        // The displayed, non-editing node reads data.metadata.content directly.
        // Avoid a second component render for every streamed token; entering
        // edit mode always synchronizes textDraft from the latest content.
    }, [data.metadata?.content, isEditingContent]);

    useEffect(() => () => textDraftRef.current?.flush(), []);

    useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const handleWheel = (event: WheelEvent) => event.stopPropagation();
        textarea.addEventListener("wheel", handleWheel, { passive: false });
        return () => textarea.removeEventListener("wheel", handleWheel);
    }, [data.type, isEditingContent]);

    useEffect(() => {
        if (!isEditingContent) return;
        const textarea = textareaRef.current;
        textarea?.focus();
        textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    }, [isEditingContent]);

    useEffect(() => {
        if (!editRequestNonce || data.type !== CanvasNodeType.Text) return;
        beginTextEditing();
    }, [beginTextEditing, data.type, editRequestNonce]);

    useEffect(() => {
        if (!isEditingContent) return;

        const handleOutsidePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (isEditingContent && textareaRef.current?.contains(target)) return;

            finishTextEditing();
        };

        window.addEventListener("pointerdown", handleOutsidePointerDown, true);
        return () => window.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    }, [finishTextEditing, isEditingContent]);

    const handleResizeMove = useCallback(
        (event: MouseEvent) => {
            if (!resizeRef.current.isResizing) return;

            const { x: dx, y: dy } = canvasNodeResizePointerDelta({
                startX: resizeRef.current.startX,
                startY: resizeRef.current.startY,
                clientX: event.clientX,
                clientY: event.clientY,
                scale: getCanvasScale(),
            });
            const minWidth = 220;
            const minHeight = 160;
            const startRight = resizeRef.current.startLeft + resizeRef.current.startWidth;
            const startBottom = resizeRef.current.startTop + resizeRef.current.startHeight;
            const fromLeft = resizeRef.current.corner.includes("left");
            const fromTop = resizeRef.current.corner.includes("top");
            const rawWidth = Math.max(minWidth, resizeRef.current.startWidth + (fromLeft ? -dx : dx));
            const rawHeight = Math.max(minHeight, resizeRef.current.startHeight + (fromTop ? -dy : dy));
            let width = rawWidth;
            let height = rawHeight;
            if (resizeRef.current.keepRatio) {
                const ratio = resizeRef.current.ratio;
                if (Math.abs(dx) >= Math.abs(dy)) {
                    height = width / ratio;
                } else {
                    width = height * ratio;
                }
                if (height < minHeight) {
                    height = minHeight;
                    width = height * ratio;
                }
                if (width < minWidth) {
                    width = minWidth;
                    height = width / ratio;
                }
            }

            const position = {
                x: fromLeft ? startRight - width : resizeRef.current.startLeft,
                y: fromTop ? startBottom - height : resizeRef.current.startTop,
            };
            resizeRef.current.currentWidth = width;
            resizeRef.current.currentHeight = height;
            resizeRef.current.currentPosition = position;
            pendingResizePreviewRef.current = { position, width, height };
            if (resizePreviewFrameRef.current === null) {
                resizePreviewFrameRef.current = requestAnimationFrame(() => {
                    resizePreviewFrameRef.current = null;
                    const preview = pendingResizePreviewRef.current;
                    pendingResizePreviewRef.current = null;
                    if (preview) setLocalResizePreview(preview);
                });
            }
            onResize(data.id, width, height, position);
        },
        [data.id, getCanvasScale, onResize],
    );

    const handleResizeUp = useCallback(() => {
        const resize = resizeRef.current;
        if (resize.isResizing && (resize.currentWidth !== resize.startWidth || resize.currentHeight !== resize.startHeight || resize.currentPosition.x !== resize.startLeft || resize.currentPosition.y !== resize.startTop)) {
            onResizeEnd(data.id, resize.currentWidth, resize.currentHeight, resize.currentPosition);
        }
        resizeRef.current.isResizing = false;
        if (resizePreviewFrameRef.current !== null) {
            cancelAnimationFrame(resizePreviewFrameRef.current);
            resizePreviewFrameRef.current = null;
        }
        pendingResizePreviewRef.current = null;
        setLocalResizePreview(null);
        window.removeEventListener("mousemove", handleResizeMove);
        window.removeEventListener("mouseup", handleResizeUp);
    }, [data.id, handleResizeMove, onResizeEnd]);

    const handleResizeMouseDown = (event: React.MouseEvent, corner: ResizeCorner) => {
        event.stopPropagation();
        event.preventDefault();
        resizeRef.current = {
            isResizing: true,
            corner,
            startX: event.clientX,
            startY: event.clientY,
            startLeft: data.position.x,
            startTop: data.position.y,
            startWidth: data.width,
            startHeight: data.height,
            keepRatio: (data.type === CanvasNodeType.Image && !data.metadata?.freeResize) || data.type === CanvasNodeType.Video,
            ratio: (data.metadata?.naturalWidth || data.width) / (data.metadata?.naturalHeight || data.height || 1),
            currentWidth: data.width,
            currentHeight: data.height,
            currentPosition: data.position,
        };
        window.addEventListener("mousemove", handleResizeMove);
        window.addEventListener("mouseup", handleResizeUp);
    };

    useEffect(() => {
        return () => {
            window.removeEventListener("mousemove", handleResizeMove);
            window.removeEventListener("mouseup", handleResizeUp);
            if (resizePreviewFrameRef.current !== null) cancelAnimationFrame(resizePreviewFrameRef.current);
        };
    }, [handleResizeMove, handleResizeUp]);

    return (
        <div
            data-node-id={data.id}
            className={`node-element absolute flex select-none flex-col ${isMoving ? "[&_.backdrop-blur]:!backdrop-blur-none [&_.backdrop-blur-sm]:!backdrop-blur-none [&_.backdrop-blur-md]:!backdrop-blur-none" : "transition-shadow duration-200"} ${isSelected ? "z-50" : "z-10"}`}
            style={{
                transform: `translate(${position.x}px, ${position.y}px)`,
                width,
                height,
                transition: isMoving ? "none" : "box-shadow 200ms ease",
                ...canvasNodeRenderingStyle,
            }}
            onMouseEnter={() => {
                if (isMoving) return;
                setHovered(true);
                onHoverStart(data.id);
            }}
            onMouseLeave={() => {
                setHovered(false);
                if (!isMoving) onHoverEnd(data.id);
            }}
            onContextMenu={(event) => onContextMenu(event, data.id)}
        >
            <div
                className="relative h-full w-full overflow-visible rounded-3xl border-2"
                style={{
                    background: hasImageContent || hasVideoContent ? "transparent" : theme.node.fill,
                    borderColor: hasImageContent ? imageBorderColor : isActive ? theme.canvas.selectionStroke : isRelated ? theme.node.muted : theme.node.stroke,
                    boxShadow: isMoving ? undefined : isActive ? `0 0 0 1px ${theme.canvas.selectionStroke}55, 0 16px 40px rgba(15,23,42,.10)` : isRelated && !isBatchChild ? `0 0 0 1px ${theme.node.muted}55, 0 18px 48px rgba(0,0,0,.14)` : undefined,
                }}
                onMouseDown={(event) => {
                    if (event.target instanceof Element && event.target.closest("[data-canvas-no-zoom]")) return;
                    onMouseDown(event, data.id);
                }}
                onDoubleClick={(event) => {
                    if (isBatchRoot) {
                        event.stopPropagation();
                        onToggleBatch?.(data.id);
                        return;
                    }
                    if (data.type === CanvasNodeType.Image && hasImageContent) {
                        event.stopPropagation();
                        onViewImage?.(data);
                        return;
                    }
                    if (data.type !== CanvasNodeType.Text) return;
                    event.stopPropagation();
                    beginTextEditing();
                }}
            >
                <div
                    className={`relative flex h-full w-full items-center justify-center rounded-[inherit] ${isBatchRoot ? "overflow-visible" : "overflow-hidden"}`}
                    style={
                        {
                            background: hasImageContent || hasVideoContent ? "transparent" : theme.node.fill,
                            "--batch-from-x": `${batchMotion?.x || 0}px`,
                            "--batch-from-y": `${batchMotion?.y || 0}px`,
                            "--batch-from-rotate": `${6 + (batchMotion?.index || 0) * 4}deg`,
                            animation: data.metadata?.batchRootId ? (batchClosing ? "canvas-batch-child-out 260ms cubic-bezier(.4,0,.2,1) both" : "canvas-batch-child-in 340ms cubic-bezier(.2,.85,.18,1) both") : undefined,
                            animationDelay: data.metadata?.batchRootId ? `${batchClosing ? 0 : 45 + (batchMotion?.index || 0) * 24}ms` : undefined,
                        } as React.CSSProperties
                    }
                >
                    {useOverview ? (
                        <CanvasNodeOverview node={data} theme={theme} />
                    ) : useMovingPlaceholder ? (
                        <CanvasNodeOverview node={data} theme={theme} />
                    ) : (
                        <NodeContent
                            node={data}
                            theme={theme}
                            renderQuality={contentRenderQuality}
                            isEditingContent={isEditingContent}
                            textDraft={textDraft}
                            textareaRef={textareaRef}
                            isBatchRoot={isBatchRoot}
                            batchCount={batchCount}
                            batchExpanded={batchExpanded}
                            batchOpening={batchOpening}
                            batchRecovering={batchRecovering}
                            configInputSummary={configInputSummary}
                            isRunning={isRunning}
                            renderNodeContent={renderNodeContent}
                            mentionReferences={mentionReferences}
                            onContentChange={updateTextDraft}
                            onStopEditing={finishTextEditing}
                            onRetry={onRetry}
                            onGenerateImage={onGenerateImage}
                            onToggleBatch={() => onToggleBatch?.(data.id)}
                            onSetBatchPrimary={() => onSetBatchPrimary?.(data)}
                        />
                    )}
                </div>

                {!useOverview && showImageInfo && hasImageContent ? <ImageInfoBar node={data} /> : null}
                {!useOverview && resourceLabel ? <ResourceLabelBadge reference={resourceLabel} theme={theme} /> : null}

                {!useOverview && !hasImageContent && !hasVideoContent && !hasAudioContent ? <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12" style={{ background: `linear-gradient(to top, ${theme.canvas.background}66, transparent)` }} /> : null}

                {showNodeControls ? <><ResizeHandle corner="top-left" onMouseDown={handleResizeMouseDown} />
                <ResizeHandle corner="top-right" onMouseDown={handleResizeMouseDown} />
                <ResizeHandle corner="bottom-left" onMouseDown={handleResizeMouseDown} />
                <ResizeHandle corner="bottom-right" onMouseDown={handleResizeMouseDown} /></> : null}
            </div>

            {showNodeControls ? <><ConnectionHandleDot side="left" theme={theme} visible={effectiveHovered || isSelected || isConnecting} onMouseDown={(event) => onConnectStart(event, data.id, "target")} />
            <ConnectionHandleDot side="right" theme={theme} visible={data.type !== CanvasNodeType.Config && (effectiveHovered || isSelected || isConnecting)} onMouseDown={(event) => onConnectStart(event, data.id, "source")} /></> : null}

            {showPanel && renderPanel ? <div className="absolute left-1/2 top-full z-[70] w-[500px] -translate-x-1/2 pt-4">{renderPanel(data)}</div> : null}
        </div>
    );
}, canvasNodePropsEqual);

function canvasNodePropsEqual(previous: CanvasNodeProps, next: CanvasNodeProps) {
    if (!canvasNodeRenderStateEqual(toRenderState(previous), toRenderState(next))) return false;
    if (previous.previewPosition?.x !== next.previewPosition?.x || previous.previewPosition?.y !== next.previewPosition?.y) return false;
    if (previous.previewBounds?.position.x !== next.previewBounds?.position.x || previous.previewBounds?.position.y !== next.previewBounds?.position.y || previous.previewBounds?.width !== next.previewBounds?.width || previous.previewBounds?.height !== next.previewBounds?.height) return false;
    if (previous.getCanvasScale !== next.getCanvasScale || previous.onMouseDown !== next.onMouseDown || previous.onHoverStart !== next.onHoverStart || previous.onHoverEnd !== next.onHoverEnd || previous.onConnectStart !== next.onConnectStart || previous.onResize !== next.onResize || previous.onResizeEnd !== next.onResizeEnd || previous.onContentChange !== next.onContentChange || previous.onToggleBatch !== next.onToggleBatch || previous.onSetBatchPrimary !== next.onSetBatchPrimary || previous.onRetry !== next.onRetry || previous.onGenerateImage !== next.onGenerateImage || previous.onViewImage !== next.onViewImage || previous.onContextMenu !== next.onContextMenu) return false;
    if (previous.showPanel || next.showPanel) return previous.renderPanel === next.renderPanel;
    if (previous.data.type === CanvasNodeType.Config || next.data.type === CanvasNodeType.Config) return previous.renderNodeContent === next.renderNodeContent;
    return true;
}

function toRenderState(props: CanvasNodeProps): CanvasNodeRenderState {
    return {
        data: props.data,
        themeKey: props.themeKey,
        renderQuality: props.renderQuality,
        isSelected: props.isSelected,
        isRelated: props.isRelated,
        isFocusRelated: props.isFocusRelated,
        isConnectionTarget: props.isConnectionTarget,
        isConnecting: props.isConnecting,
        isRunning: props.isRunning,
        editRequestNonce: props.editRequestNonce ?? 0,
        showPanel: props.showPanel,
        showImageInfo: props.showImageInfo,
        configInputSummaryKey: configInputSummaryKey(props.configInputSummary),
        resourceLabel: props.resourceLabel,
        mentionReferences: props.mentionReferences || [],
        batchCount: props.batchCount ?? 0,
        batchExpanded: props.batchExpanded ?? false,
        batchClosing: props.batchClosing ?? false,
        batchOpening: props.batchOpening ?? false,
        batchRecovering: props.batchRecovering ?? false,
        batchMotion: props.batchMotion,
    };
}

function NodeContent(props: NodeContentRendererProps) {
    if (props.node.type === CanvasNodeType.Config && props.renderNodeContent) return props.renderNodeContent(props.node, { inputSummary: props.configInputSummary, isRunning: props.isRunning });
    if (props.isBatchRoot) return <ImageNodeContent {...props} />;
    if (props.node.metadata?.status === "loading" && !shouldShowCanvasTextStream(props.node)) return <LoadingContent theme={props.theme} />;
    if (props.node.metadata?.status === "error") return <ErrorContent node={props.node} theme={props.theme} onRetry={props.onRetry} />;

    const Renderer = nodeContentRenderers[props.node.type];
    return Renderer ? <Renderer {...props} /> : <UnknownNodeContent theme={props.theme} />;
}

const nodeContentRenderers = {
    [CanvasNodeType.Text]: TextContent,
    [CanvasNodeType.Image]: ImageNodeContent,
    [CanvasNodeType.Config]: EmptyImageContent,
    [CanvasNodeType.Video]: VideoNodeContent,
    [CanvasNodeType.Audio]: AudioNodeContent,
} satisfies Record<CanvasNodeType, (props: NodeContentRendererProps) => ReactNode>;

function LoadingContent({ theme }: Pick<NodeContentRendererProps, "theme">) {
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.activeStroke }}>
            <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: theme.node.stroke, borderTopColor: theme.node.activeStroke }} />
            <span className="text-[10px] tracking-[0.2em]">生成中</span>
        </div>
    );
}

function ErrorContent({ node, theme, onRetry }: Pick<NodeContentRendererProps, "node" | "theme" | "onRetry">) {
    const videoRecovery = node.type === CanvasNodeType.Video && Boolean(node.metadata?.videoTaskId);
    return (
        <div className="flex max-w-[260px] flex-col items-center gap-3 px-5 text-center">
            <div className="text-xs leading-5 text-red-300">{node.metadata?.errorDetails || "生成失败"}</div>
            <button
                type="button"
                disabled={videoRecovery && node.metadata?.videoTaskCanRecover === false}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition hover:scale-[1.02]"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                onClick={(event) => {
                    event.stopPropagation();
                    onRetry?.(node);
                }}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <RefreshCw className="size-3.5" />
                {videoRecovery ? node.metadata?.videoTaskCanRecover === false ? "提交状态待核查" : "恢复查询" : "重试"}
            </button>
        </div>
    );
}

function UnknownNodeContent({ theme }: Pick<NodeContentRendererProps, "theme">) {
    return (
        <div className="flex h-full w-full items-center justify-center text-sm" style={{ color: theme.node.placeholder }}>
            未知节点
        </div>
    );
}

function TextContent({ node, theme, isEditingContent, textDraft, textareaRef, mentionReferences, onContentChange, onStopEditing, onGenerateImage }: NodeContentRendererProps) {
    const fontSize = node.metadata?.fontSize || 14;
    const textStyle = { fontSize: `${fontSize}px`, lineHeight: `${Math.round(fontSize * 1.65)}px`, color: theme.node.text, boxSizing: "border-box" } as React.CSSProperties;

    return (
        <div className="flex h-full w-full flex-col overflow-hidden pt-8">
            <button
                type="button"
                className="absolute right-3 top-3 z-20 inline-flex h-8 items-center gap-1 rounded-full border px-2.5 text-xs font-medium opacity-85 backdrop-blur-md transition hover:scale-[1.02] hover:opacity-100"
                style={{ background: `${theme.toolbar.panel}dd`, borderColor: theme.node.stroke, color: theme.node.text }}
                onClick={(event) => {
                    event.stopPropagation();
                    onGenerateImage?.(node);
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title="用文本生图"
                aria-label="用文本生图"
            >
                <ImageIcon className="size-3.5" />
                生图
            </button>
            {isEditingContent ? (
                <CanvasResourceMentionTextarea
                    ref={textareaRef}
                    className="thin-scrollbar block h-full w-full resize-none overflow-y-auto whitespace-pre-wrap break-words border-none bg-transparent pl-4 pr-14 pt-0 pb-4 m-0 font-mono outline-none select-text appearance-none"
                    style={textStyle}
                    value={textDraft}
                    references={mentionReferences}
                    highlightLabels={false}
                    onChange={onContentChange}
                    onBlur={onStopEditing}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") onStopEditing();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onWheel={(event) => event.stopPropagation()}
                />
            ) : (
                <div
                    className="thin-scrollbar block h-full w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent pl-4 pr-14 pt-0 pb-4 font-mono"
                    style={textStyle}
                    onWheel={(event) => event.stopPropagation()}
                >
                    {node.metadata?.content || <span style={{ color: theme.node.placeholder }}>双击编辑文字</span>}
                </div>
            )}
        </div>
    );
}

function ResourceLabelBadge({ reference, theme }: { reference: CanvasResourceReference; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    return (
        <span className={`pointer-events-none absolute right-2 top-2 z-30 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${reference.active ? "text-white shadow-sm" : "bg-black/35 text-white/75"}`} style={reference.active ? { background: theme.canvas.selectionStroke } : undefined}>
            {reference.label}
        </span>
    );
}

function ImageNodeContent(props: NodeContentRendererProps) {
    const hasImageSource = Boolean(props.node.metadata?.content || props.node.metadata?.storageKey);
    if (!hasImageSource && props.isBatchRoot) {
        const content =
            props.node.metadata?.status === "loading" ? (
                <LoadingContent theme={props.theme} />
            ) : props.node.metadata?.status === "error" ? (
                <ErrorContent node={props.node} theme={props.theme} onRetry={props.onRetry} />
            ) : (
                <EmptyImageContent {...props} isBatchRoot={false} />
            );
        return (
            <BatchFrame theme={props.theme} batchCount={props.batchCount} batchExpanded={props.batchExpanded} batchOpening={props.batchOpening} batchRecovering={props.batchRecovering} onToggleBatch={props.onToggleBatch}>
                {content}
            </BatchFrame>
        );
    }
    if (!hasImageSource) return <EmptyImageContent {...props} />;

    return (
        <ImageContent
            node={props.node}
            theme={props.theme}
            isBatchRoot={props.isBatchRoot}
            batchCount={props.batchCount}
            batchExpanded={props.batchExpanded}
            batchOpening={props.batchOpening}
            batchRecovering={props.batchRecovering}
            onToggleBatch={props.onToggleBatch}
            onSetBatchPrimary={props.onSetBatchPrimary}
        />
    );
}

function EmptyImageContent({ theme, isBatchRoot, batchCount, batchExpanded, batchOpening, batchRecovering, onToggleBatch }: NodeContentRendererProps) {
    const content = (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.placeholder }}>
            <div className="flex size-14 items-center justify-center rounded-2xl" style={{ background: theme.toolbar.activeBg }}>
                <ImageIcon className="size-6 opacity-30" />
            </div>
            <span className="text-[10px] tracking-[0.18em] opacity-50">空图片节点</span>
        </div>
    );
    if (isBatchRoot)
        return (
            <BatchFrame theme={theme} batchCount={batchCount} batchExpanded={batchExpanded} batchOpening={batchOpening} batchRecovering={batchRecovering} onToggleBatch={onToggleBatch}>
                {content}
            </BatchFrame>
        );
    return content;
}

function VideoNodeContent({ node, theme, renderQuality }: NodeContentRendererProps) {
    const previewUrl = useCanvasNodeMediaPreview(node);
    if (!previewUrl)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.placeholder }}>
                <Video className="size-7 opacity-35" />
                <span className="text-sm">空视频节点</span>
            </div>
        );
    return <video src={previewUrl} {...canvasMediaPlaybackProps(renderQuality)} className="h-full w-full rounded-[18px] bg-black object-contain" data-canvas-no-zoom />;
}

function CanvasNodeOverview({ node, theme }: Pick<NodeContentRendererProps, "node" | "theme">) {
    const icon = node.type === CanvasNodeType.Image ? <ImageIcon className="size-4" /> : node.type === CanvasNodeType.Video ? <Video className="size-4" /> : node.type === CanvasNodeType.Audio ? <Music2 className="size-4" /> : node.type === CanvasNodeType.Text ? <span className="text-xs font-bold">T</span> : <span className="text-xs font-bold">AI</span>;
    return (
        <div data-testid="canvas-node-overview" className="flex h-full w-full items-center gap-2 overflow-hidden rounded-[inherit] px-3" style={{ background: theme.node.fill, color: theme.node.text }}>
            <span className="grid size-7 shrink-0 place-items-center rounded-lg" style={{ background: theme.toolbar.activeBg, color: theme.node.muted }}>{icon}</span>
            <span className="truncate text-xs font-medium">{node.title || node.type}</span>
        </div>
    );
}

function configInputSummaryKey(summary?: CanvasConfigInputSummary) {
    return summary ? `${summary.textCount}:${summary.imageCount}:${summary.videoCount}:${summary.audioCount}` : "0:0:0:0";
}

function AudioNodeContent({ node, theme, renderQuality }: NodeContentRendererProps) {
    const previewUrl = useCanvasNodeMediaPreview(node);
    if (!previewUrl)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2" style={{ color: theme.node.placeholder }}>
                <Music2 className="size-7 opacity-35" />
                <span className="text-sm">空音频节点</span>
            </div>
        );
    return (
        <div className="flex h-full w-full flex-col justify-center gap-3 px-4" style={{ background: theme.node.fill, color: theme.node.text }}>
            <div className="flex min-w-0 items-center gap-2 text-sm opacity-70">
                <Music2 className="size-4 shrink-0" />
                <span className="truncate">{node.title || "音频"}</span>
            </div>
            <audio src={previewUrl} {...canvasMediaPlaybackProps(renderQuality)} className="w-full" data-canvas-no-zoom />
        </div>
    );
}

function ImageContent({
    node,
    theme,
    isBatchRoot,
    batchCount,
    batchExpanded,
    batchOpening,
    batchRecovering,
    onToggleBatch,
    onSetBatchPrimary,
}: {
    node: CanvasNodeData;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    isBatchRoot: boolean;
    batchCount: number;
    batchExpanded: boolean;
    batchOpening: boolean;
    batchRecovering: boolean;
    onToggleBatch?: () => void;
    onSetBatchPrimary?: () => void;
}) {
    const isBatchChild = Boolean(node.metadata?.batchRootId);
    const previewUrl = useCanvasNodeMediaPreview(node);

    return (
        <BatchFrame theme={theme} batchCount={isBatchRoot ? batchCount : 0} batchExpanded={batchExpanded} batchOpening={batchOpening} batchRecovering={batchRecovering} onToggleBatch={onToggleBatch}>
            <div className="h-full w-full overflow-hidden rounded-3xl">
                {previewUrl ? (
                    <img
                        src={previewUrl}
                        alt={node.title}
                        draggable={false}
                        {...canvasImageRenderProps()}
                        onDragStart={(event) => event.preventDefault()}
                        className={`pointer-events-none block h-full w-full select-none ${node.metadata?.freeResize ? "object-fill" : "object-contain"}`}
                    />
                ) : (
                    <div className="h-full w-full animate-pulse" style={{ background: theme.toolbar.activeBg }} aria-label="正在恢复图片预览" />
                )}
            </div>
            {isBatchRoot ? (
                <button
                    type="button"
                    className="absolute right-2.5 top-2.5 z-30 flex h-8 items-center justify-center gap-1 rounded-full border px-2.5 text-xs font-semibold shadow-[0_6px_18px_rgba(15,23,42,.10)] backdrop-blur-md transition hover:scale-[1.02]"
                    style={{ background: `${theme.toolbar.panel}d9`, borderColor: `${theme.toolbar.border}cc`, color: theme.node.text }}
                    aria-label={batchExpanded ? "图片组已展开" : "图片组已收起"}
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleBatch?.();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <span className="leading-none" style={{ color: theme.canvas.selectionStroke }}>{batchCount}</span>
                    <ChevronRight className={`size-3.5 opacity-55 transition-transform ${batchExpanded ? "rotate-90" : ""}`} />
                </button>
            ) : null}
            {isBatchChild ? (
                <button
                    type="button"
                    className="absolute right-3 top-3 z-30 flex h-9 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-medium opacity-0 shadow-[0_8px_20px_rgba(68,64,60,.13)] backdrop-blur-md transition group-hover/batch:opacity-100 hover:scale-[1.02]"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                    onClick={(event) => {
                        event.stopPropagation();
                        onSetBatchPrimary?.();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <Star className="size-3.5" style={{ color: theme.canvas.selectionStroke }} />
                    设为主图
                </button>
            ) : null}
        </BatchFrame>
    );
}

function useCanvasNodeMediaPreview(node: CanvasNodeData) {
    const content = node.metadata?.content || "";
    const storageKey = node.metadata?.storageKey;
    const source = { type: node.type, content, storageKey };
    const needsResolution = needsCanvasNodeMediaPreviewResolution(source);
    const [previewUrl, setPreviewUrl] = useState(() => (needsResolution ? "" : content));

    useEffect(() => {
        let active = true;
        if (!needsResolution) {
            setPreviewUrl(content);
            return;
        }
        setPreviewUrl("");
        void resolveCanvasNodeMediaPreview(source, { resolveImage: resolveImageUrl, resolveMedia: resolveMediaUrl })
            .then((url) => {
                if (active) setPreviewUrl(url);
            })
            .catch(() => {
                if (active) setPreviewUrl("");
            });
        return () => {
            active = false;
        };
    }, [content, needsResolution, node.type, storageKey]);

    return previewUrl;
}

function ImageInfoBar({ node }: { node: CanvasNodeData }) {
    const width = Math.round(node.metadata?.naturalWidth || node.width);
    const height = Math.round(node.metadata?.naturalHeight || node.height);
    const size = formatBytes(node.metadata?.bytes || 0);
    return (
        <div className="pointer-events-none absolute bottom-3 right-3 z-40 max-w-[calc(100%-24px)]">
            <span className="max-w-full truncate rounded-md bg-black/55 px-2 py-1 text-[11px] font-medium leading-none text-white backdrop-blur-sm">
                {width} x {height}
                {size ? ` · ${size}` : ""}
            </span>
        </div>
    );
}

function BatchFrame({ theme, batchCount, batchExpanded, batchOpening, batchRecovering, onToggleBatch, children }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; batchCount: number; batchExpanded: boolean; batchOpening: boolean; batchRecovering: boolean; onToggleBatch?: () => void; children: ReactNode }) {
    const isBatchRoot = batchCount > 1;
    return (
        <div
            className="group/batch relative h-full w-full overflow-visible"
            onDoubleClick={
                isBatchRoot
                    ? (event) => {
                          event.stopPropagation();
                          onToggleBatch?.();
                      }
                    : undefined
            }
        >
            {isBatchRoot ? (
                <div className="pointer-events-none absolute inset-0 overflow-visible">
                    {Array.from({ length: Math.min(batchCount - 1, 5) }).map((_, index) => (
                        <div
                            key={index}
                            className="absolute rounded-[inherit] border shadow-[0_14px_34px_rgba(68,64,60,.16)] transition-all duration-300 group-hover/batch:translate-x-2"
                            style={{
                                inset: 0,
                                background: `linear-gradient(135deg, ${theme.node.panel}, ${theme.node.fill})`,
                                borderColor: theme.node.stroke,
                                opacity: batchExpanded && !batchOpening ? 0.34 : 1,
                                transform:
                                    batchOpening || batchRecovering ? `translate(${54 + index * 22}px, ${20 + index * 12}px) rotate(${8 + index * 5}deg) scale(.98)` : `translate(${34 + index * 18}px, ${14 + index * 10}px) rotate(${6 + index * 4}deg)`,
                                zIndex: -index - 1,
                            }}
                        />
                    ))}
                </div>
            ) : null}
            {children}
        </div>
    );
}
function ResizeHandle({ corner, onMouseDown }: { corner: ResizeCorner; onMouseDown: (event: React.MouseEvent, corner: ResizeCorner) => void }) {
    const positionClass = {
        "top-left": "-left-[14px] -top-[14px] cursor-nwse-resize",
        "top-right": "-right-[14px] -top-[14px] cursor-nesw-resize",
        "bottom-left": "-bottom-[14px] -left-[14px] cursor-nesw-resize",
        "bottom-right": "-bottom-[14px] -right-[14px] cursor-nwse-resize",
    }[corner];

    return <div className={`absolute z-50 size-7 ${positionClass}`} onMouseDown={(event) => onMouseDown(event, corner)} />;
}

function ConnectionHandleDot({ side, theme, visible, onMouseDown }: { side: "left" | "right"; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; visible: boolean; onMouseDown: (event: React.MouseEvent) => void }) {

    return (
        <div
            className={`absolute top-1/2 z-30 flex size-12 -translate-y-1/2 cursor-crosshair items-center justify-center transition-opacity duration-150 ${
                side === "left" ? "-left-6" : "-right-6"
            } ${visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
            onMouseDown={onMouseDown}
        >
            <div className="size-3 rounded-full border-2 transition-all hover:scale-125" style={{ background: theme.node.panel, borderColor: theme.node.muted }} />
        </div>
    );
}
