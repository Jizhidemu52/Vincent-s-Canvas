import { useDisplayUiValue } from "@/hooks/use-display-text";
import { staticUiText } from "@/lib/static-ui-copy";
import { useUiLocale } from "@/lib/i18n";
import { Image } from "antd";
import { useState } from "react";
import { recordMediaLink } from "../asset-media";

export function AssetImage({ src, preview, alt, compact = false }: { src: string; preview?: string; alt: string; compact?: boolean }) {
    useUiLocale();
    const [failed, setFailed] = useState(false);
    if (failed) return <span className="flex min-h-20 items-center justify-center p-3 text-sm text-[var(--muted-foreground)]">{staticUiText("图片暂不可用")}</span>;
    return <Image src={src} alt={alt} width={compact ? 52 : "100%"} height={compact ? 52 : undefined} loading="lazy" referrerPolicy="no-referrer"
        styles={{ image: { objectFit: "contain", maxHeight: compact ? 52 : 480 } }} preview={preview ? { src: preview } : false} onError={() => setFailed(true)} />;
}

export function RecordMedia({ urls, label }: { urls: string[]; label: string }) {
    const displayUi = useDisplayUiValue();
    useUiLocale();
    const origin = typeof window === "undefined" ? undefined : window.location.origin;
    if (!urls.length) return <p className="text-sm text-[var(--muted-foreground)]">{staticUiText("无")}{displayUi(label)}</p>;
    return <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
        {urls.map((url, index) => {
            const link = recordMediaLink(url, origin);
            return <figure key={`${url}-${index}`} className="min-w-0 rounded-lg border border-[var(--border)] p-3">
                {link?.media ? <AssetImage key={link.media.thumbnail} src={link.media.thumbnail} preview={link.media.preview} alt={displayUi(`${label} ${index + 1}`)} /> : null}
                <figcaption className="mt-2 break-all text-xs">
                    {link ? <a href={link.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{displayUi(link.media ? staticUiText("打开{p0} {p1} 原文件", { p0: `${label}`, p1: `${index + 1}` }) : `${label} ${index + 1}：${url}`)}</a> : <span className="text-[var(--muted-foreground)]">{displayUi(label)} {index + 1}{staticUiText("：此地址不支持直接预览或打开")}</span>}
                    {!link?.media && link ? <p className="mt-1 text-[var(--muted-foreground)]">{staticUiText("外部或未知类型文件，仅在点击后打开。")}</p> : null}
                </figcaption>
            </figure>;
        })}
    </div>;
}
