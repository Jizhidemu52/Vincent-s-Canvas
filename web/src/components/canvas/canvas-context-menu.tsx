import { canvasActionLabel, canvasActionShortcut, type CanvasActionId } from "@/lib/canvas/canvas-actions";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Copy, Download, FolderPlus, PencilLine, Plus, Trash2, Upload } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useModuleEnabled } from "@/stores/use-module-store";
import type { ContextMenuState } from "@/types/canvas";

type CanvasContextMenuProps = {
    menu: ContextMenuState;
    targetCount?: number;
    imageCount?: number;
    onDownloadImages?: () => void;
    onClose: () => void;
    onDuplicate: () => void;
    onDelete: () => void;
    onUpload?: () => void;
    onGenerate?: () => void;
    onRename?: () => void;
    onGroup?: () => void;
};

export function canvasContextMenuPosition(x: number, y: number, width: number, height: number, viewport: { width: number; height: number }) {
    const margin = 8;
    const fittedWidth = Math.min(width, Math.max(0, viewport.width - margin * 2));
    const fittedHeight = Math.min(height, Math.max(0, viewport.height - margin * 2));
    return { left: Math.max(margin, Math.min(x, viewport.width - fittedWidth - margin)), top: Math.max(margin, Math.min(y, viewport.height - fittedHeight - margin)), width: fittedWidth, maxHeight: Math.max(0, viewport.height - margin * 2) };
}

export function CanvasNodeContextMenu({ menu, targetCount = 1, imageCount = 0, onDownloadImages, onClose, onDuplicate, onDelete, onUpload, onGenerate, onRename, onGroup }: CanvasContextMenuProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const canGenerate = useModuleEnabled("canvas-image");
    const menuRef = useRef<HTMLDivElement>(null);
    const previousFocusRef = useRef<HTMLElement | null>(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    const restoreFocusRef = useRef(true);
    const isMultiTarget = menu.type === "node" && targetCount > 1;
    const canRename = menu.type === "node" && !isMultiTarget && Boolean(onRename);
    const canDownload = menu.type === "node" && imageCount > 0 && Boolean(onDownloadImages);
    const itemCount = menu.type === "canvas" ? Number(Boolean(onUpload)) + Number(Boolean(onGroup)) + Number(canGenerate && Boolean(onGenerate))
        : (menu.type === "node" ? 2 + Number(canRename) + Number(canDownload) : 1) + Number(Boolean(onGroup));
    const [position, setPosition] = useState(() => canvasContextMenuPosition(menu.x, menu.y, 300, 10 + itemCount * 32 + Math.max(0, itemCount - 1) * 4, { width: window.innerWidth, height: window.innerHeight }));

    useLayoutEffect(() => {
        if (!previousFocusRef.current && document.activeElement instanceof HTMLElement && !menuRef.current?.contains(document.activeElement)) previousFocusRef.current = document.activeElement;
        const positionMenu = () => {
            const element = menuRef.current;
            if (!element) return;
            setPosition(canvasContextMenuPosition(menu.x, menu.y, 220, element.scrollHeight + 2, { width: window.innerWidth, height: window.innerHeight }));
        };
        positionMenu();
        menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
        window.addEventListener("resize", positionMenu);
        return () => window.removeEventListener("resize", positionMenu);
    }, [menu.x, menu.y, itemCount]);

    useEffect(() => {
        // Preserve a meaningful trigger. Outside pointer actions should keep their own focus.
        const focusReturn = previousFocusRef.current;
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest(".ant-popover")) return;
            if (target instanceof Node && menuRef.current?.contains(target)) return;
            restoreFocusRef.current = false;
            closeRef.current();
        };
        const escape = (event: globalThis.KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault(); event.stopPropagation(); closeRef.current();
        };
        window.addEventListener("pointerdown", close);
        window.addEventListener("keydown", escape);
        return () => {
            window.removeEventListener("pointerdown", close);
            window.removeEventListener("keydown", escape);
            if (restoreFocusRef.current && focusReturn?.isConnected && (document.activeElement === document.body || menuRef.current?.contains(document.activeElement))) focusReturn.focus({ preventScroll: true });
        };
    }, []);

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
        if (event.key === "Enter" || event.key === " ") { event.stopPropagation(); return; }
        if (event.key === "Tab") { restoreFocusRef.current = false; closeRef.current(); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
        if (!buttons.length) return;
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        event.preventDefault(); event.stopPropagation(); buttons[next]?.focus();
    };
    const choose = (action: () => void) => { action(); closeRef.current(); };

    return (
        <div
            ref={menuRef} role="menu" aria-label={menu.type === "canvas" ? "画布操作" : "节点操作"} data-canvas-no-zoom
            className="fixed z-[80] flex flex-col gap-1 overflow-y-auto rounded-[10px] border p-1"
            style={{ ...position, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text, boxShadow: "0 4px 16px rgb(0 0 0 / .10)", fontFamily: "'Geist Variable', 'PingFang SC', 'Microsoft YaHei', sans-serif" }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={event => event.stopPropagation()}
            onContextMenu={event => event.preventDefault()}
            onKeyDown={onKeyDown}
        >
            {menu.type === "canvas" && onUpload ? <MenuButton icon={<Upload className="size-4" />} action="upload" onClick={() => choose(onUpload)} /> : null}
            {menu.type === "node" ? <MenuButton icon={<Copy className="size-4" />} action="duplicate" targetCount={targetCount} onClick={() => choose(onDuplicate)} /> : null}
            {canDownload && onDownloadImages ? <MenuButton icon={<Download className="size-4" />} action="downloadSelectedImages" targetCount={imageCount} onClick={() => choose(onDownloadImages)} /> : null}
            {canRename && onRename ? <MenuButton icon={<PencilLine className="size-4" />} action="rename" onClick={() => choose(onRename)} /> : null}
            {onGroup ? <MenuButton icon={<FolderPlus className="size-4" />} action="group" onClick={() => choose(onGroup)} /> : null}
            {menu.type === "canvas" ? canGenerate && onGenerate && <MenuButton icon={<Plus className="size-4" />} action="generate" onClick={() => choose(onGenerate)} /> : <MenuButton icon={<Trash2 className="size-4" />} action="delete" targetCount={isMultiTarget ? targetCount : 1} onClick={() => choose(onDelete)} />}
        </div>
    );
}

export function MenuButton({ icon, action, targetCount = 1, onClick }: { icon: ReactNode; action: CanvasActionId; targetCount?: number; onClick: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <button role="menuitem" data-usage-control={`canvas-tool.${action}`} type="button" className="flex h-8 min-h-8 w-full shrink-0 items-center gap-2.5 rounded-md px-2 text-left text-xs outline-none"
            style={{ color: theme.node.text }} onMouseEnter={event => { event.currentTarget.style.background = theme.toolbar.itemHover; }} onMouseLeave={event => { if (document.activeElement !== event.currentTarget) event.currentTarget.style.background = "transparent"; }}
            onFocus={event => { event.currentTarget.style.background = theme.toolbar.itemHover; }} onBlur={event => { event.currentTarget.style.background = "transparent"; }}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); onClick(); }}>
            {icon}
            <span>{canvasActionLabel(action, "context", targetCount)}</span><span className="ml-auto text-[10px] opacity-50">{canvasActionShortcut(action)}</span>
        </button>
    );
}
