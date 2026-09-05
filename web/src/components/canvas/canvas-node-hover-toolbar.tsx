import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { App, Dropdown, Modal, Segmented, Tooltip, type MenuProps } from "antd";
import { Download, Ellipsis, FolderPlus, Image as ImageIcon, Info, MessageSquare, Minus, Music2, Pencil, Plus, RefreshCw, Settings2, Trash2, Upload, Video } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { formatBytes, getDataUrlByteSize } from "@/lib/image-utils";
import { useCopyText } from "@/hooks/use-copy-text";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";
import { ImageToolSettingsModal, type ImageToolbarSettingsTool } from "./canvas-image-toolbar-settings-modal";
import { IMAGE_QUICK_TOOLS_STORAGE_KEY, buildImageToolbarTools, compactImageQuickToolIds, defaultImageQuickToolIds, readImageQuickToolsConfig, type ImageQuickToolId } from "./canvas-image-toolbar-tools";

type CanvasNodeHoverToolbarProps = {
    node: CanvasNodeData | null;
    viewport: ViewportTransform;
    onKeep: (nodeId: string) => void;
    onLeave: () => void;
    onInfo: (node: CanvasNodeData) => void;
    onEditText: (node: CanvasNodeData) => void;
    onDecreaseFont: (node: CanvasNodeData) => void;
    onIncreaseFont: (node: CanvasNodeData) => void;
    onToggleDialog: (node: CanvasNodeData) => void;
    onGenerateImage: (node: CanvasNodeData) => void;
    onUpload: (node: CanvasNodeData) => void;
    onDownload: (node: CanvasNodeData) => void;
    onSaveAsset: (node: CanvasNodeData) => void;
    onMaskEdit: (node: CanvasNodeData) => void;
    onCrop: (node: CanvasNodeData) => void;
    onSplit: (node: CanvasNodeData) => void;
    onUpscale: (node: CanvasNodeData) => void;
    onSuperResolve: (node: CanvasNodeData) => void;
    onAngle: (node: CanvasNodeData) => void;
    onViewImage: (node: CanvasNodeData) => void;
    onReversePrompt: (node: CanvasNodeData) => void;
    onRetry: (node: CanvasNodeData) => void;
    onToggleFreeResize: (node: CanvasNodeData) => void;
    onDelete: (node: CanvasNodeData) => void;
};

type ToolbarTool = {
    id: string;
    title: string;
    label: string;
    icon: ReactNode;
    onClick: () => void;
    active?: boolean;
    danger?: boolean;
};

export function CanvasNodeHoverToolbar({
    node,
    viewport,
    onKeep,
    onLeave,
    onInfo,
    onEditText,
    onDecreaseFont,
    onIncreaseFont,
    onToggleDialog,
    onGenerateImage,
    onUpload,
    onDownload,
    onSaveAsset,
    onMaskEdit,
    onCrop,
    onSplit,
    onUpscale,
    onSuperResolve,
    onAngle,
    onViewImage,
    onReversePrompt,
    onRetry,
    onToggleFreeResize,
    onDelete,
}: CanvasNodeHoverToolbarProps) {
    const [quickImageToolIds, setQuickImageToolIds] = useState<ImageQuickToolId[]>(defaultImageQuickToolIds);
    const [showImageToolLabels, setShowImageToolLabels] = useState(true);
    const [draftImageToolIds, setDraftImageToolIds] = useState<ImageQuickToolId[]>(defaultImageQuickToolIds);
    const [draftShowImageToolLabels, setDraftShowImageToolLabels] = useState(true);
    const [imageToolSettingsOpen, setImageToolSettingsOpen] = useState(false);
    const [moreToolsOpen, setMoreToolsOpen] = useState(false);
    const toolbarRef = useRef<HTMLDivElement>(null);
    const [toolbarBounds, setToolbarBounds] = useState({ width: 360, height: 44, containerWidth: 0, containerHeight: 0 });
    const { message } = App.useApp();
    const copyText = useCopyText();

    useEffect(() => {
        try {
            const stored = window.localStorage.getItem(IMAGE_QUICK_TOOLS_STORAGE_KEY);
            if (!stored) return;
            const parsed = JSON.parse(stored) as unknown;
            const config = readImageQuickToolsConfig(parsed);
            setQuickImageToolIds(config.ids);
            setShowImageToolLabels(config.showLabels);
        } catch {
            // A malformed preference must not erase the user's stored configuration.
        }
    }, []);

    useEffect(() => {
        setImageToolSettingsOpen(false);
        setMoreToolsOpen(false);
    }, [node?.id]);

    useLayoutEffect(() => {
        const toolbar = toolbarRef.current;
        const container = toolbar?.offsetParent as HTMLElement | null;
        if (!toolbar || !container) return;
        const measure = () => {
            const rect = toolbar.getBoundingClientRect();
            const next = { width: rect.width, height: rect.height, containerWidth: container.clientWidth, containerHeight: container.clientHeight };
            setToolbarBounds((current) => Object.keys(next).every((key) => current[key as keyof typeof next] === next[key as keyof typeof next]) ? current : next);
        };
        measure();
        const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
        observer?.observe(toolbar);
        observer?.observe(container);
        window.addEventListener("resize", measure);
        return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
    }, [node?.id, quickImageToolIds, showImageToolLabels]);

    if (!node) return null;

    const activeNode = node;
    const { left, top } = clampCanvasNodeToolbarPosition({
        left: viewport.x + (node.position.x + node.width / 2) * viewport.k,
        top: viewport.y + node.position.y * viewport.k - 10,
        ...toolbarBounds,
    });
    const isImage = node.type === CanvasNodeType.Image;
    const isVideo = node.type === CanvasNodeType.Video;
    const isAudio = node.type === CanvasNodeType.Audio;
    const hasImage = isImage && Boolean(node.metadata?.content);
    const hasVideo = isVideo && Boolean(node.metadata?.content);
    const hasAudio = isAudio && Boolean(node.metadata?.content);
    const isText = node.type === CanvasNodeType.Text;
    const isConfig = node.type === CanvasNodeType.Config;
    const canOpenDialog = isText || hasImage || isVideo;
    const canRetry = node.metadata?.status === "error";
    const videoRecovery = isVideo && Boolean(node.metadata?.videoTaskId);
    const visibleImageToolIds = compactImageQuickToolIds(quickImageToolIds);
    const copyImagePrompt = (target: CanvasNodeData) => {
        const prompt = target.metadata?.prompt?.trim();
        if (!prompt) {
            message.warning("暂无可复制的提示词");
            return;
        }
        copyText(prompt, "提示词已复制");
    };
    const imageTools = buildImageToolbarTools(node, { onUpload, onToggleFreeResize, onMaskEdit, onCrop, onSplit, onUpscale, onSuperResolve, onAngle, onViewImage, onCopyPrompt: copyImagePrompt, onReversePrompt });

    function openImageToolSettings() {
        onKeep(activeNode.id);
        setMoreToolsOpen(false);
        setDraftImageToolIds(visibleImageToolIds);
        setDraftShowImageToolLabels(showImageToolLabels);
        setImageToolSettingsOpen(true);
    }

    const baseToolbarTools: ToolbarTool[] = [
        { id: "info", title: "查看节点信息", label: "信息", icon: <Info className="size-4" />, onClick: () => onInfo(node) },
        { id: "delete", title: "移除节点", label: "删除", icon: <Trash2 className="size-4" />, onClick: () => onDelete(node), danger: true },
    ];
    const nodeToolbarTools: ToolbarTool[] = [
        ...(canRetry && !(videoRecovery && node.metadata?.videoTaskCanRecover === false) ? [{ id: "retry", title: videoRecovery ? "恢复原任务查询，不会重新生成" : "重新生成", label: videoRecovery ? "恢复查询" : "重试", icon: <RefreshCw className="size-4" />, onClick: () => onRetry(node) }] : []),
        ...(hasImage || hasVideo || isText ? [{ id: "saveAsset", title: "加入我的素材", label: "存素材", icon: <FolderPlus className="size-4" />, onClick: () => onSaveAsset(node) }] : []),
        ...(hasImage || hasVideo || hasAudio ? [{ id: "download", title: hasAudio ? "下载音频" : hasVideo ? "下载视频" : "下载图片", label: "下载", icon: <Download className="size-4" />, onClick: () => onDownload(node) }] : []),
        ...(canOpenDialog ? [{ id: "edit", title: "编辑", label: "编辑", icon: <MessageSquare className="size-4" />, onClick: () => onToggleDialog(node) }] : []),
        ...(isText ? [{ id: "editText", title: "编辑文本", label: "编辑文字", icon: <Pencil className="size-4" />, onClick: () => onEditText(node) }] : []),
        ...(isText ? [{ id: "generateImage", title: "用文本生图", label: "生图", icon: <ImageIcon className="size-4" />, onClick: () => onGenerateImage(node) }] : []),
        ...(isConfig ? [{ id: "config", title: "生成配置", label: "生成配置", icon: <Settings2 className="size-4" />, onClick: () => onToggleDialog(node) }] : []),
        ...(isText ? [{ id: "decreaseFont", title: "减小字号", label: "缩小", icon: <Minus className="size-4" />, onClick: () => onDecreaseFont(node) }] : []),
        ...(isText ? [{ id: "increaseFont", title: "增大字号", label: "放大", icon: <Plus className="size-4" />, onClick: () => onIncreaseFont(node) }] : []),
        ...(isImage && !hasImage ? [{ id: "uploadImage", title: "上传图片", label: "上传图片", icon: <Upload className="size-4" />, onClick: () => onUpload(node) }] : []),
        ...(isVideo ? [{ id: "uploadVideo", title: hasVideo ? "替换视频" : "上传视频", label: hasVideo ? "替换视频" : "上传视频", icon: <Video className="size-4" />, onClick: () => onUpload(node) }] : []),
        ...(isAudio ? [{ id: "uploadAudio", title: hasAudio ? "替换音频" : "上传音频", label: hasAudio ? "替换音频" : "上传音频", icon: <Music2 className="size-4" />, onClick: () => onUpload(node) }] : []),
        ...(hasImage ? imageTools.map((tool) => ({ id: tool.id, title: tool.title, label: tool.label, icon: tool.icon, active: tool.active, onClick: tool.onClick })) : []),
    ];
    const allToolbarTools = [...baseToolbarTools, ...nodeToolbarTools];
    const toolbarTools = hasImage ? visibleImageToolIds.flatMap((id) => allToolbarTools.find((tool) => tool.id === id) || []) : allToolbarTools;
    const overflowTools = allToolbarTools.filter((tool) => !toolbarTools.some((visible) => visible.id === tool.id));
    const selectableImageToolbarTools = allToolbarTools.filter((tool) => !["retry", "info", "delete"].includes(tool.id)) as ImageToolbarSettingsTool[];
    const menuTool = (tool: ToolbarTool) => ({ key: tool.id, label: tool.label, title: tool.title, icon: <span className="[&_svg]:size-[18px]">{tool.icon}</span>, danger: tool.danger });
    const moreMenu: MenuProps = {
        style: { background: "#fff", color: "#27272a", boxShadow: "none" },
        items: [
            ...overflowTools.filter((tool) => !["info", "delete"].includes(tool.id)).map(menuTool),
            { type: "divider" },
            ...overflowTools.filter((tool) => ["info", "delete"].includes(tool.id)).map(menuTool),
            { type: "divider" },
            { key: "customize", label: "自定义工具", icon: <Settings2 className="size-[18px]" /> },
        ],
        onClick: ({ key, domEvent }) => {
            domEvent.stopPropagation();
            setMoreToolsOpen(false);
            if (key === "customize") openImageToolSettings();
            else overflowTools.find((tool) => tool.id === key)?.onClick();
        },
    };

    const closeImageToolSettings = () => {
        setImageToolSettingsOpen(false);
        onLeave();
    };

    const setDraftImageToolVisible = (id: ImageQuickToolId, visible: boolean) => {
        setDraftImageToolIds((current) => {
            const selected = new Set(current);
            if (visible && !selected.has(id) && selected.size >= 4) {
                message.warning("快捷工具最多显示 4 项，其他工具可在“更多”中使用");
                return current;
            }
            if (visible) selected.add(id);
            else selected.delete(id);
            return selectableImageToolbarTools.filter((tool) => selected.has(tool.id)).map((tool) => tool.id);
        });
    };

    const saveImageToolSettings = () => {
        const config = { ids: draftImageToolIds, showLabels: draftShowImageToolLabels };
        setQuickImageToolIds(config.ids);
        setShowImageToolLabels(config.showLabels);
        window.localStorage.setItem(IMAGE_QUICK_TOOLS_STORAGE_KEY, JSON.stringify(config));
        closeImageToolSettings();
    };

    return (
        <>
            <div
                ref={toolbarRef}
                role="toolbar"
                aria-label={hasImage ? "图片工具栏" : "节点工具栏"}
                data-canvas-node-toolbar="true"
                className="absolute z-[70] flex h-11 -translate-x-1/2 -translate-y-full items-center overflow-visible rounded-xl border border-[#e4e4e7] bg-white px-1 text-[13px] text-[#27272a] shadow-[0_4px_16px_rgba(24,24,27,.08)]"
                style={{ left, top, maxWidth: "calc(100% - 24px)" }}
                onMouseEnter={() => onKeep(node.id)}
                onMouseLeave={() => {
                    if (!imageToolSettingsOpen && !moreToolsOpen) onLeave();
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
            >
                <div className="hide-scrollbar flex min-w-0 items-center overflow-x-auto">
                    {toolbarTools.map((tool) => (
                        <ToolbarAction key={tool.id} {...tool} highResolution={tool.id === "upscale" || tool.id === "superResolve"} showLabel={showImageToolLabels} />
                    ))}
                </div>
                {hasImage ? (
                    <Dropdown
                        trigger={["click"]}
                        open={moreToolsOpen}
                        onOpenChange={(open) => { setMoreToolsOpen(open); if (open) onKeep(node.id); }}
                        menu={moreMenu}
                        placement="bottomRight"
                        autoAdjustOverflow
                        popupRender={(menu) => (
                            <div className="thin-scrollbar max-h-[min(480px,calc(100vh-32px))] overflow-y-auto rounded-xl border border-[#e4e4e7] bg-white p-1 shadow-[0_8px_28px_rgba(24,24,27,.12)]" onMouseEnter={() => onKeep(node.id)} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                                {menu}
                            </div>
                        )}
                    >
                        <button type="button" aria-label="更多图片工具" aria-haspopup="menu" aria-expanded={moreToolsOpen} className={`ml-0.5 flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 transition hover:bg-[#f4f4f5] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#a1a1aa] ${moreToolsOpen ? "bg-[#f4f4f5]" : ""}`}>
                            <Ellipsis className="size-[18px]" />
                            {showImageToolLabels ? <span>更多</span> : null}
                        </button>
                    </Dropdown>
                ) : null}
            </div>
            {hasImage ? (
                <ImageToolSettingsModal
                    open={imageToolSettingsOpen}
                    tools={selectableImageToolbarTools}
                    selectedIds={draftImageToolIds}
                    showLabels={draftShowImageToolLabels}
                    onToggle={setDraftImageToolVisible}
                    onShowLabelsChange={setDraftShowImageToolLabels}
                    onCancel={closeImageToolSettings}
                    onSave={saveImageToolSettings}
                />
            ) : null}
        </>
    );
}

export function clampCanvasNodeToolbarPosition({ left, top, width, height, containerWidth, containerHeight }: { left: number; top: number; width: number; height: number; containerWidth: number; containerHeight: number }) {
    const margin = 12;
    const halfWidth = Math.min(width, Math.max(0, containerWidth - margin * 2)) / 2;
    return {
        left: containerWidth > 0 ? Math.min(Math.max(left, margin + halfWidth), Math.max(margin + halfWidth, containerWidth - margin - halfWidth)) : left,
        top: containerHeight > 0 ? Math.min(Math.max(top, margin + height), Math.max(margin + height, containerHeight - margin)) : top,
    };
}

export function CanvasNodeInfoModal({ node, open, onClose }: { node: CanvasNodeData | null; open: boolean; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [view, setView] = useState<"info" | "json">("info");
    const imageBytes = node?.type === CanvasNodeType.Image && node.metadata?.content ? getDataUrlByteSize(node.metadata.content) : 0;
    const batchCount = node?.type === CanvasNodeType.Image ? node.metadata?.batchChildIds?.length || 0 : 0;
    const json = useMemo(() => {
        if (!node) return "";
        return JSON.stringify(
            node,
            (key, value) => {
                if (key === "title") return undefined;
                if (key === "content" && typeof value === "string" && value.startsWith("data:image/")) {
                    return "[base64 image]";
                }
                return value;
            },
            2,
        );
    }, [node]);

    useEffect(() => {
        if (open) setView("info");
    }, [node?.id, open]);

    const title = (
        <div className="flex items-center justify-between gap-4 pr-12">
            <span>节点信息</span>
            <Segmented
                size="small"
                value={view}
                onChange={(value) => setView(value as "info" | "json")}
                options={[
                    { label: "信息", value: "info" },
                    { label: "JSON", value: "json" },
                ]}
            />
        </div>
    );

    return (
        <Modal className="canvas-node-info-modal" title={title} open={open && Boolean(node)} centered footer={null} onCancel={onClose}>
            {node ? (
                <div className="h-[56vh] min-h-[360px] text-sm">
                    {view === "info" ? (
                        <div className="thin-scrollbar h-full space-y-3 overflow-auto pr-1">
                            <InfoRow label="ID" value={node.id} />
                            <InfoRow label="类型" value={node.type === CanvasNodeType.Text ? "文本" : node.type === CanvasNodeType.Image ? "图片" : node.type === CanvasNodeType.Video ? "视频" : node.type === CanvasNodeType.Audio ? "音频" : "生成配置"} />
                            <InfoRow label="尺寸" value={`${Math.round(node.width)} x ${Math.round(node.height)}`} />
                            <InfoRow label="位置" value={`${Math.round(node.position.x)}, ${Math.round(node.position.y)}`} />
                            <InfoRow label="状态" value={node.metadata?.status || "idle"} />
                            {batchCount > 1 ? <InfoRow label="图片组" value={`${batchCount} 张`} /> : null}
                            {node.metadata?.prompt ? <InfoRow label="提示词" value={node.metadata.prompt} /> : null}
                            {imageBytes ? <InfoRow label="图片大小" value={formatBytes(imageBytes)} /> : null}
                            {node.metadata?.errorDetails ? (
                                <div className="rounded-lg border p-3 text-red-400" style={{ borderColor: theme.node.stroke }}>
                                    {node.metadata.errorDetails}
                                </div>
                            ) : null}
                        </div>
                    ) : (
                        <pre className="thin-scrollbar h-full overflow-auto rounded-lg border p-3 text-xs leading-5" style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text }}>
                            {json}
                        </pre>
                    )}
                </div>
            ) : null}
        </Modal>
    );
}

function ToolbarAction({ title, label, icon, onClick, showLabel, active = false, danger = false, highResolution = false }: ToolbarTool & { showLabel: boolean; highResolution?: boolean }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const hasText = showLabel && Boolean(label);
    return (
        <Tooltip title={title} placement="top" mouseEnterDelay={0.2} color="#ffffff" styles={{ root: { color: "#242529", boxShadow: "0 8px 24px rgba(15,23,42,.16)", fontSize: 13, fontWeight: 500 } }}>
            <button type="button" className={`group relative flex h-9 shrink-0 items-center whitespace-nowrap rounded-lg px-0.5 focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-[#a1a1aa] ${danger ? "text-[#ef4444]" : ""}`} style={highResolution && !danger ? { color: theme.toolbar.highResolution } : undefined} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onClick(); }} aria-label={title}>
                <span className={`flex h-8 items-center ${hasText ? "gap-1.5 px-2.5" : "justify-center px-2"} rounded-lg transition group-hover:bg-[#f4f4f5] [&_svg]:size-[18px] ${active ? "bg-[#f4f4f5]" : ""}`}>
                    {icon}
                    {hasText ? <span>{label}</span> : null}
                </span>
            </button>
        </Tooltip>
    );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
    return (
        <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
            <span className="opacity-50">{label}</span>
            <span className="min-w-0 whitespace-pre-wrap break-words">{value}</span>
        </div>
    );
}
