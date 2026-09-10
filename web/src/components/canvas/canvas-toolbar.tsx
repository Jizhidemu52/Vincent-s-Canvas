import { memo } from "react";
import { Dropdown, Tooltip } from "antd";
import { Eraser, FolderOpen, Hand, Image as ImageIcon, MoreHorizontal, MousePointer2, Music2, Redo2, Settings2, Sparkles, Trash2, Type, Undo2, Upload, Video, WandSparkles } from "lucide-react";
import { canvasToolbarPropsEqual, type CanvasToolbarRenderState } from "@/lib/canvas/canvas-toolbar-render-stability";

export const CanvasToolbar = memo(function CanvasToolbar(props: CanvasToolbarRenderState) {
    const { selectedCount, canUndo, canRedo, onAddImage, onAddVideo, onAddAudio, onAddText, onAddConfig, onOpenQuickGenerate, onOpenBatchEdit, onUndo, onRedo, onUpload, onDelete, onClear, onDeselect, onOpenMyAssets, backgroundMode, showImageInfo, onBackgroundModeChange, onShowImageInfoChange, interactionMode = "select", onInteractionModeChange, children } = props;
    return (
        <div data-testid="canvas-top-tool-rail" className="cw-dock">
            <div className="cw-tools">
                <Tooltip title="选择 / 框选"><button type="button" className="cw-icon" aria-label="选择 / 框选" aria-pressed={interactionMode === "select"} onClick={() => onInteractionModeChange?.("select")}><MousePointer2 className="size-4" /></button></Tooltip>
                <Tooltip title="移动画布"><button type="button" className="cw-icon" aria-label="移动画布" aria-pressed={interactionMode === "hand"} onClick={() => { onDeselect(); onInteractionModeChange?.("hand"); }}><Hand className="size-4" /></button></Tooltip>
                <Tooltip title="上传素材"><button type="button" className="cw-icon" aria-label="上传素材" onClick={onUpload}><Upload className="size-4" /></button></Tooltip>
                <Tooltip title="文本"><button type="button" className="cw-icon" aria-label="文本" onClick={onAddText}><Type className="size-4" /></button></Tooltip>
                <Tooltip title="生成配置"><button type="button" className="cw-icon" aria-label="生成配置" onClick={onAddConfig}><Settings2 className="size-4" /></button></Tooltip>
                <Dropdown trigger={["click"]} placement="top" menu={{ items: [
                    { key: "generate", icon: <Sparkles className="size-4" />, label: "画布生图", onClick: onOpenQuickGenerate },
                    { key: "image", icon: <ImageIcon className="size-4" />, label: "图片节点", onClick: onAddImage },
                    { key: "video", icon: <Video className="size-4" />, label: "视频节点", onClick: onAddVideo },
                    { key: "audio", icon: <Music2 className="size-4" />, label: "音频节点", onClick: onAddAudio },
                    { key: "batch", icon: <WandSparkles className="size-4" />, label: "批量改图", onClick: onOpenBatchEdit },
                    { type: "divider" },
                    { key: "background", label: "画布背景", children: (["dots", "lines", "blank"] as const).map((mode) => ({ key: mode, label: `${backgroundMode === mode ? "✓ " : ""}${mode === "dots" ? "点阵" : mode === "lines" ? "网格" : "纯色"}`, onClick: () => onBackgroundModeChange(mode) })) },
                    { key: "info", label: `${showImageInfo ? "✓ " : ""}显示图片信息`, onClick: () => onShowImageInfoChange(!showImageInfo) },
                    { type: "divider" },
                    { key: "delete", danger: true, disabled: !selectedCount, icon: <Trash2 className="size-4" />, label: "删除选中", onClick: onDelete },
                    { key: "clear", danger: true, icon: <Eraser className="size-4" />, label: "清空画布", onClick: onClear },
                ] }}><button type="button" className="cw-icon" aria-label="更多工具"><MoreHorizontal className="size-4" /></button></Dropdown>
                <span className="cw-divider" />
                <Tooltip title="撤销"><button type="button" className="cw-icon" aria-label="撤销" disabled={!canUndo} onClick={onUndo}><Undo2 className="size-4" /></button></Tooltip>
                <Tooltip title="重做"><button type="button" className="cw-icon" aria-label="重做" disabled={!canRedo} onClick={onRedo}><Redo2 className="size-4" /></button></Tooltip>
            </div>
            <div className="cw-tools">
                <Tooltip title="我的素材"><button type="button" className="cw-icon" aria-label="我的素材" onClick={onOpenMyAssets}><FolderOpen className="size-4" /></button></Tooltip>
                {children}
            </div>
        </div>
    );
}, canvasToolbarPropsEqual);
