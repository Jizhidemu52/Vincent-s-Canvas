import { getUiLocale, uiText } from "./i18n";
import { useUserStore } from "@/stores/use-user-store";
import { requestDisplayTranslations } from "@/services/api/display-translations";
import { canvasResourceDisplayLabel } from "@/lib/canvas/canvas-resource-display";

const hasChinese = /[\u3400-\u9fff]/;
const isTransportValue = (source: string) => /^(?:https?:|data:|blob:|\/api\/)/i.test(source.trim());
type Entry = { status: "queued" | "pending" | "ready" | "unavailable"; text?: string };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let owner = "", epoch = 0, revision = 0, scheduled = false, busy = false;
const publish = () => { revision++; for (const listener of listeners) listener(); };
export const subscribeDisplayTranslations = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const displayTranslationRevision = () => revision;

function currentOwner() {
    const state = useUserStore.getState();
    return state.status === "authenticated" ? state.user?.id || "" : "";
}
function synchronizeOwner() {
    const next = currentOwner();
    if (next !== owner) { owner = next; epoch++; entries.clear(); }
    return next;
}
useUserStore.subscribe(() => {
    const previous = owner;
    synchronizeOwner();
    if (previous !== owner) publish();
});

/** Display-only, memory-only, account-partitioned. Never writes source content. */
export function displayText(source: string): string {
    if (getUiLocale() !== "en-US") return source;
    synchronizeOwner();
    const fixed = canvasResourceDisplayLabel(uiText(source));
    if (fixed !== source || !hasChinese.test(source) || isTransportValue(source)) return fixed;
    return entries.get(source)?.text ?? source;
}
export function displayTranslationStatus(source: string) {
    synchronizeOwner();
    return entries.get(source)?.status;
}
export function queueDisplayTranslations(sources: Iterable<string>) {
    if (getUiLocale() !== "en-US" || !synchronizeOwner()) return;
    for (const source of sources) {
        if (!hasChinese.test(source) || isTransportValue(source) || canvasResourceDisplayLabel(uiText(source)) !== source || entries.has(source)) continue;
        // Keep a bounded session cache. Oversized source remains available in full.
        if (entries.size >= 2000) continue;
        if (source.length > 12000) { entries.set(source, { status: "unavailable" }); continue; }
        entries.set(source, { status: "queued" });
    }
    schedule();
}
function schedule() {
    if (scheduled || busy) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; void flush(); }, 150);
}
async function flush() {
    if (busy || getUiLocale() !== "en-US" || !synchronizeOwner()) return;
    const sources: string[] = [];
    let characters = 0;
    for (const [source, entry] of entries) {
        if (entry.status !== "queued") continue;
        if (sources.length && (sources.length >= 24 || characters + source.length > 12000)) break;
        sources.push(source); characters += source.length;
    }
    if (!sources.length) return;
    const requestOwner = owner, requestEpoch = epoch;
    for (const source of sources) entries.set(source, { status: "pending" });
    busy = true;
    try {
        const translations = await requestDisplayTranslations(sources, requestOwner);
        if (requestEpoch !== epoch || requestOwner !== currentOwner()) return;
        sources.forEach((source, index) => entries.set(source, { status: "ready", text: translations[index] }));
    } catch {
        if (requestEpoch === epoch && requestOwner === currentOwner()) for (const source of sources) entries.set(source, { status: "unavailable" });
        // No automatic retries: a lost response may still have reached the model.
    } finally {
        busy = false; publish();
        if (getUiLocale() === "en-US" && [...entries.values()].some(entry => entry.status === "queued")) schedule();
    }
}
