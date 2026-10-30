import { useUiText } from "@/lib/i18n";
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type DragEventHandler, type Ref } from "react";
import { ArrowLeft, ArrowRight, BookOpen, ImagePlus, LayoutTemplate, Play, X } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { createWorkspaceStorage } from "@/lib/workspace-storage";
import { canvasOnboardingAvailableArea, canvasOnboardingCardPosition, canvasOnboardingShouldYield, createCanvasOnboardingPreference, type CanvasOnboardingOutcome } from "@/lib/canvas/canvas-onboarding-state";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { useModuleEnabled } from "@/stores/use-module-store";

export type CanvasOnboardingHandle = { start: () => void };
type Props = {
    ref?: Ref<CanvasOnboardingHandle>;
    empty: boolean;
    onImportImage: () => void;
    onUseTemplate: () => void;
    onOpenExample: () => void;
    onOpenCreation: () => void;
    onCloseCreation?: () => void;
    onDrop?: DragEventHandler<HTMLDivElement>;
};
type Rect = { left: number; top: number; width: number; height: number };

const steps = [
    { title: "添加一张参考图", text: "将图片拖到画布，或点击高亮的上传按钮。原图会保留，之后的修改另存为新结果。", selectors: ['[data-usage-control="canvas-tool.upload"]'] },
    { title: "写清要求，再点击生成", text: "先选中参考图，在创建区说明要改什么、哪些细节不能变；确认模型和要求后再点生成。引导本身不会调用模型。", selectors: ['[data-testid="canvas-quick-generate-panel"]', '[data-usage-control="canvas-tool.more"]'] },
    { title: "连线与多图执行", text: "从素材节点右侧连接点拖到生成配置左侧。逐图执行会为每张任务图分别生成；合并参考让多图共同参与一次生成。在配置提示词输入 @ 选择已连接素材，并说明各图用途。", selectors: ['[data-canvas-connection-handle="right"]', '.node-element', '[data-usage-control="canvas-tool.more"]'] },
    { title: "对比原图和结果", text: "生成后选择原图与结果，在高亮的设计工具中打开“改款前后对比”，查看滑块、并排或叠加效果；满意后再下载。没有结果时可以先打开示例学习结构。", selectors: ['[data-usage-control="canvas-tool.design-tools"]', '.cw-toolbar-secondary'] },
] as const;

/** Non-modal guidance: real controls remain clickable and the canvas stays usable. */
export function CanvasOnboarding({ ref, empty, onImportImage, onUseTemplate, onOpenExample, onOpenCreation, onCloseCreation, onDrop }: Props) {
    const t = useUiText();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const ownerId = useUserStore(state => state.user?.id);
    const status = useUserStore(state => state.status);
    const localToolsEnabled = useModuleEnabled("canvas-local-tools");
    const storage = useMemo(() => createWorkspaceStorage("canvas_onboarding"), [ownerId, status]);
    const preferences = useMemo(() => createCanvasOnboardingPreference(storage), [storage]);
    const [open, setOpen] = useState(false);
    const [step, setStep] = useState(0);
    const [storageError, setStorageError] = useState("");
    const [target, setTarget] = useState<Rect | null>(null);
    const [position, setPosition] = useState({ left: 12, top: 96 });
    const [cardMaxHeight, setCardMaxHeight] = useState<number>();
    const [availableArea, setAvailableArea] = useState({ left: 0, width: 0 });
    const host = useRef<HTMLDivElement>(null);
    const card = useRef<HTMLDivElement>(null);
    const manuallyOpened = useRef(false);
    const previousFocus = useRef<HTMLElement | null>(null);
    const creationAction = useRef(onOpenCreation);
    const closeCreationAction = useRef(onCloseCreation);
    const ownsCreationPanel = useRef(false);
    creationAction.current = onOpenCreation;
    closeCreationAction.current = onCloseCreation;
    const start = () => {
        manuallyOpened.current = true;
        previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setStep(0);
        setOpen(true);
    };
    useImperativeHandle(ref, () => ({ start }));

    useEffect(() => {
        let active = true;
        setOpen(false);
        manuallyOpened.current = false;
        setStorageError("");
        void preferences.read().catch(() => {
            if (active) setStorageError("引导状态暂时无法读取；仍可手动查看，不影响画布。 ");
        });
        return () => { active = false; };
        // A new empty canvas must not replay a guide dismissed by this employee.
    }, [preferences, storage]);

    useLayoutEffect(() => {
        if (!canvasOnboardingShouldYield({ open, empty, manuallyOpened: manuallyOpened.current })) return;
        // Yield before paint so a newly opened node editor is never covered.
        // This is not completion, skipping, or a saved user preference. Leave
        // focus and any creation panel with the work the user has just started.
        ownsCreationPanel.current = false;
        setOpen(false);
    }, [empty, open]);

    const dismiss = (outcome: CanvasOnboardingOutcome) => {
        setOpen(false);
        previousFocus.current?.focus({ preventScroll: true });
        void preferences.save(outcome, step).then(() => setStorageError("")).catch(() => {
            setStorageError("未能保存引导状态，下次可能再次显示；当前画布不受影响。");
        });
    };

    useLayoutEffect(() => {
        if (open) return;
        const container = host.current?.parentElement;
        const workspace = host.current?.closest(".cw-workspace");
        if (!container || !workspace) return;
        let frame = 0;
        const watchedPanels = new Set<HTMLElement>();
        const measure = () => {
            frame = 0;
            const panelElements = [...workspace.querySelectorAll<HTMLElement>(".cw-create-panel, .cw-agent-panel, .cw-generator-mobile")];
            const panels = panelElements
                .filter(element => {
                    const style = getComputedStyle(element);
                    return !element.classList.contains("is-collapsed") && style.display !== "none" && style.visibility !== "hidden" && element.getBoundingClientRect().width > 0;
                }).map(element => element.getBoundingClientRect());
            const next = canvasOnboardingAvailableArea(container.getBoundingClientRect(), panels);
            setAvailableArea(current => current.left === next.left && current.width === next.width ? current : next);
            // Watch only panel layout, never thousands of node transforms during
            // a pan/drag. Panels may mount lazily or switch between desktop/mobile.
            observer.disconnect();
            observer.observe(workspace, { childList: true, attributes: true, attributeFilter: ["class", "style"] });
            observer.observe(container, { childList: true });
            for (const old of watchedPanels) if (!panelElements.includes(old)) { resize.unobserve(old); watchedPanels.delete(old); }
            for (const element of panelElements) {
                observer.observe(element, { childList: true, attributes: true, attributeFilter: ["class", "style"] });
                if (!watchedPanels.has(element)) { watchedPanels.add(element); resize.observe(element); }
            }
        };
        const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
        const observer = new MutationObserver(schedule);
        const resize = new ResizeObserver(schedule);
        resize.observe(container);
        window.addEventListener("resize", schedule);
        measure();
        return () => { cancelAnimationFrame(frame); observer.disconnect(); resize.disconnect(); window.removeEventListener("resize", schedule); };
    }, [open]);

    useEffect(() => {
        if (!open) return;
        if (step === 1) {
            const creationPanel = host.current?.closest(".cw-workspace")?.querySelector('[data-testid="canvas-quick-generate-panel"]');
            ownsCreationPanel.current = !creationPanel;
            creationAction.current();
        }
        card.current?.focus({ preventScroll: true });
        const workspace = host.current?.closest(".cw-workspace");
        if (!workspace) return;
        let frame = 0;
        const measure = () => {
            frame = 0;
            let rect: Rect | null = null;
            for (const selector of steps[step].selectors) {
                const elements = workspace.querySelectorAll<HTMLElement>(selector);
                for (const element of elements) {
                    const bounds = element.getBoundingClientRect();
                    const style = getComputedStyle(element);
                    if (bounds.width <= 0 || bounds.height <= 0 || style.visibility === "hidden" || style.opacity === "0" || bounds.right < 0 || bounds.bottom < 0 || bounds.left >= window.innerWidth || bounds.top >= window.innerHeight) continue;
                    const left = Math.max(4, bounds.left), top = Math.max(4, bounds.top);
                    rect = { left, top, width: Math.min(window.innerWidth - 4, bounds.right) - left, height: Math.min(window.innerHeight - 4, bounds.bottom) - top };
                    break;
                }
                if (rect) break;
            }
            setTarget(current => JSON.stringify(current) === JSON.stringify(rect) ? current : rect);
            // A non-modal tour must leave every persistent toolbar control
            // usable, including the buttons adjacent to the highlighted one.
            const visibleBounds = (selector: string) => [...workspace.querySelectorAll<HTMLElement>(selector)]
                .filter(element => {
                    const style = getComputedStyle(element);
                    return style.display !== "none" && style.visibility !== "hidden";
                }).map(element => element.getBoundingClientRect()).filter(bounds => bounds.width > 0 && bounds.height > 0);
            const usable = {
                top: Math.max(12, ...visibleBounds(".cw-topbar").map(bounds => bounds.bottom + 12)),
                bottom: Math.min(window.innerHeight - 12, ...visibleBounds(".cw-dock").map(bounds => bounds.top - 16)),
            };
            setCardMaxHeight(Math.max(0, usable.bottom - usable.top));
            const next = canvasOnboardingCardPosition(rect, { width: window.innerWidth, height: window.innerHeight }, { width: card.current?.offsetWidth || 360, height: card.current?.offsetHeight || 280 }, usable);
            setPosition(current => current.left === next.left && current.top === next.top ? current : next);
        };
        const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
        const observer = new MutationObserver(schedule);
        observer.observe(workspace, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
        const resize = new ResizeObserver(schedule);
        resize.observe(workspace);
        if (card.current) resize.observe(card.current);
        window.addEventListener("resize", schedule);
        window.addEventListener("scroll", schedule, true);
        schedule();
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect(); resize.disconnect();
            window.removeEventListener("resize", schedule);
            window.removeEventListener("scroll", schedule, true);
            if (ownsCreationPanel.current) { ownsCreationPanel.current = false; closeCreationAction.current?.(); }
        };
    }, [open, step]);

    const actionStyle = { background: theme.toolbar.itemHover, color: theme.node.text, borderColor: theme.toolbar.border };
    const compactEntries = availableArea.width < 580;
    return <div ref={host} data-canvas-onboarding-host>
        {empty && !open && availableArea.width > 0 ? <div className="pointer-events-none absolute inset-y-0 z-20 flex items-center justify-center px-4 pb-20 pt-28" style={{ left: availableArea.left, width: availableArea.width }}>
            <div className={`pointer-events-auto w-full max-w-[620px] rounded-xl border ${compactEntries ? "p-4" : "p-6"}`} style={{ background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
                data-testid="canvas-empty-start" onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
                onDragOver={event => { if (onDrop) event.preventDefault(); }} onDrop={onDrop}>
                <h2 className="text-xl font-semibold">{t("从一张参考图开始")}</h2>
                <p className="mt-2 text-sm" style={{ color: theme.node.muted }}>{t("上传素材、套用流程，或打开不会调用模型的示例。")}</p>
                <div className={`mt-5 grid gap-3 ${compactEntries ? "grid-cols-1" : "grid-cols-3"}`}>
                    {[{ title: t("拖入图片"), detail: "或点击选择本地图片", Icon: ImagePlus, action: onImportImage, disabled: false }, { title: t("用模板开始"), detail: "复用可编辑的款式流程", Icon: LayoutTemplate, action: onUseTemplate, disabled: !localToolsEnabled }, { title: t("打开示例画布"), detail: "学习参考图与配置连线", Icon: Play, action: onOpenExample, disabled: false }].map(item => <button key={item.title} type="button" className={`${compactEntries ? "grid min-h-16 grid-cols-[20px_1fr] gap-x-3 gap-y-1 px-3 py-2" : "flex min-h-28 flex-col gap-2 p-4"} items-start rounded-lg border text-left hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40`} style={actionStyle} disabled={item.disabled} onClick={item.action}>
                        <item.Icon className="size-5" aria-hidden /><span className="text-sm font-medium">{item.title}</span><span className={`text-xs ${compactEntries ? "col-start-2" : ""}`} style={{ color: theme.node.muted }}>{t(item.detail)}</span>
                    </button>)}
                </div>
                {!localToolsEnabled ? <p className="mt-2 text-xs" style={{ color: theme.node.muted }}>{t("当前工作区未启用服装模板工具。")}</p> : null}
                <button type="button" className="mt-4 inline-flex min-h-9 items-center gap-2 text-sm hover:underline" onClick={start}><BookOpen className="size-4" />{t("跟我走一遍")}</button>
                {storageError ? <p role="status" className="mt-1 text-xs">{storageError}</p> : null}
            </div>
        </div> : null}
        {!empty && !open && availableArea.width > 0 ? <div className="absolute bottom-[72px] z-40 max-w-[280px]" style={{ left: availableArea.left + 12, maxWidth: Math.max(0, availableArea.width - 24), color: theme.node.muted }}>
            <button type="button" className="inline-flex min-h-9 items-center gap-2 rounded-md px-2 text-xs hover:opacity-70" style={{ background: theme.node.panel }} onClick={start}><BookOpen className="size-4" aria-hidden />{t("新手引导")}</button>
            {storageError ? <p role="status" className="mt-1 text-xs">{storageError}</p> : null}
        </div> : null}
        {open ? <>
            {target ? <div data-testid="canvas-onboarding-highlight" className="pointer-events-none fixed z-[210] rounded-lg border-2" style={{ ...target, borderColor: theme.canvas.selectionStroke, boxShadow: `0 0 0 3px ${theme.toolbar.panel}` }} aria-hidden /> : null}
            <div ref={card} role="dialog" aria-modal="false" aria-labelledby="canvas-onboarding-title" tabIndex={-1} data-testid="canvas-onboarding-tour"
                className="fixed z-[220] w-[360px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border p-5 shadow-lg outline-none" style={{ ...position, maxHeight: cardMaxHeight ?? "calc(100dvh - 24px)", background: theme.node.panel, color: theme.node.text, borderColor: theme.node.stroke }}
                onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
                onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); dismiss("later"); } }}>
                <header className="flex items-center justify-between gap-3"><span className="text-xs" style={{ color: theme.node.muted }}>{t("快速上手 ·")}{step + 1} / 4</span><button type="button" aria-label={t("关闭引导，以后再看")} className="cw-icon" onClick={() => dismiss("later")}><X className="size-4" /></button></header>
                <h2 id="canvas-onboarding-title" className="mt-2 text-lg font-semibold">{t(steps[step].title)}</h2>
                <p className="mt-3 text-sm leading-6">{t(steps[step].text)}</p>
                {step === 2 && empty ? <p className="mt-2 text-xs leading-5" style={{ color: theme.node.muted }}>{t("当前还没有节点。先从高亮的“更多工具”添加生成配置，或关闭引导后打开示例画布。")}</p> : null}
                {!target ? <p className="mt-2 text-xs" style={{ color: theme.node.muted }}>{t("对应工具尚未显示；可以先关闭引导添加素材，再重新查看。")}</p> : null}
                <div className="mt-4 flex items-center justify-between gap-2">
                    <button type="button" className="rounded px-2 py-2 text-xs hover:opacity-70" onClick={() => dismiss("skipped")}>{t("跳过引导")}</button>
                    <div className="flex gap-2">{step > 0 ? <button type="button" aria-label={t("上一步")} className="cw-icon" onClick={() => setStep(value => value - 1)}><ArrowLeft className="size-4" /></button> : null}<button type="button" className="inline-flex min-h-9 items-center gap-2 rounded-md px-3 text-sm" style={{ background: "var(--cw-active)", color: "var(--cw-inverse)" }} onClick={() => step === 3 ? dismiss("completed") : setStep(value => value + 1)}>{step === 3 ? t("完成引导") : t("下一步")}<ArrowRight className="size-4" aria-hidden /></button></div>
                </div>
                <button type="button" className="mt-2 w-full py-1 text-center text-xs hover:underline" style={{ color: theme.node.muted }} onClick={() => dismiss("later")}>{t("以后再看 · 随时从“新手引导”打开")}</button>
            </div>
        </> : null}
    </div>;
}
