import { useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent, type SyntheticEvent } from "react";
import { App } from "antd";
import { CanvasPersistedMediaPreview } from "@/components/canvas/canvas-persisted-media-preview";
import { conversationImageLabel, type ConversationImageItem } from "@/components/conversation-image-controls";
import { canvasThemes } from "@/lib/canvas-theme";
import { filterMentionImages, imageMentionAt, insertImageMention, type ImageMentionToken } from "@/lib/conversation-image-mention";
import { useUiText } from "@/lib/i18n";
import { useThemeStore } from "@/stores/use-theme-store";

export function useImageMentions(options: {
    value: string;
    onChange: (value: string) => void;
    images: ConversationImageItem[];
    onSelect: (image: ConversationImageItem) => boolean | void | Promise<boolean | void>;
    disabled?: boolean;
}) {
    const t = useUiText(), id = useId();
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const [token, setToken] = useState<ImageMentionToken | null>(null);
    const [active, setActive] = useState(0);
    const [choosing, setChoosing] = useState(false);
    const input = useRef<HTMLTextAreaElement | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const pending = useRef<object | null>(null);
    const latest = useRef(options); latest.current = options;
    const visible = Boolean(token && !options.disabled);
    const matches = filterMentionImages(options.images, token?.query || "");
    const images = matches.slice(0, 30);
    const selectedIndex = Math.min(active, Math.max(0, images.length - 1));
    const close = () => { setToken(null); pending.current = null; setChoosing(false); };
    useEffect(() => {
        if (!visible) return;
        const outside = (event: PointerEvent) => {
            if (event.target !== input.current && !menuRef.current?.contains(event.target as Node)) close();
        };
        document.addEventListener("pointerdown", outside);
        return () => document.removeEventListener("pointerdown", outside);
    }, [visible]);
    useEffect(() => { menuRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [active, token?.query]);
    useEffect(() => () => { pending.current = null; }, []);
    useEffect(() => {
        if (token && options.value.slice(token.start, token.end) !== `@${token.query}`) close();
    }, [options.value, token]);
    const inspect = (element: HTMLTextAreaElement) => {
        input.current = element;
        const next = element.selectionStart === element.selectionEnd ? imageMentionAt(element.value, element.selectionStart) : null;
        setToken(next); setActive(0);
    };
    const choose = async (image: ConversationImageItem) => {
        if (!token || pending.current || options.disabled || image.unavailableReason) return;
        const request = {}, value = options.value, selectedToken = { ...token }, sourceElement = input.current;
        pending.current = request; setChoosing(true);
        try {
            const accepted = await options.onSelect(image);
            // A selection that finished after typing/switching scope must not overwrite a new draft.
            if (accepted === false || pending.current !== request || latest.current.value !== value || latest.current.disabled || !latest.current.images.some(item => item.id === image.id)) return;
            const next = insertImageMention(value, selectedToken, image.label);
            latest.current.onChange(next.value);
            close();
            requestAnimationFrame(() => { if (sourceElement?.isConnected) { sourceElement.focus(); sourceElement.setSelectionRange(next.caret, next.caret); } });
        } catch (error) {
            if (pending.current === request) void message.error(error instanceof Error ? error.message : t("选择图片失败，请重试"));
        } finally {
            if (pending.current === request) { pending.current = null; setChoosing(false); }
        }
    };
    const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
        pending.current = null; setChoosing(false);
        options.onChange(event.target.value); inspect(event.currentTarget);
    };
    const handleSelect = (event: SyntheticEvent<HTMLTextAreaElement>) => inspect(event.currentTarget);
    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (!visible || event.nativeEvent.isComposing || event.keyCode === 229) return false;
        if (event.key === "Tab") { close(); return false; }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return true; }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault(); setActive(value => images.length ? (value + (event.key === "ArrowDown" ? 1 : -1) + images.length) % images.length : 0); return true;
        }
        if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            if (images[selectedIndex]) void choose(images[selectedIndex]);
            return true;
        }
        return false;
    };
    const menu = visible ? <div ref={menuRef} id={id} role="listbox" aria-label={t("选择对话图片")} aria-busy={choosing} className="thin-scrollbar absolute inset-x-0 bottom-full z-30 mb-2 max-h-60 overflow-y-auto rounded-lg border p-1 shadow-lg" style={{ background: theme.node.panel, color: theme.node.text, borderColor: theme.node.stroke }}>
        <div className="px-2 py-1 text-[11px]" style={{ color: theme.node.muted }}>{t("选择编辑目标 · ↑↓ 选择 · Enter 确定 · Esc 关闭")}</div>
        {images.length ? images.map((image, index) => <button key={image.id} type="button" role="option" aria-selected={index === selectedIndex} disabled={choosing || Boolean(image.unavailableReason)} title={image.unavailableReason ? t(image.unavailableReason) : image.name}
            onMouseDown={event => event.preventDefault()} onClick={() => void choose(image)} className="flex min-h-12 w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left disabled:opacity-40" style={{ background: index === selectedIndex ? theme.node.fill : "transparent" }}>
            <CanvasPersistedMediaPreview kind="image" url={image.dataUrl} storageKey={image.storageKey} alt="" className="size-9 shrink-0 rounded object-cover" />
            <span className="shrink-0 text-xs font-medium">{conversationImageLabel(image.label)}</span><span className="min-w-0 truncate text-xs" style={{ color: theme.node.muted }}>{image.name}</span>
        </button>) : <p className="px-2 py-3 text-xs" style={{ color: theme.node.muted }}>{t("没有匹配的图片")}</p>}
        {matches.length > images.length ? <p className="px-2 py-2 text-xs" style={{ color: theme.node.muted }}>{t("还有 {count} 张，请输入图号或名称筛选", { count: matches.length - images.length })}</p> : null}
    </div> : null;
    return { menu, handleChange, handleSelect, handleKeyDown, inputProps: { "aria-controls": visible ? id : undefined, "aria-expanded": visible, "aria-autocomplete": "list" as const } };
}
