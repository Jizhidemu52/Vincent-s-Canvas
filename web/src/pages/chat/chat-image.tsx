import { uiText, useUiText } from "@/lib/i18n";
import { Button } from "antd";
import { memo, useEffect, useState } from "react";
import { resolveImageUrl } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";
import { cn } from "@/lib/utils";
import { ConversationImageActions, conversationImageLabel, type ConversationImageAction } from "@/components/conversation-image-controls";

export const ChatImage = memo(function ChatImage({ image, label, disabled, onPlace, onAction, selected, originalDisabledReason, compareDisabledReason }: {
    image: { id: string; dataUrl?: string; storageKey?: string; name?: string; unavailableReason?: string }; label: string; disabled?: boolean; onPlace?: () => void;
    onAction?: (action: ConversationImageAction, imageId: string) => void; selected?: boolean; originalDisabledReason?: string; compareDisabledReason?: string;
}) {
    useUiText();
    const displayLabel = conversationImageLabel(label);
    const ownerId = useUserStore((state) => state.user?.id);
    const [url, setUrl] = useState("");
    const [failed, setFailed] = useState(false);
    const [reload, setReload] = useState(0);
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
    return <div className={cn("overflow-hidden rounded-xl border bg-muted", selected ? "border-primary ring-1 ring-primary" : "border-border")}>
        {url && !failed ? <button type="button" disabled={unavailable || !onAction} aria-label={uiText("以 {value1} 为编辑目标", { value1: displayLabel })} aria-pressed={Boolean(selected)} onClick={() => onAction?.("edit", image.id)} className={cn("block w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-default", onAction && !unavailable && "cursor-pointer")}><img src={url} alt={displayLabel} loading="lazy" decoding="async" onError={() => setFailed(true)} className={onPlace ? "max-h-[480px] w-full object-contain" : "max-h-40 object-contain"} /></button> : <div className="flex min-h-24 items-center justify-center gap-2 p-3 text-xs text-muted-foreground"><span>{failed ? uiText("原图暂时无法读取") : uiText("正在读取图片…")}</span>{failed ? <Button size="small" onClick={() => setReload((value) => value + 1)}>{uiText("重试")}</Button> : null}</div>}
        <div className="border-t border-border px-2 py-1 text-xs text-muted-foreground">
            <span className="block px-1 py-1">{displayLabel}</span>
            {onAction ? <ConversationImageActions image={{ ...image, label, name: image.name || label }} disabled={unavailable} originalDisabledReason={originalDisabledReason} compareDisabledReason={compareDisabledReason} onAction={onAction} extra={onPlace ? <button type="button" disabled={unavailable} onClick={onPlace} className="min-h-9 px-2 py-1 hover:bg-card disabled:opacity-50">{uiText("放入画布")}</button> : undefined} /> : null}
        </div>
    </div>;
});
