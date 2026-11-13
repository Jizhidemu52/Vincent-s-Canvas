import { staticUiText } from "@/lib/static-ui-copy";
import { useState } from "react";
import { Dropdown, Tooltip } from "antd";
import { Check, ChevronDown, Download, LoaderCircle } from "lucide-react";
import { useUiLocale, useUiText } from "@/lib/i18n";

const preferenceKey = "canvas-image-download-format-v1";
export function CanvasImageDownloadButton({ onDownload, onOptions, showLabel }: { onDownload: (format: "original" | "png" | "jpg") => void | Promise<void>; onOptions?: () => void; showLabel: boolean }) {
    const t = useUiText(), english = useUiLocale() === "en-US";
    const [busy, setBusy] = useState(false);
    const [lastFormat, setLastFormat] = useState(() => { try { return localStorage.getItem(preferenceKey) || "png"; } catch { return "png"; } });
    const download = async (format: "original" | "png" | "jpg") => {
        if (busy) return;
        if (format !== "original") { setLastFormat(format); try { localStorage.setItem(preferenceKey, format); } catch { /* preference is optional */ } }
        setBusy(true);
        try { await onDownload(format); } finally { setBusy(false); }
    };
    return <div className="inline-flex shrink-0 items-center" data-canvas-no-zoom>
        <Tooltip title={english ? "Download the original file without re-encoding" : staticUiText("下载原文件，不重新编码")}>
            <button type="button" data-usage-control="canvas-tool.download" className="flex h-8 items-center gap-2 rounded-l-md px-2 hover:bg-[var(--node-tool-hover)] disabled:opacity-40" aria-label={t("下载图片")} disabled={busy} onClick={() => void download("original")}>
                {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}{showLabel ? <span>{busy ? t("正在准备下载…") : (english ? "Original" : staticUiText("下载原图"))}</span> : null}
            </button>
        </Tooltip>
        <Dropdown trigger={["click"]} placement="bottomRight" autoAdjustOverflow menu={{ items: [
            ...(["png", "jpg"] as const).map(format => ({ key: format, icon: <Check className={`size-4 ${lastFormat === format ? "" : "invisible"}`} />, label: format === "png" ? (english ? "Save as PNG" : staticUiText("另存为 PNG")) : (english ? "Save as JPG (white background)" : staticUiText("另存为 JPG（白底）")), onClick: () => void download(format) })),
            ...(onOptions ? [{ type: "divider" as const }, { key: "options", label: english ? "Source versions and download details" : staticUiText("原件版本与下载说明"), onClick: onOptions }] : []),
        ] }}><button type="button" className="flex h-8 w-6 items-center justify-center rounded-r-md hover:bg-[var(--node-tool-hover)] disabled:opacity-40" aria-label={english ? "More download formats" : staticUiText("更多下载格式")} disabled={busy}><ChevronDown className="size-3" /></button></Dropdown>
    </div>;
}
