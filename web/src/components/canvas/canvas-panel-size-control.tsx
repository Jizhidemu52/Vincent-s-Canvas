import { Tooltip } from "antd";
import { useUiText } from "@/lib/i18n";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Popover } from "radix-ui";
import { Scaling } from "lucide-react";
import { canvasDiscussionFontSize, canvasPanelWidths, canvasPromptHeight, clampCanvasDiscussionFontSize, clampCanvasPanelWidth, clampCanvasPromptHeight, type CanvasPanelKind } from "@/lib/canvas/canvas-panel-width";
import { useCanvasPanelStore } from "@/stores/canvas/use-canvas-panel-store";
import { useCanvasDesktopLayout } from "@/hooks/use-canvas-desktop-layout";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export { CanvasPanelResizeHandle } from "./canvas-panel-resize-handle";

export function CanvasPanelSizeControl({ kind, disabled = false }: { kind: CanvasPanelKind; disabled?: boolean }) {
    const t = useUiText();
    const width = useCanvasPanelStore(state => state[`${kind}Width`]);
    const height = useCanvasPanelStore(state => state.promptHeight);
    const fontSize = useCanvasPanelStore(state => state.discussionFontSize);
    const setWidth = useCanvasPanelStore(state => state.setWidth);
    const setHeight = useCanvasPanelStore(state => state.setPromptHeight);
    const setFontSize = useCanvasPanelStore(state => state.setDiscussionFontSize);
    const desktop = useCanvasDesktopLayout();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const trigger = useRef<HTMLButtonElement>(null);
    const [effectiveWidth, setEffectiveWidth] = useState(width);
    useLayoutEffect(() => {
        const panel = trigger.current?.closest(".cw-create-panel, .cw-agent-panel, .studio-panel");
        if (!panel) return;
        const update = () => setEffectiveWidth(Math.round(panel.getBoundingClientRect().width));
        const observer = new ResizeObserver(update); observer.observe(panel); update();
        return () => observer.disconnect();
    }, [desktop, kind, width]);
    if (!desktop && kind !== "discussion") return null;
    const limits = canvasPanelWidths[kind];
    const discussion = kind === "discussion";
    const style = { "--cw-panel": theme.node.panel, "--cw-text": theme.node.text, "--cw-muted": theme.node.muted, "--cw-border": theme.node.stroke, "--cw-soft": theme.toolbar.itemHover } as CSSProperties;
    return <Popover.Root>
        <Tooltip title={t(discussion ? "调整设计讨论显示" : "调整面板大小")}><Popover.Trigger asChild><button ref={trigger} type="button" disabled={disabled} className="cw-panel-size-button" aria-label={t(discussion ? "调整设计讨论显示" : "调整面板大小")}><Scaling size={18} /><span>{t(discussion ? "显示设置" : "面板尺寸")}</span></button></Popover.Trigger></Tooltip>
        <Popover.Portal><Popover.Content side="bottom" align="end" sideOffset={10} collisionPadding={12} className="cw-panel-size-popover" style={style} aria-label={t(discussion ? "设计讨论显示设置" : "面板大小")} data-canvas-no-zoom
            onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
            <header><strong>{t(discussion ? "设计讨论显示" : "面板大小")}</strong><Popover.Close asChild><button type="button" aria-label={t("关闭面板大小设置")}>{t("完成")}</button></Popover.Close></header>
            {discussion && <label><span>{t("讨论字号")}<output>{clampCanvasDiscussionFontSize(fontSize)} px</output></span><input type="range" aria-label={t("讨论字号")} min={canvasDiscussionFontSize.min} max={canvasDiscussionFontSize.max} step={1} value={clampCanvasDiscussionFontSize(fontSize)} onChange={event => setFontSize(Number(event.target.value))} /></label>}
            {desktop && <label><span>{t("当前面板宽度")}<output>{effectiveWidth} px</output></span><input type="range" aria-label={t("面板宽度")} min={limits.min} max={limits.max} step={10} value={clampCanvasPanelWidth(kind, width)} onChange={event => setWidth(kind, Number(event.target.value))} /></label>}
            {desktop && effectiveWidth < clampCanvasPanelWidth(kind, width) ? <p className="text-xs" role="status">{t("已保存 {width}px；当前窗口限制为 {actual}px。", { width: clampCanvasPanelWidth(kind, width), actual: effectiveWidth })}</p> : null}
            {kind === "create" ? <label><span>{t("输入区高度")}<output>{clampCanvasPromptHeight(height)} px</output></span><input type="range" aria-label={t("输入区高度")} min={canvasPromptHeight.min} max={canvasPromptHeight.max} step={10} value={clampCanvasPromptHeight(height)} onChange={event => setHeight(Number(event.target.value))} /></label> : null}
            {desktop && <div className="cw-panel-size-presets">{[{ name: "紧凑", width: Math.max(360, limits.min) }, { name: "舒适", width: 480 }, { name: "宽敞", width: 600 }].map(preset => <button type="button" key={preset.name} aria-pressed={width === preset.width} onClick={() => setWidth(kind, preset.width)}>{t(preset.name)}</button>)}</div>}
            <footer><span>{t(discussion ? "仅调整显示，不会重新生成" : "也可拖动面板右边缘调整")}</span><button type="button" onClick={() => { setWidth(kind, limits.default); if (kind === "create") setHeight(canvasPromptHeight.default); if (discussion) setFontSize(canvasDiscussionFontSize.default); }}>{t("恢复默认")}</button></footer>
        </Popover.Content></Popover.Portal>
    </Popover.Root>;
}
