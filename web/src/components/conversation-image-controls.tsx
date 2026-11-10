import { memo, type ReactNode } from "react";
import { Brush, Copy, Download, ImagePlus, MoreHorizontal, Pencil, RotateCcw, SplitSquareHorizontal, X } from "lucide-react";
import { Dropdown } from "antd";
import { canvasThemes } from "@/lib/canvas-theme";
import { uiText, useUiText } from "@/lib/i18n";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasPersistedMediaPreview } from "@/components/canvas/canvas-persisted-media-preview";

/** A presentation adapter, not a second image catalog or persistence format. */
export type ConversationImageItem = {
    id: string;
    label: string;
    name: string;
    dataUrl?: string;
    storageKey?: string;
    unavailableReason?: string;
    source?: "canvas" | "conversation";
};
export type ConversationImageAction = "edit" | "original" | "reference" | "compare" | "copy" | "download";

/** Keep saved/request labels canonical; localize only their UI presentation. */
export function conversationImageLabel(label: string) {
    const match = /^(原图|图)(\d+)$/u.exec(label);
    return match ? uiText(`${match[1]}{number}`, { number: match[2] }) : label;
}

const actions = [
    { id: "edit", text: "继续修改", icon: Pencil },
    { id: "original", text: "回原图重做", icon: RotateCcw },
    { id: "reference", text: "设为参考", icon: ImagePlus },
    { id: "compare", text: "和原图对比", icon: SplitSquareHorizontal },
    { id: "copy", text: "复制图片", icon: Copy },
    { id: "download", text: "下载", icon: Download },
] as const;

export const ConversationImageActions = memo(function ConversationImageActions({ image, disabled, originalDisabledReason, compareDisabledReason, onAction, extra, compact, onMask }: {
    image: ConversationImageItem;
    disabled?: boolean;
    originalDisabledReason?: string;
    compareDisabledReason?: string;
    onAction: (action: ConversationImageAction, imageId: string) => void;
    extra?: ReactNode;
    compact?: boolean;
    onMask?: () => void;
}) {
    const t = useUiText();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const unavailable = image.unavailableReason || (!image.storageKey && !image.dataUrl ? "原图暂时无法读取" : undefined);
    if (compact) return <div role="group" aria-label={t("{label} 图片操作", { label: conversationImageLabel(image.label) })} className="flex flex-wrap items-center justify-center gap-1 rounded-lg p-1 text-xs backdrop-blur" style={{ background: theme.toolbar.panel, color: theme.node.text }}>
        <button type="button" disabled={disabled || Boolean(unavailable)} onClick={event => { event.stopPropagation(); onAction("edit", image.id); }} className="inline-flex min-h-8 items-center gap-1 rounded px-2 hover:opacity-70 disabled:opacity-40"><Pencil size={13} />{t("在此基础上改")}</button>
        <button type="button" disabled={disabled || Boolean(unavailable)} onClick={event => { event.stopPropagation(); onAction("reference", image.id); }} className="inline-flex min-h-8 items-center gap-1 rounded px-2 hover:opacity-70 disabled:opacity-40"><ImagePlus size={13} />{t("作为参考")}</button>
        <Dropdown trigger={["click"]} menu={{ items: [
            ...(onMask ? [{ key: "mask", label: t("圈选修改"), icon: <Brush size={14} />, disabled: disabled || Boolean(unavailable), onClick: onMask }] : []),
            ...actions.filter(action => action.id !== "edit" && action.id !== "reference").map(({ id, text, icon: Icon }) => ({ key: id, label: t(text), icon: <Icon size={14} />, disabled: disabled || Boolean(unavailable || (id === "original" ? originalDisabledReason : id === "compare" ? compareDisabledReason : undefined)), onClick: () => onAction(id, image.id) })),
            ...(extra ? [{ key: "extra", label: extra }] : []),
        ] }}><button type="button" aria-label={t("更多图片操作")} onClick={event => event.stopPropagation()} className="grid size-8 place-items-center rounded hover:opacity-70"><MoreHorizontal size={16} /></button></Dropdown>
    </div>;
    return <div role="group" aria-label={t("{label} 图片操作", { label: conversationImageLabel(image.label) })} className="flex min-w-0 flex-wrap items-center gap-x-0.5 border-t px-1 py-0.5 text-xs" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
        {actions.map(({ id, text, icon: Icon }) => {
            const reason = unavailable || (id === "original" ? originalDisabledReason : id === "compare" ? compareDisabledReason : undefined);
            return <span key={id} className="inline-flex max-w-full" title={reason ? t(reason) : t(text)}>
                <button type="button" disabled={disabled || Boolean(reason)} aria-label={t(text)} aria-description={reason ? t(reason) : undefined} onClick={event => { event.stopPropagation(); onAction(id, image.id); }}
                    className="inline-flex min-h-9 items-center gap-1 rounded px-2 py-1 text-left hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-1 disabled:cursor-not-allowed disabled:opacity-35" style={{ outlineColor: theme.canvas.selectionStroke }}>
                    <Icon size={12} aria-hidden="true" /><span>{t(text)}</span>
                </button>
            </span>;
        })}
        {extra}
    </div>;
});

export function ConversationImageTarget({ image, mode = "edit", onCancel }: {
    image?: ConversationImageItem;
    mode?: "edit" | "original";
    onCancel: () => void;
}) {
    const t = useUiText();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    return <div data-testid="conversation-image-target" role="status" className="mb-1 flex min-h-8 min-w-0 items-center gap-2 px-1 text-xs" style={{ color: theme.node.muted }}>
        {image ? <>
            <CanvasPersistedMediaPreview kind="image" url={image.dataUrl} storageKey={image.storageKey} alt="" className="size-7 shrink-0 rounded object-cover" />
            <span className="min-w-0 flex-1 break-words" title={image.name}>{mode === "original" ? t("基于：{label} 的原图", { label: conversationImageLabel(image.label) }) : t("基于：{label}", { label: conversationImageLabel(image.label) })}</span>
            <button type="button" onClick={onCancel} className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded px-1.5 hover:opacity-70 focus-visible:outline-2" aria-label={t("取消编辑目标")} style={{ outlineColor: theme.canvas.selectionStroke }}><X size={12} aria-hidden="true" />{t("取消")}</button>
        </> : <span>{t("编辑目标：自动判断")}</span>}
    </div>;
}
