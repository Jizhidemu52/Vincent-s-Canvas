import { Scissors, ScanLine, PenTool, LoaderCircle } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useState, type CSSProperties } from "react";
import { uiText, useUiText } from "@/lib/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import { useToolEnabled } from "@/hooks/use-tool-config";
import { useCanvasGraphStore } from "@/stores/canvas/canvas-graph-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { quickImageTitle, type QuickImageAction } from "@/lib/quick-image-tools";
import type { CanvasNodeData } from "@/types/canvas";
import { hasCanvasImageSource, hasPendingCanvasImageAction } from "@/lib/canvas/canvas-image-source";

const canvasImageTools = [
    { action: "remove-background", Icon: Scissors },
    { action: "hd-upscale", Icon: ScanLine },
    { action: "vectorize", Icon: PenTool },
] as const;

export function CanvasImageQuickActions({ node, onRun, embedded = false }: { node: CanvasNodeData; embedded?:boolean; onRun: (node: CanvasNodeData, action: QuickImageAction) => Promise<void> }) {
    useUiText();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const enabled = useToolEnabled("canvas-edit");
    const pending = useCanvasGraphStore(useShallow(state => canvasImageTools.filter(({ action }) => hasPendingCanvasImageAction(state.nodes, node.id, action)).map(tool => tool.action)));
    const [mobileOpen, setMobileOpen] = useState(false);
    const awaitingSource = Boolean(node.metadata?.imageTask || node.metadata?.status === "loading");
    const unavailable = !enabled || awaitingSource || !hasCanvasImageSource(node.metadata);
    const Container = embedded ? "section" : "aside";
    return <Container aria-label={uiText("图片快捷处理")} data-testid="canvas-image-quick-actions" className={embedded ? undefined : "absolute right-3 top-[76px] z-30 w-[232px] max-w-[calc(100%-24px)] rounded-xl border p-3 max-sm:top-20 max-sm:w-[192px]"} style={embedded ? undefined : { background: theme.toolbar.panel, color: theme.node.text, borderColor: theme.toolbar.border }} onPointerDown={event => event.stopPropagation()}>
        {!embedded && <button type="button" className="cw-mobile-image-actions" aria-expanded={mobileOpen} onClick={() => setMobileOpen(open => !open)}>{uiText("图片快捷处理")}</button>}
        <div className="cw-image-actions-body" data-expanded={embedded || mobileOpen}>
        <div className="mb-3 flex items-center justify-between gap-2 text-xs"><strong>{uiText("图片")}</strong><span style={{ color: theme.node.muted }}>{node.metadata?.naturalWidth || Math.round(node.width)} × {node.metadata?.naturalHeight || Math.round(node.height)}</span></div>
        <div className="space-y-1">
            {canvasImageTools.map(({ action, Icon }) => {
                const running = pending.includes(action);
                const disabled = unavailable || running;
                return <button key={action} type="button" disabled={disabled} onClick={() => void onRun(node, action)} style={{ color: disabled ? theme.node.muted : theme.node.text, outlineColor: theme.canvas.selectionStroke, "--quick-image-hover": theme.toolbar.itemHover } as CSSProperties} className="flex min-h-11 w-full items-center gap-3 rounded-md px-2 text-left text-sm transition-colors enabled:hover:bg-[var(--quick-image-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed">
                    {running ? <LoaderCircle className="size-4 shrink-0 animate-spin" /> : <Icon className="size-4 shrink-0" />}<span>{uiText(quickImageTitle(action))}</span>
                </button>;
            })}
        </div>
        {!enabled || awaitingSource ? <p className="mb-0 mt-3 text-xs leading-5" style={{ color: theme.node.muted }}>{uiText(!enabled ? "当前图片编辑功能已停用" : "此图正在生成，可选择其他原图继续处理。")}</p> : null}
        </div>
    </Container>;
}
