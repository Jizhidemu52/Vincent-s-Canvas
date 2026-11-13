import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ColumnsType } from "antd/es/table";
import { getUiLocale, useUiLocale } from "@/lib/i18n";
import { displayText, displayTranslationRevision, displayTranslationStatus, queueDisplayTranslations, subscribeDisplayTranslations } from "@/lib/display-translations";
import { displayValue } from "@/lib/display-value";
import { translateDisplayConfig, type DisplayConfigKind } from "@/lib/display-config";

const DisplayTranslationVisible = createContext(true);
/** Inactive mounted workspaces and closed detail panes must not send their text. */
export function DisplayTranslationScope({ visible, children }: { visible: boolean; children: ReactNode }) {
    const parentVisible = useContext(DisplayTranslationVisible);
    return <DisplayTranslationVisible.Provider value={parentVisible && visible}>{children}</DisplayTranslationVisible.Provider>;
}

/** Call only for display strings, never input values, saved fields or payloads. */
export function useDisplayText() {
    const locale = useUiLocale();
    const visible = useContext(DisplayTranslationVisible);
    const revision = useSyncExternalStore(subscribeDisplayTranslations, displayTranslationRevision, () => 0);
    const sources = useRef(new Set<string>());
    sources.current = new Set();
    useEffect(() => {
        if (locale !== "en-US" || !visible) return;
        // Wait for typing/streaming to settle; never translate every token of an
        // in-progress response or each keystroke of an original editor.
        const visibleSources = sources.current;
        const timer = setTimeout(() => queueDisplayTranslations(visibleSources), 750);
        return () => clearTimeout(timer);
    });
    return useCallback((source: string) => {
        if (locale === "zh-CN" || !visible) return source;
        sources.current.add(source);
        return displayText(source);
    }, [locale, revision, visible]);
}

type DisplayConfig = {
    <Row extends object>(value: ColumnsType<NoInfer<Row>>, kind: "columns", rows: readonly Row[] | undefined): ColumnsType<Row>;
    <T>(value: T, kind: "options"): T;
};
export function useDisplayConfig(): DisplayConfig {
    const translate = useDisplayText();
    return useCallback((value: unknown, kind: DisplayConfigKind) => translateDisplayConfig(value, kind, translate, text => <DisplayText text={text} />), [translate]) as DisplayConfig;
}

/** Nullable React/string props keep their original type and non-text identity. */
export function useDisplayUiValue() {
    const translate = useDisplayText();
    return useCallback(<T,>(value: T): T => (typeof value === "string" ? translate(value) : value) as T, [translate]);
}

export function DisplayText({ text, className }: { text: string; className?: string }) {
    const translate = useDisplayText();
    const translated = translate(text);
    if (translated === text) return <>{text}</>;
    return <span className={className} title={text} data-display-translation="en-US">{translated}</span>;
}

/** A mounted notification can update after translation arrives. Chinese and
 * already-localized content keep the exact original primitive/React identity. */
export function displayNotice(content: ReactNode): ReactNode {
    if (getUiLocale() !== "en-US" || typeof content !== "string") return content;
    const translated = displayText(content);
    return /[\u3400-\u9fff]/.test(translated) ? <DisplayText text={content} /> : translated;
}

export function useDisplayValue() {
    const translate = useDisplayText();
    return useCallback((value: unknown) => displayValue(value, translate), [translate]);
}

/** Explicitly audited/private source views promise not to send their contents
 * to a model automatically. English mode preserves that promise per value. */
export function SensitiveDisplayValue({ value, format = formatDisplayValue }: { value: unknown; format?: (value: unknown) => string }) {
    const locale = useUiLocale();
    const display = useDisplayText();
    const displayJson = useDisplayValue();
    const [approved, setApproved] = useState<{ value: unknown } | null>(null);
    const enabled = locale === "en-US" && approved?.value === value;
    const shown = enabled ? typeof value === "string" ? display(value) : displayJson(value) : value;
    return <>{format(shown)}{locale === "en-US" && /[\u3400-\u9fff]/.test(format(value)) && !enabled ? <span className="mt-2 block text-xs font-sans text-muted-foreground">
        Private original is not sent automatically. <button type="button" className="underline" onClick={() => setApproved({ value })}>Send this displayed text for English translation</button>
    </span> : null}</>;
}
function formatDisplayValue(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? ""; }

/** An English preview beside an original editor, never a replacement value. */
export function DisplayTranslationPreview({ text }: { text: string }) {
    const locale = useUiLocale();
    const translate = useDisplayText();
    if (locale !== "en-US" || !text.trim()) return null;
    const translated = translate(text);
    const status = displayTranslationStatus(text);
    return <div className="mt-1 text-xs text-muted-foreground" data-testid="display-translation-preview">
        <span className="font-medium">English display · original unchanged</span>
        <p className="whitespace-pre-wrap break-words" title={text}>{translated}</p>
        {translated === text && /[\u3400-\u9fff]/.test(text) ? <p role="status">{status === "unavailable" ? "Translation unavailable. Your original is preserved." : "Preparing English display…"}</p> : null}
    </div>;
}
