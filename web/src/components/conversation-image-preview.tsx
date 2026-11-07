import { useEffect, useRef, useState } from "react";
import { Button, Image, Modal, Spin } from "antd";
import { Download, Maximize, ZoomIn, ZoomOut } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useUiText } from "@/lib/i18n";
import { useConversationImageTools } from "@/hooks/use-conversation-image-tools";
import { resolveImageUrl } from "@/services/image-storage";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { conversationImageLabel, type ConversationImageItem } from "./conversation-image-controls";

/** Resolve the original only after opening; previewing never changes the edit target. */
export function ConversationImagePreview({ image, onClose }: { image: ConversationImageItem; onClose: () => void }) {
    const t = useUiText();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const owner = useUserStore(state => state.user?.id);
    const openedOwner = useRef(owner);
    const { download } = useConversationImageTools();
    const [source, setSource] = useState("");
    const [error, setError] = useState("");
    const [downloading, setDownloading] = useState(false);
    useEffect(() => { if (owner !== openedOwner.current) onClose(); }, [owner, onClose]);
    useEffect(() => {
        let active = true;
        setSource(""); setError("");
        if (image.unavailableReason) { setError(image.unavailableReason); return; }
        void resolveImageUrl(image.storageKey, image.storageKey ? "" : image.dataUrl || "").then(url => {
            if (!active || useUserStore.getState().user?.id !== openedOwner.current) return;
            if (url) setSource(url); else setError("原图暂时无法读取");
        }).catch(() => { if (active && useUserStore.getState().user?.id === openedOwner.current) setError("原图暂时无法读取"); });
        return () => { active = false; };
    }, [image.storageKey, image.dataUrl, image.unavailableReason]);
    if (owner !== openedOwner.current) return null;
    if (!source || error) return <Modal open centered title={conversationImageLabel(image.label)} footer={null} onCancel={onClose}>
        {error ? <p role="alert">{t(error)}</p> : <div role="status" className="flex items-center justify-center gap-2 py-8"><Spin />{t("正在读取图片…")}</div>}
    </Modal>;
    return <Image src={source} alt={conversationImageLabel(image.label)} styles={{ root: { display: "none" } }} onError={() => setError("原图暂时无法读取")} preview={{
        open: true, src: source, minScale: .1, maxScale: 16, movable: true,
        onOpenChange: open => { if (!open) onClose(); },
        actionsRender: (_original, { actions, transform }) => <div data-canvas-shortcuts="ignore" className="flex max-w-[calc(100vw-24px)] flex-wrap items-center justify-center gap-1 rounded-xl p-2" style={{ background: theme.toolbar.panel, color: theme.node.text }}>
            <Button aria-label={t("缩小大图")} disabled={transform.scale <= .1} icon={<ZoomOut size={18} />} onClick={actions.onZoomOut} />
            <span className="w-14 text-center text-xs tabular-nums">{Math.round(transform.scale * 100)}%</span>
            <Button aria-label={t("放大大图")} disabled={transform.scale >= 16} icon={<ZoomIn size={18} />} onClick={actions.onZoomIn} />
            <Button icon={<Maximize size={16} />} onClick={actions.onReset}>{t("适应画面")}</Button>
            <Button loading={downloading} icon={<Download size={16} />} onClick={() => { setDownloading(true); void download(image).finally(() => setDownloading(false)); }}>{t("下载原图")}</Button>
        </div>,
    }} />;
}
