import { memo } from "react";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { canvasInspectorPanelPropsEqual } from "@/lib/canvas/canvas-floating-surface-render-stability";
import type { CanvasNodeData } from "@/types/canvas";

export const CanvasInspectorPanel = memo(function CanvasInspectorPanel({
    selectedNode,
    backgroundMode,
    showImageInfo,
    onBackgroundModeChange,
    onShowImageInfoChange,
}: {
    selectedNode: CanvasNodeData | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    onBackgroundModeChange: (mode: CanvasBackgroundMode) => void;
    onShowImageInfoChange: (value: boolean) => void;
}) {
    return (
        <aside className="cw-surface pointer-events-auto absolute right-4 top-[72px] z-40 w-[220px] overflow-hidden">
            <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--cw-border)" }}>
                <div className="text-xs font-semibold">{selectedNode?.title || "当前对象"}</div>
                <div className="mt-1 text-xs" style={{ color: "var(--cw-muted)" }}>{selectedNode ? `画布尺寸 ${Math.round(selectedNode.width)} × ${Math.round(selectedNode.height)}` : "画布设置"}</div>
            </div>
            <div className="space-y-3 p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                    <span style={{ color: "var(--cw-muted)" }}>画布背景</span>
                    <div className="flex rounded-md p-0.5" style={{ background: "var(--cw-soft)" }}>
                        {(["lines", "dots", "blank"] as CanvasBackgroundMode[]).map((mode) => <button key={mode} type="button" className="rounded px-2 py-1" aria-pressed={backgroundMode === mode} style={{ background: backgroundMode === mode ? "var(--cw-panel)" : "transparent", color: backgroundMode === mode ? "var(--cw-text)" : "var(--cw-muted)" }} onClick={() => onBackgroundModeChange(mode)}>{{ lines: "线", dots: "点", blank: "无" }[mode]}</button>)}
                    </div>
                </div>
                <label className="flex items-center justify-between"><span>显示素材信息</span><input type="checkbox" checked={showImageInfo} onChange={(event) => onShowImageInfoChange(event.target.checked)} /></label>
            </div>
        </aside>
    );
}, canvasInspectorPanelPropsEqual);
