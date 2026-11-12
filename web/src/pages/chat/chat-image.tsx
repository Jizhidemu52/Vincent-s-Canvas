import { uiText, useUiText } from "@/lib/i18n";
import { Button } from "antd";
import { memo, useEffect, useState } from "react";
import { resolveImageUrl } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";
import { conversationImageLabel, type ConversationImageAction } from "@/components/conversation-image-controls";
import { ConversationImagePreview } from "@/components/conversation-image-preview";

export const ChatImage = memo(function ChatImage({ image, label, disabled, onPlace, onAction, onMask, compareDisabledReason }: {
    image: { id: string; dataUrl?: string; storageKey?: string; name?: string; unavailableReason?: string }; label: string; disabled?: boolean; onPlace?: () => void;
    onAction?: (action: ConversationImageAction, imageId: string) => void; compareDisabledReason?: string;
    onMask?: () => void;
}) {
    useUiText();
    const displayLabel = conversationImageLabel(label);
    const ownerId = useUserStore((state) => state.user?.id);
    const [url, setUrl] = useState("");
    const [failed, setFailed] = useState(false);
    const [reload, setReload] = useState(0);
    const [previewOpen, setPreviewOpen] = useState(false);
    useEffect(() => {
        let cancelled = false;
        setUrl(""); setFailed(false);
        void resolveImageUrl(image.storageKey, image.storageKey ? "" : image.dataUrl || "").then((value) => {
            if (cancelled || useUserStore.getState().user?.id !== ownerId) return;
            setUrl(value); setFailed(!value);
        }).catch(() => { if (!cancelled && useUserStore.getState().user?.id === ownerId) setFailed(true); });
        return () => { cancelled = true; };
    }, [image.storageKey, image.dataUrl, ownerId, reload]);
    const unavailable = disabled || !url || failed;
    return <div className={`group/image relative min-w-0 max-w-full ${onPlace ? "w-[36rem]" : "w-60"}`}>
        {url && !failed ? <button type="button" disabled={Boolean(image.unavailableReason)} aria-label={`${uiText("查看大图")} · ${displayLabel}`} aria-haspopup="dialog" onClick={() => setPreviewOpen(true)} className="block w-full overflow-hidden rounded-2xl bg-muted/40 cursor-zoom-in focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-default"><img src={url} alt={displayLabel} loading="lazy" decoding="async" onError={() => setFailed(true)} className={onPlace ? "aspect-[4/3] max-h-[28rem] w-full object-contain" : "aspect-[4/3] max-h-44 w-full object-contain"} /></button> : <div className="flex aspect-[4/3] items-center justify-center gap-2 rounded-2xl bg-muted/40 p-3 text-xs text-muted-foreground"><span>{failed ? uiText("原图暂时无法读取") : uiText("正在读取图片…")}</span>{failed ? <Button size="small" onClick={() => setReload((value) => value + 1)}>{uiText("重试")}</Button> : null}</div>}
        <div className="px-1 pt-2 text-xs text-muted-foreground">
            <span className="block break-words">{displayLabel}</span>
        </div>
        {onAction ? <div className="flex flex-wrap gap-1 py-1 text-xs text-muted-foreground">
            <button type="button" aria-label={`${uiText("复制图片")} · ${displayLabel}`} disabled={unavailable} onClick={() => onAction("copy", image.id)} className="min-h-8 rounded px-2 py-1 hover:bg-background disabled:opacity-50">{uiText("复制图片")}</button>
            <button type="button" aria-label={`${uiText("下载原图")} · ${displayLabel}`} disabled={unavailable} onClick={() => onAction("download", image.id)} className="min-h-8 rounded px-2 py-1 hover:bg-background disabled:opacity-50">{uiText("下载原图")}</button>
            {!compareDisabledReason ? <button type="button" disabled={unavailable} onClick={() => onAction("compare", image.id)} className="min-h-8 rounded px-2 py-1 hover:bg-background disabled:opacity-50">{uiText("对比原图")}</button> : null}
            {onMask ? <button type="button" disabled={unavailable} onClick={onMask} className="min-h-8 rounded px-2 py-1 hover:bg-background disabled:opacity-50">{uiText("涂选修改区域")}</button> : null}
            {onPlace ? <button type="button" disabled={unavailable} onClick={onPlace} className="min-h-8 rounded px-2 py-1 hover:bg-background disabled:opacity-50">{uiText("放入画布")}</button> : null}
        </div> : null}
        {onMask ? <p className="px-1 text-[12px] leading-5 text-muted-foreground">{uiText("只改局部时，先涂选；选区外保留原图")}</p> : null}
        {previewOpen ? <ConversationImagePreview image={{ ...image, label, name: image.name || label }} onClose={() => setPreviewOpen(false)} /> : null}
    </div>;
});
