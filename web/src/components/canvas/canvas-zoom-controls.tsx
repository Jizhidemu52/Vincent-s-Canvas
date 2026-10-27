import type { CSSProperties } from "react";
import { Check, ChevronDown, Compass, Focus, HelpCircle } from "lucide-react";
import { lazy, Suspense, memo, useRef, useState } from "react";
import { Popover } from "antd";

import { canvasThemes } from "@/lib/canvas-theme";
import { MAX_CANVAS_ZOOM, MIN_CANVAS_ZOOM } from "@/lib/canvas/canvas-zoom";
import { useThemeStore } from "@/stores/use-theme-store";
import { canvasActionLabel } from "@/lib/canvas/canvas-actions";
import "./canvas-toolbar.css";

const CanvasShortcutsDialog = lazy(() => import("./canvas-shortcuts-dialog").then(module => ({ default: module.CanvasShortcutsDialog })));

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
    const [viewMenuOpen, setViewMenuOpen] = useState(false);
    const [previewScale, setPreviewScale] = useState<number | null>(null);
    const isPointerAdjustingRef = useRef(false);
    const previewScaleRef = useRef<number | null>(null);
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const menuStyle = {
        "--cw-view-text": theme.node.text,
        "--cw-view-muted": theme.node.muted,
        "--cw-view-border": theme.toolbar.border,
        "--cw-view-hover": theme.toolbar.itemHover,
    } as CSSProperties;
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
        <div className="cw-zoom-controls" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                <Popover trigger="click" placement="topRight" arrow={false} open={viewMenuOpen} onOpenChange={open => { if (!open) finishScaleAdjustment(); setViewMenuOpen(open); }} styles={{ container: { background: theme.node.panel, border: `1px solid ${theme.toolbar.border}`, borderRadius: 12, padding: 6 } }} content={<div className="cw-view-menu" style={menuStyle}>
                    <div className="cw-view-heading"><span>画布缩放</span><span>{Math.round(displayedScale * 100)}%</span></div>
                    <input
                        type="range"
                        min={MIN_CANVAS_ZOOM * 100}
                        max={MAX_CANVAS_ZOOM * 100}
                        step="1"
                        value={Math.round(displayedScale * 100)}
                        onPointerDown={beginScaleAdjustment}
                        onPointerUp={finishScaleAdjustment}
                        onPointerCancel={finishScaleAdjustment}
                        onBlur={finishScaleAdjustment}
                        onChange={(event) => previewOrCommitScale(Number(event.target.value) / 100)}
                        aria-label="放大/缩小画布"
                    />
                    <div className="cw-view-presets">{[.25, .5, 1, 2].map(value => <button key={value} type="button" aria-pressed={Math.round(displayedScale * 100) === value * 100} onClick={() => onScaleChange(value)}>{value * 100}%</button>)}</div>
                    <div className="cw-view-separator" />
                    <button type="button" className="cw-view-action" onClick={() => { onReset(); setViewMenuOpen(false); }}><Focus size={16} strokeWidth={1.5} />{canvasActionLabel("resetView")}</button>
                    <button type="button" className="cw-view-action" aria-pressed={isMiniMapOpen} aria-label={isMiniMapOpen ? "关闭小地图" : "打开小地图"} onClick={onToggleMiniMap}><Compass size={16} strokeWidth={1.5} />{canvasActionLabel("minimap", "toolbar")}{isMiniMapOpen ? <Check size={14} /> : null}</button>
                    <div className="cw-view-separator" />
                    <button type="button" className="cw-view-action" onClick={() => { setViewMenuOpen(false); setShortcutsOpen(true); }}><HelpCircle size={16} strokeWidth={1.5} />{canvasActionLabel("shortcuts")}</button>
                </div>}>
                    <button type="button" className="cw-zoom-trigger" data-usage-control="canvas-tool.zoom" aria-label="画布缩放与视图" aria-expanded={viewMenuOpen} aria-haspopup="dialog">{Math.round(displayedScale * 100)}%<ChevronDown className="size-3" /></button>
                </Popover>
            {shortcutsOpen ? <Suspense fallback={null}><CanvasShortcutsDialog open onClose={() => setShortcutsOpen(false)} /></Suspense> : null}
        </div>
    );
});
