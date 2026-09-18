import type { ReactNode } from "react";
import { Brush, Camera, Columns2, Copy, FileText, Grid2x2, History, Lock, LockOpen, Maximize2, PanelsTopLeft, PencilRuler, Scissors, Sparkles, Upload, ZoomIn } from "lucide-react";

import type { CanvasNodeData } from "@/types/canvas";

export type ImageNodeActionToolId = "compare" | "designTemplate" | "restoreGeneration" | "manualEdit" | "copyPrompt" | "reversePrompt" | "replace" | "resize" | "maskEdit" | "crop" | "split" | "upscale" | "superResolve" | "angle" | "view";
export type ImageQuickToolId = "info" | "delete" | "saveAsset" | "download" | "edit" | ImageNodeActionToolId;

export type ImageToolHandlers = {
    onCompare?: (node: CanvasNodeData) => void;
    onDesignTemplate?: (node: CanvasNodeData) => void;
    onRestoreGeneration?: (node: CanvasNodeData) => void;
    onManualEdit: (node: CanvasNodeData) => void;
    onUpload: (node: CanvasNodeData) => void;
    onToggleFreeResize: (node: CanvasNodeData) => void;
    onMaskEdit: (node: CanvasNodeData) => void;
    onCrop: (node: CanvasNodeData) => void;
    onSplit: (node: CanvasNodeData) => void;
    onUpscale: (node: CanvasNodeData) => void;
    onSuperResolve: (node: CanvasNodeData) => void;
    onAngle: (node: CanvasNodeData) => void;
    onViewImage: (node: CanvasNodeData) => void;
    onCopyPrompt: (node: CanvasNodeData) => void;
    onReversePrompt: (node: CanvasNodeData) => void;
};

export type ImageToolDefinition = {
    id: ImageNodeActionToolId;
    defaultVisible: boolean;
    panelLabel: string;
    label: string | ((node: CanvasNodeData) => string);
    title: string | ((node: CanvasNodeData) => string);
    icon: (node: CanvasNodeData) => ReactNode;
    active?: (node: CanvasNodeData) => boolean;
    run: (node: CanvasNodeData, handlers: ImageToolHandlers) => void;
};

export type ImageQuickToolsConfig = {
    ids: ImageQuickToolId[];
    showLabels: boolean;
};

export const IMAGE_QUICK_TOOLS_STORAGE_KEY = "canvas-image-quick-tools-v6";

const allBaseToolIds: ImageQuickToolId[] = ["info", "delete", "saveAsset", "download", "edit"];

export const imageToolDefinitions: ImageToolDefinition[] = [
    { id: "compare", defaultVisible: false, panelLabel: "改款前后对比", label: "改款前后对比 · 得到对比图", title: "得到滑块、并排、叠加预览和 PNG 对比图，不改原图", icon: () => <Columns2 className="size-[18px]" />, run: (node, handlers) => handlers.onCompare?.(node) },
    { id: "designTemplate", defaultVisible: false, panelLabel: "服装画布模板", label: "服装画布模板 · 得到整套生成流程", title: "以当前图为参考，新增线稿、改色、效果图等可编辑生成配置", icon: () => <PanelsTopLeft className="size-[18px]" />, run: (node, handlers) => handlers.onDesignTemplate?.(node) },
    { id: "restoreGeneration", defaultVisible: false, panelLabel: "恢复生成输入", label: "恢复生成输入 · 找回参考图和参数", title: "恢复当时的提示词、参考原图和参数，不自动生成", icon: () => <History className="size-[18px]" />, run: (node, handlers) => handlers.onRestoreGeneration?.(node) },
    {
        id: "manualEdit", defaultVisible: true, panelLabel: "编辑图片", label: "编辑图片", title: "编辑图片",
        icon: () => <PencilRuler className="size-[18px]" />,
        run: (node, handlers) => handlers.onManualEdit(node),
    },
    {
        id: "copyPrompt",
        defaultVisible: true,
        panelLabel: "复制提示词",
        label: "复制提示词",
        title: "复制生成该图片的提示词",
        icon: () => <Copy className="size-[18px]" />,
        run: (node, handlers) => handlers.onCopyPrompt(node),
    },
    {
        id: "reversePrompt",
        defaultVisible: true,
        panelLabel: "反推提示词",
        label: "反推提示词",
        title: "创建反推提示词的文本和配置节点",
        icon: () => <FileText className="size-[18px]" />,
        run: (node, handlers) => handlers.onReversePrompt(node),
    },
    {
        id: "replace",
        defaultVisible: true,
        panelLabel: "替换图片",
        label: "替换图片",
        title: "替换图片",
        icon: () => <Upload className="size-[18px]" />,
        run: (node, handlers) => handlers.onUpload(node),
    },
    {
        id: "resize",
        defaultVisible: false,
        panelLabel: "锁比例",
        label: (node) => (node.metadata?.freeResize ? "自由比例" : "锁比例"),
        title: (node) => (node.metadata?.freeResize ? "切换为等比缩放" : "切换为自由比例"),
        icon: (node) => (node.metadata?.freeResize ? <LockOpen className="size-[18px]" /> : <Lock className="size-[18px]" />),
        active: (node) => Boolean(node.metadata?.freeResize),
        run: (node, handlers) => handlers.onToggleFreeResize(node),
    },
    {
        id: "maskEdit",
        defaultVisible: true,
        panelLabel: "局部重绘",
        label: "局部重绘",
        title: "局部重绘",
        icon: () => <Brush className="size-[18px]" />,
        run: (node, handlers) => handlers.onMaskEdit(node),
    },
    {
        id: "crop",
        defaultVisible: true,
        panelLabel: "裁剪",
        label: "裁剪",
        title: "裁剪并生成新节点",
        icon: () => <Scissors className="size-[18px]" />,
        run: (node, handlers) => handlers.onCrop(node),
    },
    {
        id: "split",
        defaultVisible: true,
        panelLabel: "切图",
        label: "切图",
        title: "按行列切分图片",
        icon: () => <Grid2x2 className="size-[18px]" />,
        run: (node, handlers) => handlers.onSplit(node),
    },
    {
        id: "upscale",
        defaultVisible: true,
        panelLabel: "放大",
        label: "放大",
        title: "放大图片分辨率",
        icon: () => <ZoomIn className="size-[18px]" />,
        run: (node, handlers) => handlers.onUpscale(node),
    },
    {
        id: "superResolve",
        defaultVisible: false,
        panelLabel: "超分",
        label: "超分",
        title: "AI 超分",
        icon: () => <Sparkles className="size-[18px]" />,
        run: (node, handlers) => handlers.onSuperResolve(node),
    },
    {
        id: "angle",
        defaultVisible: false,
        panelLabel: "多角度",
        label: "多角度",
        title: "生成角度",
        icon: () => <Camera className="size-[18px]" />,
        run: (node, handlers) => handlers.onAngle(node),
    },
    {
        id: "view",
        defaultVisible: true,
        panelLabel: "查看大图",
        label: "查看大图",
        title: "查看图片详情",
        icon: () => <Maximize2 className="size-[18px]" />,
        run: (node, handlers) => handlers.onViewImage(node),
    },
];

export const defaultImageQuickToolIds: ImageQuickToolId[] = ["manualEdit", "edit", "download"];

/** Keep old preferences intact while preventing a legacy full-width toolbar. */
export function compactImageQuickToolIds(ids: ImageQuickToolId[]) {
    const visible = ids.filter((id) => id !== "info" && id !== "delete");
    return visible.length > 4 ? defaultImageQuickToolIds : visible;
}

export function buildImageToolbarTools(node: CanvasNodeData, handlers: ImageToolHandlers) {
    return imageToolDefinitions.filter(tool => tool.id === "compare" ? Boolean(handlers.onCompare) : tool.id === "designTemplate" ? Boolean(handlers.onDesignTemplate) : tool.id === "restoreGeneration" ? Boolean(handlers.onRestoreGeneration) : true).map((tool) => ({
        id: tool.id,
        label: resolveToolText(tool.label, node),
        title: resolveToolText(tool.title, node),
        icon: tool.icon(node),
        active: tool.active?.(node),
        onClick: () => tool.run(node, handlers),
    }));
}

export function normalizeImageQuickToolIds(value: unknown[]) {
    const allIds: ImageQuickToolId[] = [...allBaseToolIds, ...imageToolDefinitions.map((tool) => tool.id)];
    const ids = new Set(allIds);
    return Array.from(new Set(value.filter((id): id is ImageQuickToolId => typeof id === "string" && ids.has(id as ImageQuickToolId))));
}

export function readImageQuickToolsConfig(value: unknown): ImageQuickToolsConfig {
    if (Array.isArray(value)) return { ids: normalizeImageQuickToolIds(value), showLabels: true };
    if (!value || typeof value !== "object") return { ids: defaultImageQuickToolIds, showLabels: true };
    const data = value as Partial<ImageQuickToolsConfig>;
    return {
        ids: Array.isArray(data.ids) ? normalizeImageQuickToolIds(data.ids) : defaultImageQuickToolIds,
        showLabels: data.showLabels !== false,
    };
}

function resolveToolText(value: string | ((node: CanvasNodeData) => string), node: CanvasNodeData) {
    return typeof value === "function" ? value(node) : value;
}
