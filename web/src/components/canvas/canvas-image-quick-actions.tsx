import { Scissors, ScanLine, LoaderCircle } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { uiText, useUiText } from "@/lib/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import { useToolEnabled } from "@/hooks/use-tool-config";
import { useCanvasGraphStore } from "@/stores/canvas/canvas-graph-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { quickImageTitle, type QuickImageAction } from "@/lib/quick-image-tools";
import type { CanvasNodeData } from "@/types/canvas";

/** Image selection actions stay on the right, separate from the creation rail. */
export function CanvasImageQuickActions({ node, onRun }: { node: CanvasNodeData; onRun: (node: CanvasNodeData, action: QuickImageAction) => Promise<void> }) {
    useUiText();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const enabled = useToolEnabled("canvas-edit");
    const pending = useCanvasGraphStore(state => state.nodes.some(item => item.metadata?.quickImageAction && item.metadata?.generationRecord?.sourceNodeId === node.id && (item.metadata.imageTask || item.metadata.status === "loading")));
    const [running, setRunning] = useState<QuickImageAction>();
    const busy = Boolean(running || pending || node.metadata?.imageTask || node.metadata?.status === "loading");
    const disabled = !enabled || busy || !(node.metadata?.content || node.metadata?.storageKey);
    const run = async (action: QuickImageAction) => { if (disabled) return; setRunning(action); try { await onRun(node, action); } finally { setRunning(undefined); } };
    return <aside aria-label={uiText("图片快捷处理")} data-testid="canvas-image-quick-actions" className="absolute right-3 top-[76px] z-30 w-[232px] max-w-[calc(100%-24px)] rounded-xl border p-3 max-sm:top-20 max-sm:w-[192px]" style={{ background: theme.toolbar.panel, color: theme.node.text, borderColor: theme.toolbar.border }} onPointerDown={event => event.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between gap-2 text-xs"><strong>{uiText("图片")}</strong><span style={{ color: theme.node.muted }}>{node.metadata?.naturalWidth || Math.round(node.width)} × {node.metadata?.naturalHeight || Math.round(node.height)}</span></div>
        <div className="space-y-1">
            {(["remove-background", "hd-upscale"] as const).map(action => { const Icon = action === "remove-background" ? Scissors : ScanLine; return <button key={action} type="button" disabled={disabled} onClick={() => void run(action)} style={{ color: disabled ? theme.node.muted : theme.node.text, outlineColor: theme.canvas.selectionStroke, "--quick-image-hover": theme.toolbar.itemHover } as CSSProperties} className="flex min-h-11 w-full items-center gap-3 rounded-md px-2 text-left text-sm transition-colors enabled:hover:bg-[var(--quick-image-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed">
                {running === action ? <LoaderCircle className="size-4 shrink-0 animate-spin" /> : <Icon className="size-4 shrink-0" />}<span>{uiText(quickImageTitle(action))}</span>
            </button>; })}
        </div>
        <p className="mb-0 mt-3 text-[11px] leading-5" style={{ color: theme.node.muted }}>{uiText(!enabled ? "当前图片编辑功能已停用" : busy ? "已有图片任务待完成，请先查看原任务" : "Nano 2.1 · 内置配方，结果另存新图片")}</p>
    </aside>;
}
