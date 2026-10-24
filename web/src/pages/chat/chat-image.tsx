import { Button } from "antd";
import { memo, useEffect, useState } from "react";
import { resolveImageUrl } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";

export const ChatImage = memo(function ChatImage({ image, label, disabled, onPlace }: {
    image: { dataUrl?: string; storageKey?: string }; label: string; disabled?: boolean; onPlace?: () => void;
}) {
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
    return <div className="overflow-hidden rounded-xl border border-border bg-muted">
        {url && !failed ? <img src={url} alt={label} loading="lazy" decoding="async" onError={() => setFailed(true)} className={onPlace ? "max-h-[480px] w-full object-contain" : "max-h-40 object-contain"} /> : <div className="flex min-h-24 items-center justify-center gap-2 p-3 text-xs text-muted-foreground"><span>{failed ? "原图暂时无法读取" : "正在读取图片…"}</span>{failed ? <Button size="small" onClick={() => setReload((value) => value + 1)}>重试</Button> : null}</div>}
        <div className="flex flex-wrap items-center gap-1 border-t border-border text-xs text-muted-foreground"><span className="flex-1 px-3 py-1">{label}</span>{onPlace ? <button type="button" disabled={disabled || !url || failed} onClick={onPlace} className="min-h-10 px-3 py-2 hover:bg-card disabled:opacity-50">放入画布</button> : null}{onPlace && url && !failed ? <a href={url} download="wireless-canvas.png" className="min-h-10 px-3 py-2 hover:bg-card">下载</a> : null}</div>
    </div>;
});
