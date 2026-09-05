import type { ReactNode } from "react";
import { ChevronDown, Compass, Focus, HelpCircle } from "lucide-react";
import { memo, useRef, useState } from "react";
import { Button, Modal, Popover, Tooltip } from "antd";

import { canvasThemes } from "@/lib/canvas-theme";
import { MAX_CANVAS_ZOOM, MIN_CANVAS_ZOOM } from "@/lib/canvas/canvas-zoom";
import { useThemeStore } from "@/stores/use-theme-store";

type CanvasZoomControlsProps = {
    scale: number;
    onScaleChange: (scale: number) => void;
    onScalePreview?: (scale: number) => void;
    onReset: () => void;
    isMiniMapOpen: boolean;
    onToggleMiniMap: () => void;
};

export const CanvasZoomControls = memo(function CanvasZoomControls({ scale, onScaleChange, onScalePreview, onReset, isMiniMapOpen, onToggleMiniMap }: CanvasZoomControlsProps) {
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [previewScale, setPreviewScale] = useState<number | null>(null);
    const isPointerAdjustingRef = useRef(false);
    const previewScaleRef = useRef<number | null>(null);
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const dockStyle = { background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item, boxShadow: colorTheme === "dark" ? "0 18px 45px rgba(0,0,0,.32)" : "0 16px 40px rgba(28,25,23,.12)" };
    const activeStyle = { background: theme.toolbar.activeBg, color: theme.toolbar.activeText };
    const displayedScale = previewScale ?? scale;

    const beginScaleAdjustment = () => {
        isPointerAdjustingRef.current = true;
        previewScaleRef.current = scale;
        setPreviewScale(scale);
    };

    const previewOrCommitScale = (nextScale: number) => {
        if (!isPointerAdjustingRef.current || !onScalePreview) {
            onScaleChange(nextScale);
            return;
        }
        previewScaleRef.current = nextScale;
        setPreviewScale(nextScale);
        onScalePreview(nextScale);
    };

    const finishScaleAdjustment = () => {
        if (!isPointerAdjustingRef.current) return;
        isPointerAdjustingRef.current = false;
        const nextScale = previewScaleRef.current;
        previewScaleRef.current = null;
        setPreviewScale(null);
        if (nextScale !== null) onScaleChange(nextScale);
    };

    return (
        <div className="flex items-center" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <div className="flex items-center gap-1">
                <Tooltip title={isMiniMapOpen ? "关闭小地图" : "打开小地图"}>
                    <Button
                        type="text"
                        className="!h-8 !w-8 !min-w-8 !p-0"
                        style={isMiniMapOpen ? activeStyle : { color: theme.toolbar.item }}
                        icon={<Compass className="size-4" />}
                        onClick={onToggleMiniMap}
                        aria-label={isMiniMapOpen ? "关闭小地图" : "打开小地图"}
                    />
                </Tooltip>
                <Popover trigger="click" placement="top" content={<div className="cw-zoom-popover">
                    <Button type="text" icon={<Focus className="size-4" />} onClick={onReset}>重置视图</Button>
                    <input
                        type="range"
                        min={MIN_CANVAS_ZOOM * 100}
                        max={MAX_CANVAS_ZOOM * 100}
                        step="1"
                        value={Math.round(displayedScale * 100)}
                        className="w-24"
                        style={{ accentColor: theme.node.activeStroke }}
                        onPointerDown={beginScaleAdjustment}
                        onPointerUp={finishScaleAdjustment}
                        onPointerCancel={finishScaleAdjustment}
                        onBlur={finishScaleAdjustment}
                        onChange={(event) => previewOrCommitScale(Number(event.target.value) / 100)}
                        aria-label="放大/缩小画布"
                    />
                    <div className="flex gap-1">{[.5, 1, 2].map((value) => <Button key={value} size="small" onClick={() => onScaleChange(value)}>{value * 100}%</Button>)}</div>
                </div>}>
                    <button type="button" className="cw-zoom-trigger" aria-label="画布缩放">{Math.round(displayedScale * 100)}%<ChevronDown className="size-3" /></button>
                </Popover>
                <Tooltip title="快捷键">
                    <Button type="text" className="!h-8 !w-8 !min-w-8 !p-0" style={shortcutsOpen ? activeStyle : { color: theme.toolbar.item }} icon={<HelpCircle className="size-4" />} onClick={() => setShortcutsOpen(true)} aria-label="快捷键" />
                </Tooltip>
            </div>
            <Modal title="快捷键" open={shortcutsOpen} onCancel={() => setShortcutsOpen(false)} footer={null} centered>
                <div className="space-y-3 border-t pt-4 text-sm" style={{ borderColor: theme.node.stroke }}>
                    <Shortcut label="拖动画布" value="平移视图" />
                    <Shortcut label="滚轮" value="缩放画布" />
                    <Shortcut label="Ctrl / Cmd + 拖动" value="框选多个节点" />
                    <Shortcut label="Shift / Ctrl / Cmd + 点击" value="追加选择节点" />
                    <Shortcut label="Ctrl / Cmd + C / V" value="复制 / 粘贴节点" />
                    <Shortcut label="Delete / Backspace" value="删除选中" />
                </div>
            </Modal>
        </div>
    );
});

function Shortcut({ label, value }: { label: ReactNode; value: string }) {
    return (
        <div className="flex items-center justify-between gap-4">
            <span className="text-base font-medium">{label}</span>
            <span className="opacity-60">{value}</span>
        </div>
    );
}
