import { canvasActionHint, canvasActionLabel, type CanvasActionId } from "@/lib/canvas/canvas-actions";
import { canvasActionMenuItem } from "./canvas-action-menu-item";
import { memo } from "react";
import { Dropdown, Tooltip } from "antd";
import { Download, Eraser, FolderOpen, FolderPlus, Grid3X3, Hand, Image as ImageIcon, MoreHorizontal, MousePointer2, Music2, Redo2, Settings2, Sparkles, Trash2, Type, Undo2, Upload, Video, WandSparkles, type LucideIcon } from "lucide-react";
import { canvasToolbarPropsEqual, type CanvasToolbarRenderState } from "@/lib/canvas/canvas-toolbar-render-stability";
import { isModuleAvailable, useModuleEnabled, useModuleStore } from "@/stores/use-module-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { canvasActionModules } from "@/lib/canvas/tool-availability";
import "./canvas-toolbar.css";

export const CanvasToolbar = memo(function CanvasToolbar(props: CanvasToolbarRenderState) {
    const localToolsEnabled = useModuleEnabled("canvas-local-tools");
    const flags = useModuleStore(state => state.flags);
    const bindings = useBusinessConfigStore(state => state.tools);
    const { selectedCount, canUndo, canRedo, onAddImage, onAddVideo, onAddAudio, onAddText, onAddConfig, onOpenQuickGenerate, onOpenBatchEdit, onUndo, onRedo, onUpload, onDelete, onClear, onDeselect, onOpenMyAssets, onOpenTools, backgroundMode, showImageInfo, onBackgroundModeChange, onShowImageInfoChange, interactionMode = "select", onInteractionModeChange, children, viewControls } = props;
    return (
        <div data-testid="canvas-top-tool-rail" className="cw-dock">
            <div className="cw-tools cw-surface cw-toolbar-primary" role="group" aria-label="画布常用工具">
                {selectedCount > 1 && Boolean(props.selectedImageCount) && props.onDownloadSelection ? <>
                    <Tooltip title="仅打包选中的图片，默认保留原文件格式和画质"><button type="button" className="cw-icon cw-download-selection" data-usage-control="canvas-tool.downloadSelectedImages" onClick={props.onDownloadSelection}><Download className="size-4" /><span>{canvasActionLabel("downloadSelectedImages", "toolbar", props.selectedImageCount)}</span></button></Tooltip>
                    <span className="cw-divider" aria-hidden="true" />
                </> : null}
                <ActionButton action="select" icon={MousePointer2} pressed={interactionMode === "select"} onClick={() => onInteractionModeChange?.("select")} />
                <ActionButton action="pan" icon={Hand} pressed={interactionMode === "hand"} onClick={() => { onDeselect(); onInteractionModeChange?.("hand"); }} />
                <ActionButton action="upload" icon={Upload} onClick={onUpload} />
                <ActionButton action="text" icon={Type} onClick={onAddText} />
                <Dropdown trigger={["click"]} placement="topLeft" classNames={{ root: "cw-tool-menu" }} menu={{ items: [
                    canvasActionMenuItem("generate", onOpenQuickGenerate, <Sparkles className="size-4" />),
                    canvasActionMenuItem("config", onAddConfig, <Settings2 className="size-4" />),
                    canvasActionMenuItem("image", onAddImage, <ImageIcon className="size-4" />),
                    canvasActionMenuItem("video", onAddVideo, <Video className="size-4" />),
                    canvasActionMenuItem("audio", onAddAudio, <Music2 className="size-4" />),
                    canvasActionMenuItem("batch", onOpenBatchEdit, <WandSparkles className="size-4" />),
                    ...(localToolsEnabled && props.onGroupSelection ? [canvasActionMenuItem("group", props.onGroupSelection, <FolderPlus className="size-4" />, selectedCount < 2)] : []),
                    { type: "divider" as const },
                    { key: "background", label: <span data-usage-control="canvas-tool.background">画布背景</span>, children: (["dots", "lines", "blank"] as const).map((mode) => ({ key: mode, label: `${backgroundMode === mode ? "✓ " : ""}${canvasActionLabel(mode === "dots" ? "backgroundDots" : mode === "lines" ? "backgroundLines" : "backgroundBlank", "toolbar")}`, onClick: () => onBackgroundModeChange(mode) })) },
                    { key: "info", label: `${showImageInfo ? "✓ " : ""}${canvasActionLabel("imageInfo")}`, onClick: () => onShowImageInfoChange(!showImageInfo) },
                    { type: "divider" as const },
                    canvasActionMenuItem("delete", onDelete, <Trash2 className="size-4" />, !selectedCount),
                    canvasActionMenuItem("clear", onClear, <Eraser className="size-4" />),
                ].filter(item => !item.key || !canvasActionModules[item.key] || isModuleAvailable(flags, bindings, canvasActionModules[item.key]!)) }}><Tooltip title="更多工具"><button data-usage-control="canvas-tool.more" type="button" className="cw-icon" aria-label="更多工具" aria-haspopup="menu"><MoreHorizontal className="size-4" /></button></Tooltip></Dropdown>
                <span className="cw-divider" aria-hidden="true" />
                <ActionButton action="undo" icon={Undo2} disabled={!canUndo} onClick={onUndo} />
                <ActionButton action="redo" icon={Redo2} disabled={!canRedo} onClick={onRedo} />
                {viewControls ? <><span className="cw-divider" aria-hidden="true" />{viewControls}</> : null}
            </div>
            <div className="cw-tools cw-surface cw-toolbar-secondary" role="group" aria-label="工作台与设计工具">
                {onOpenTools ? <ActionButton action="tools" icon={Grid3X3} onClick={onOpenTools} /> : null}
                <ActionButton action="assets" icon={FolderOpen} onClick={onOpenMyAssets} />
                {children ? <span className="cw-divider" aria-hidden="true" /> : null}
                {children}
            </div>
        </div>
    );
}, canvasToolbarPropsEqual);

function ActionButton({ action, icon: Icon, pressed, disabled, onClick }: { action: CanvasActionId; icon: LucideIcon; pressed?: boolean; disabled?: boolean; onClick: () => void }) {
    const usage = action === "undo" || action === "redo" ? action : `canvas-tool.${action === "tools" ? "workspaces" : action}`;
    return <Tooltip title={canvasActionHint(action)}><button data-usage-control={usage} type="button" className="cw-icon" aria-label={canvasActionLabel(action, "toolbar")} aria-pressed={pressed} disabled={disabled} onClick={onClick}><Icon className="size-4" /></button></Tooltip>;
}
