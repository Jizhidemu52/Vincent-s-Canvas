import { useState } from "react";
import { Globe2 } from "lucide-react";
import { setUiLocale, useUiLocale, useUiLanguageEnabled } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function LanguageSwitch({ className, compact = false }: { className?: string; compact?: boolean }) {
    const locale = useUiLocale();
    const enabled = useUiLanguageEnabled();
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    if (!enabled) return null;
    const english = locale === "en-US";
    const label = english ? "Switch language to Chinese" : "切换语言为 English";
    return <span className="inline-flex min-w-0 flex-col">
        <button type="button" data-testid="language-switch" className={cn("inline-flex min-h-8 items-center justify-center gap-1.5 rounded px-2 text-xs text-current transition hover:opacity-75 disabled:cursor-wait", className)}
            disabled={busy} aria-label={label} title={label} onClick={async () => {
                setBusy(true); setFailed(false);
                try { await setUiLocale(english ? "zh-CN" : "en-US"); } catch { setFailed(true); } finally { setBusy(false); }
            }}>
            <Globe2 className="size-4 shrink-0" aria-hidden="true" /><span>{compact ? english ? "EN" : "中" : english ? "English" : "中文"}</span>
        </button>
        {failed ? <span role="alert" className="max-w-48 text-xs">{english ? "Language could not load. Please retry." : "语言加载失败，请重试。"}</span> : null}
    </span>;
}
