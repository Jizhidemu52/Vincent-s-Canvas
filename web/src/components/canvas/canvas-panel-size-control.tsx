import { useUiText } from "@/lib/i18n";
import type { CSSProperties } from "react";
import { Popover } from "radix-ui";
import { Scaling } from "lucide-react";
import { canvasPanelWidths, canvasPromptHeight, clampCanvasPanelWidth, clampCanvasPromptHeight, type CanvasPanelKind } from "@/lib/canvas/canvas-panel-width";
import { useCanvasPanelStore } from "@/stores/canvas/use-canvas-panel-store";
import { useCanvasDesktopLayout } from "@/hooks/use-canvas-desktop-layout";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export { CanvasPanelResizeHandle } from "./canvas-panel-resize-handle";

export function CanvasPanelSizeControl({ kind }: { kind: CanvasPanelKind }) {
    const t = useUiText();
    const width = useCanvasPanelStore(state => kind === "create" ? state.createWidth : state.chatWidth);
    const height = useCanvasPanelStore(state => state.promptHeight);
    const setWidth = useCanvasPanelStore(state => state.setWidth);
    const setHeight = useCanvasPanelStore(state => state.setPromptHeight);
    const desktop = useCanvasDesktopLayout();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    if (!desktop) return null;
    const limits = canvasPanelWidths[kind];
    const style = { "--cw-panel": theme.node.panel, "--cw-text": theme.node.text, "--cw-muted": theme.node.muted, "--cw-border": theme.node.stroke, "--cw-soft": theme.toolbar.itemHover } as CSSProperties;
    return <Popover.Root>
        <Popover.Trigger asChild><button type="button" className="cw-panel-size-button" aria-label={t("调整面板大小")} title={t("调整面板大小")}><Scaling size={18} /><span>{t("面板尺寸")}</span></button></Popover.Trigger>
        <Popover.Portal><Popover.Content side="bottom" align="end" sideOffset={10} collisionPadding={12} className="cw-panel-size-popover" style={style} data-canvas-no-zoom
            onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
            <header><strong>{t("面板大小")}</strong><Popover.Close asChild><button type="button" aria-label={t("关闭面板大小设置")}>{t("完成")}</button></Popover.Close></header>
            <label><span>{t("面板宽度")}<output>{clampCanvasPanelWidth(kind, width)} px</output></span><input type="range" aria-label={t("面板宽度")} min={limits.min} max={limits.max} step={10} value={clampCanvasPanelWidth(kind, width)} onChange={event => setWidth(kind, Number(event.target.value))} /></label>
            {kind === "create" ? <label><span>{t("输入区高度")}<output>{clampCanvasPromptHeight(height)} px</output></span><input type="range" aria-label={t("输入区高度")} min={canvasPromptHeight.min} max={canvasPromptHeight.max} step={10} value={clampCanvasPromptHeight(height)} onChange={event => setHeight(Number(event.target.value))} /></label> : null}
            <div className="cw-panel-size-presets">{[{ name: "紧凑", width: 360 }, { name: "舒适", width: 480 }, { name: "宽敞", width: 600 }].map(preset => <button type="button" key={preset.name} aria-pressed={width === preset.width} onClick={() => setWidth(kind, preset.width)}>{t(preset.name)}</button>)}</div>
            <footer><span>{t("也可拖动面板右边缘调整")}</span><button type="button" onClick={() => { setWidth(kind, limits.default); if (kind === "create") setHeight(canvasPromptHeight.default); }}>{t("恢复默认")}</button></footer>
        </Popover.Content></Popover.Portal>
    </Popover.Root>;
}
