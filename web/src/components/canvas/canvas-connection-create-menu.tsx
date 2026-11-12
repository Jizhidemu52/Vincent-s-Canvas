import { useUiText } from "@/lib/i18n";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ImageIcon, List, Music2, Settings2, Video } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasGraphStore } from "@/stores/canvas/canvas-graph-store";
import { canvasConnectionCreateOptions, canvasConnectionMenuPosition, type ConnectionCreateNodeType } from "@/lib/canvas/canvas-connection-create-options";
import { CanvasNodeType, type ConnectionHandle, type Position } from "@/types/canvas";

export function ConnectionCreateMenu({
    pending,
    onCreate,
    onClose,
}: {
    pending: { position: Position; connection: ConnectionHandle };
    onCreate: (type: ConnectionCreateNodeType) => void;
    onClose: () => void;
}) {
    const t = useUiText();
    const canvasThemeKey = useThemeStore((state) => state.theme);
    const theme = canvasThemes[canvasThemeKey];
    const sourceNode = useCanvasGraphStore(state => state.nodeById.get(pending.connection.nodeId));
    const options = canvasConnectionCreateOptions(sourceNode, pending.connection.handleType);
    const icons = { [CanvasNodeType.Text]: List, [CanvasNodeType.Image]: ImageIcon, [CanvasNodeType.Video]: Video, [CanvasNodeType.Audio]: Music2, [CanvasNodeType.Config]: Settings2 };
    const anchorRef = useRef<HTMLSpanElement>(null), menuRef = useRef<HTMLDivElement>(null);
    const closeRef = useRef(onClose); closeRef.current = onClose;
    const [position, setPosition] = useState(() => canvasConnectionMenuPosition({ x: 8, y: 8 }, 0, { width: window.innerWidth, height: window.innerHeight }));
    useLayoutEffect(() => {
        const measure = () => {
            const anchor = anchorRef.current?.getBoundingClientRect(), menu = menuRef.current;
            if (!anchor || !menu) return;
            setPosition(canvasConnectionMenuPosition({ x: anchor.left, y: anchor.top }, menu.scrollHeight + 2, { width: window.innerWidth, height: window.innerHeight }));
        };
        measure();
        const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : undefined;
        if (menuRef.current) observer?.observe(menuRef.current);
        window.addEventListener("resize", measure);
        return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
    }, [pending.position.x, pending.position.y, options.length, pending.connection.handleType]);
    useEffect(() => {
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
        const outside = (event: PointerEvent) => { if (event.target instanceof Node && !menuRef.current?.contains(event.target)) closeRef.current(); };
        const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); closeRef.current(); } };
        window.addEventListener("pointerdown", outside); window.addEventListener("keydown", escape);
        return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); if (previous?.isConnected && document.activeElement === document.body) previous.focus({ preventScroll: true }); };
    }, []);
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        event.stopPropagation();
        if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); onClose(); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
        if (!buttons.length) return;
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        event.preventDefault(); buttons[next]?.focus();
    };
    return <><span ref={anchorRef} aria-hidden className="pointer-events-none absolute size-0" style={{ left: pending.position.x, top: pending.position.y }} />{createPortal(
        <div
            ref={menuRef} role="menu" aria-label={t(pending.connection.handleType === "target" ? "连接上游输入" : "连接下一步")}
            className="fixed z-[var(--cw-z-popover,900)] overflow-y-auto rounded-xl border p-3 backdrop-blur"
            data-connection-create-menu data-canvas-no-zoom
            style={{ ...position, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text, boxShadow: "var(--ui-shadow-popover)" }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            onKeyDown={onKeyDown}
        >
            <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-sm font-medium" style={{ color: theme.node.muted }}>
                    {t(pending.connection.handleType === "target" ? "连接上游输入" : "连接下一步")}</span>
                <button type="button" className="cw-control grid size-8 place-items-center rounded-lg text-base opacity-55 hover:bg-muted hover:opacity-100" onClick={onClose} aria-label={t("关闭")}>
                    ×
                </button>
            </div>
            <div className="grid gap-1">
                {options.map(option => { const Icon = icons[option.type]; return <ConnectionCreateOption key={option.type} theme={theme} icon={<Icon className="size-5" />} title={t(option.title)} description={t(option.relationship)} onClick={() => onCreate(option.type)} />; })}
                {!options.length ? <p className="px-1 py-3 text-sm" style={{ color: theme.node.muted }}>{t("原节点已不可用，请关闭后重新拉线。")}</p> : null}
            </div>
        </div>, document.body)}</>;
}

function ConnectionCreateOption({ theme, icon, title, description, onClick }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; icon: ReactNode; title: string; description?: string; onClick?: () => void }) {
    return (
        <button
            type="button"
            role="menuitem"
            className="cw-control flex h-16 w-full cursor-pointer items-center gap-3 rounded-xl px-3 text-left"
            style={{ color: theme.node.text }}
            onClick={onClick}
            onMouseEnter={(event) => (event.currentTarget.style.background = theme.node.fill)}
            onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
        >
            <span className="grid size-11 shrink-0 place-items-center rounded-xl" style={{ background: theme.node.fill, color: theme.node.muted }}>
                {icon}
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-base font-semibold leading-5">{title}</span>
                {description ? (
                    <span className="mt-1 block truncate text-sm" style={{ color: theme.node.muted }}>
                        {description}
                    </span>
                ) : null}
            </span>
        </button>
    );
}
