import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, Image as ImageIcon, LockKeyhole, RotateCcw, Sparkles } from "lucide-react";
import { CanvasPersistedMediaPreview } from "@/components/canvas/canvas-persisted-media-preview";
import { canvasThemes } from "@/lib/canvas-theme";
import { useUiLocale } from "@/lib/i18n";
import { getImageAgentVersions, imageAgentVersion, originalImageAgentImage, type ImageAgentImage } from "@/lib/image-agent/focus";
import { useThemeStore } from "@/stores/use-theme-store";
import { Tooltip } from "antd";
import { useDisplayText } from "@/hooks/use-display-text";

export type ImageAgentFocusImage = ImageAgentImage & { dataUrl?: string; storageKey?: string; width?: number; height?: number };
export type ImageAgentFocusProps = {
    images: readonly ImageAgentFocusImage[];
    focusId?: string;
    locked?: boolean;
    newCreation?: boolean;
    referenceCount?: number;
    disabled?: boolean;
    onSelect: (id: string) => void;
    onNewCreation: () => void;
    children?: ReactNode;
};

const copy = {
    "zh-CN": { region: "当前作品", fresh: "新创作", freshHint: "不沿用当前图片", locked: "底图已锁定", current: "当前图", unavailable: "图片暂时不可用", versions: "作品版本", other: "其他图片", choose: "选择图片", original: "原图", previous: "上一版", note: "作品说明", keep: "需保持", noteHint: "记录创作要求，不代表画面已经验收。", references: "参考图", image: "图" },
    "en-US": { region: "Current work", fresh: "New creation", freshHint: "Start without the current image", locked: "Base image locked", current: "Current image", unavailable: "Image unavailable", versions: "Work versions", other: "Other images", choose: "Choose image", original: "Original", previous: "Previous", note: "Work notes", keep: "Keep", noteHint: "Records design requirements, not visual approval.", references: "References", image: "Image " },
} as const;

const available = (image: ImageAgentFocusImage | undefined): image is ImageAgentFocusImage => Boolean(image && !image.unavailableReason && (image.dataUrl || image.storageKey));

/** Offscreen version-strip items do not start private-media requests. */
function FocusThumbnail({ image, eager = false }: { image: ImageAgentFocusImage; eager?: boolean }) {
    const ref = useRef<HTMLSpanElement>(null);
    const [visible, setVisible] = useState(eager);
    useEffect(() => {
        if (visible || !available(image)) return;
        if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
        const observer = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
        });
        if (ref.current) observer.observe(ref.current);
        return () => observer.disconnect();
    }, [visible, image.id, image.dataUrl, image.storageKey, image.unavailableReason]);
    return <span ref={ref} aria-hidden="true" className="flex size-full items-center justify-center overflow-hidden rounded">
        {visible && available(image) ? <CanvasPersistedMediaPreview kind="image" url={image.dataUrl} storageKey={image.storageKey} width={image.width} height={image.height} alt="" className="size-full object-cover" /> : <ImageIcon size={18} />}
    </span>;
}

/** Controlled presentation only: callers persist focus and lock changes. */
export function ImageAgentFocus({ images, focusId, locked, newCreation, referenceCount = 0, disabled, onSelect, onNewCreation, children }: ImageAgentFocusProps) {
    const text = copy[useUiLocale()];
    const display = useDisplayText();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const [expanded, setExpanded] = useState(false);
    const chooserRef = useRef<HTMLButtonElement>(null);
    const versionsId = useId();
    const focus = !newCreation && focusId ? images.find(image => image.id === focusId) : undefined;
    const missingFocus = !newCreation && Boolean(focusId) && !focus;
    const fresh = !focus && !missingFocus;
    const versions = focus ? getImageAgentVersions(images, focus.id) : [];
    const versionIds = new Set(versions.map(image => image.id));
    const others = images.filter(image => !versionIds.has(image.id));
    let original: ImageAgentFocusImage | undefined;
    try { if (focus) original = originalImageAgentImage(images, focus); } catch { /* Missing ancestors must not become fake original actions. */ }
    const previous = focus?.parentId ? images.find(image => image.id === focus.parentId) : undefined;
    const label = (image: ImageAgentFocusImage) => {
        const match = /^(原图|图)(\d+)$/u.exec(image.label);
        return match ? `${match[1] === "原图" ? text.original : text.image}${text.original === "Original" && match[1] === "原图" ? " " : ""}${match[2]}` : display(image.label);
    };
    const buttonClass = "inline-flex min-h-8 min-w-0 items-center gap-1 rounded px-1.5 py-1 text-left hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40";
    const buttonStyle = { outlineColor: theme.canvas.selectionStroke };
    const choose = (image: ImageAgentFocusImage) => { if (!disabled && available(image)) onSelect(image.id); };
    const renderStrip = (items: readonly ImageAgentFocusImage[], title: string, showVersions: boolean) => items.length ? <div className="min-w-0">
        <p className="mb-1.5 text-[11px]" style={{ color: theme.node.faint }}>{title}</p>
        <div role="group" aria-label={title} className="flex min-w-0 gap-2 overflow-x-auto pb-1.5 overscroll-x-contain">
            {items.map((image, index) => <Tooltip key={image.id} title={display(image.unavailableReason || image.name || label(image))}><span className="inline-flex shrink-0"><button type="button" aria-pressed={focus?.id === image.id}
                aria-label={`${text.choose}: ${label(image)}${showVersions ? ` · V${index + 1}` : ""}`}
                disabled={disabled || !available(image)} onClick={() => choose(image)}
                className="flex w-16 shrink-0 flex-col items-center gap-1 rounded p-1 text-center text-[11px] hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-1 disabled:cursor-not-allowed disabled:opacity-40"
                style={{ ...buttonStyle, color: focus?.id === image.id ? theme.canvas.selectionStroke : theme.node.muted, background: focus?.id === image.id ? theme.canvas.selectionFill : undefined }}>
                <span className="block size-12"><FocusThumbnail image={image} /></span>
                <span className="flex w-full min-w-0 items-center justify-center gap-1">{showVersions ? <span className="shrink-0 font-medium">V{index + 1}</span> : null}<span className="truncate">{label(image)}</span></span>
            </button></span></Tooltip>)}
        </div>
    </div> : null;

    return <section data-image-agent-focus data-focus-id={focus?.id} aria-label={text.region} className="min-w-0 text-xs" style={{ color: theme.node.muted }}
        onKeyDown={event => { if (event.key === "Escape" && expanded) { setExpanded(false); chooserRef.current?.focus(); event.stopPropagation(); } }}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <button ref={chooserRef} type="button" aria-expanded={expanded} aria-controls={expanded ? versionsId : undefined} aria-label={text.choose} disabled={!images.length}
                onClick={() => setExpanded(value => !value)} className={`${buttonClass} flex-1 !gap-2 !px-0`} style={buttonStyle}>
                <span className="block size-9 shrink-0" style={{ color: theme.node.faint }}>
                    {focus ? <FocusThumbnail key={focus.id} image={focus} eager /> : fresh ? <Sparkles size={20} className="m-2" /> : <ImageIcon size={20} className="m-2" />}
                </span>
                <span className="min-w-0 flex-1">
                    <Tooltip title={focus?.name ? display(focus.name) : undefined}><span className="block truncate font-medium" style={{ color: theme.node.text }}>{focus ? `${label(focus)} · V${imageAgentVersion(images, focus.id)}` : missingFocus ? text.unavailable : text.fresh}</span></Tooltip>
                    <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
                        {focus ? available(focus) ? <span className="inline-flex items-center gap-1">{locked ? <LockKeyhole size={10} aria-hidden="true" /> : null}{locked ? text.locked : text.current}</span> : <span>{text.unavailable}</span> : fresh ? <span>{text.freshHint}</span> : null}
                        {referenceCount > 0 ? <span>{text.references} {referenceCount}</span> : null}
                    </span>
                </span>
                {images.length ? <ChevronDown size={13} aria-hidden="true" className={`shrink-0 ${expanded ? "rotate-180" : ""}`} /> : null}
            </button>
            {!fresh ? <button type="button" onClick={onNewCreation} disabled={disabled} className={buttonClass} style={buttonStyle}><Sparkles size={12} aria-hidden="true" />{text.fresh}</button> : null}
        </div>
        {focus && (available(original) && original.id !== focus.id || available(previous)) ? <div className="flex flex-wrap items-center gap-x-1 pl-9 text-[11px]">
            {available(original) && original.id !== focus.id ? <button type="button" onClick={() => choose(original!)} disabled={disabled} className={buttonClass} style={buttonStyle}><RotateCcw size={11} aria-hidden="true" />{text.original}</button> : null}
            {available(previous) ? <button type="button" onClick={() => choose(previous)} disabled={disabled} className={buttonClass} style={buttonStyle}><ChevronLeft size={11} aria-hidden="true" />{text.previous}</button> : null}
        </div> : null}
        {expanded ? <div id={versionsId} className="space-y-2 py-2">
            {renderStrip(versions, text.versions, true)}
            {renderStrip(others, versions.length ? text.other : text.choose, false)}
        </div> : null}
        {focus?.note && (focus.note.summary.trim() || focus.note.keep.some(value => value.trim())) ? <details key={focus.id} className="mt-1 min-w-0">
            <summary className="w-fit cursor-pointer rounded py-1 text-[11px] hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-1" style={buttonStyle}>{text.note}</summary>
            <div className="space-y-1.5 py-1 text-xs leading-relaxed" style={{ overflowWrap: "anywhere", color: theme.node.text }}>
                {focus.note.summary ? <p className="whitespace-pre-wrap">{display(focus.note.summary)}</p> : null}
                {focus.note.keep.length ? <p><span style={{ color: theme.node.muted }}>{text.keep}: </span>{focus.note.keep.map(display).join(" · ")}</p> : null}
                <p className="text-[11px]" style={{ color: theme.node.faint }}>{text.noteHint}</p>
            </div>
        </details> : null}
        {children}
    </section>;
}
