import { memo } from "react";
import { Dropdown, Tooltip } from "antd";
import { Eraser, FolderOpen, FolderPlus, Hand, Image as ImageIcon, MoreHorizontal, MousePointer2, Music2, Redo2, Settings2, Sparkles, Trash2, Type, Undo2, Upload, Video, WandSparkles } from "lucide-react";
import { canvasToolbarPropsEqual, type CanvasToolbarRenderState } from "@/lib/canvas/canvas-toolbar-render-stability";
import { isModuleAvailable, useModuleEnabled, useModuleStore } from "@/stores/use-module-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { canvasActionModules } from "@/lib/canvas/tool-availability";

export const CanvasToolbar = memo(function CanvasToolbar(props: CanvasToolbarRenderState) {
    const localToolsEnabled = useModuleEnabled("canvas-local-tools");
    const flags = useModuleStore(state => state.flags);
    const bindings = useBusinessConfigStore(state => state.tools);
    const { selectedCount, canUndo, canRedo, onAddImage, onAddVideo, onAddAudio, onAddText, onAddConfig, onOpenQuickGenerate, onOpenBatchEdit, onUndo, onRedo, onUpload, onDelete, onClear, onDeselect, onOpenMyAssets, backgroundMode, showImageInfo, onBackgroundModeChange, onShowImageInfoChange, interactionMode = "select", onInteractionModeChange, children } = props;
    return (
        <div data-testid="canvas-top-tool-rail" className="cw-dock">
            <div className="cw-tools">
                <Tooltip title="选择 / 框选"><button data-usage-control="canvas-tool.select" type="button" className="cw-icon" aria-label="选择 / 框选" aria-pressed={interactionMode === "select"} onClick={() => onInteractionModeChange?.("select")}><MousePointer2 className="size-4" /></button></Tooltip>
                <Tooltip title="移动画布"><button data-usage-control="canvas-tool.pan" type="button" className="cw-icon" aria-label="移动画布" aria-pressed={interactionMode === "hand"} onClick={() => { onDeselect(); onInteractionModeChange?.("hand"); }}><Hand className="size-4" /></button></Tooltip>
                <Tooltip title="上传素材"><button data-usage-control="canvas-tool.upload" type="button" className="cw-icon" aria-label="上传素材" onClick={onUpload}><Upload className="size-4" /></button></Tooltip>
                <Tooltip title="文本"><button data-usage-control="canvas-tool.text" type="button" className="cw-icon" aria-label="文本" onClick={onAddText}><Type className="size-4" /></button></Tooltip>
                <Tooltip title="生成配置"><button data-usage-control="canvas-tool.config" type="button" className="cw-icon" aria-label="生成配置" onClick={onAddConfig}><Settings2 className="size-4" /></button></Tooltip>
                {localToolsEnabled && selectedCount >= 2 && props.onGroupSelection ? <Tooltip title="创建款式组（Ctrl / ⌘ G）"><button data-usage-control="canvas-tool.group" type="button" className="cw-icon" aria-label="创建款式组" onClick={props.onGroupSelection}><FolderPlus className="size-4" /></button></Tooltip> : null}
                <Dropdown trigger={["click"]} placement="top" menu={{ items: [
                    { key: "generate", icon: <Sparkles className="size-4" />, label: <span data-usage-control="canvas-tool.generate">画布生图</span>, onClick: onOpenQuickGenerate },
                    { key: "image", icon: <ImageIcon className="size-4" />, label: <span data-usage-control="canvas-tool.image">图片节点</span>, onClick: onAddImage },
                    { key: "video", icon: <Video className="size-4" />, label: <span data-usage-control="canvas-tool.video">视频节点</span>, onClick: onAddVideo },
                    { key: "audio", icon: <Music2 className="size-4" />, label: <span data-usage-control="canvas-tool.audio">音频节点</span>, onClick: onAddAudio },
                    { key: "batch", icon: <WandSparkles className="size-4" />, label: <span data-usage-control="canvas-tool.batch">批量改图</span>, onClick: onOpenBatchEdit },
                    { type: "divider" as const },
                    { key: "background", label: <span data-usage-control="canvas-tool.background">画布背景</span>, children: (["dots", "lines", "blank"] as const).map((mode) => ({ key: mode, label: `${backgroundMode === mode ? "✓ " : ""}${mode === "dots" ? "点阵" : mode === "lines" ? "网格" : "纯色"}`, onClick: () => onBackgroundModeChange(mode) })) },
                    { key: "info", label: `${showImageInfo ? "✓ " : ""}显示图片信息`, onClick: () => onShowImageInfoChange(!showImageInfo) },
                    { type: "divider" as const },
                    { key: "delete", danger: true, disabled: !selectedCount, icon: <Trash2 className="size-4" />, label: <span data-usage-control="canvas-tool.delete">删除选中</span>, onClick: onDelete },
                    { key: "clear", danger: true, icon: <Eraser className="size-4" />, label: <span data-usage-control="canvas-tool.clear">清空画布</span>, onClick: onClear },
                ].filter(item => !item.key || !canvasActionModules[item.key] || isModuleAvailable(flags, bindings, canvasActionModules[item.key]!)) }}><button data-usage-control="canvas-tool.more" type="button" className="cw-icon" aria-label="更多工具"><MoreHorizontal className="size-4" /></button></Dropdown>
                <span className="cw-divider" />
                <Tooltip title="撤销"><button data-usage-control="undo" type="button" className="cw-icon" aria-label="撤销" disabled={!canUndo} onClick={onUndo}><Undo2 className="size-4" /></button></Tooltip>
                <Tooltip title="重做"><button data-usage-control="redo" type="button" className="cw-icon" aria-label="重做" disabled={!canRedo} onClick={onRedo}><Redo2 className="size-4" /></button></Tooltip>
            </div>
            <div className="cw-tools">
                <Tooltip title="我的素材"><button data-usage-control="canvas-tool.assets" type="button" className="cw-icon" aria-label="我的素材" onClick={onOpenMyAssets}><FolderOpen className="size-4" /></button></Tooltip>
                {children}
            </div>
        </div>
    );
}, canvasToolbarPropsEqual);
