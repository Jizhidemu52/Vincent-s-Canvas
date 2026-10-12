import type { CanvasCompareSource } from "@/types/canvas";

type CompareSourceInput = { content?: string; url?: string; dataUrl?: string; storageKey?: string; title?: string; originalFileName?: string };

/** Capture an immutable media identity, not a node ID whose image can later change. */
export function canvasCompareSource(input: CompareSourceInput): CanvasCompareSource {
    const candidates = [input.content, input.url, input.dataUrl];
    const content = candidates.find(value => value && (!input.storageKey || !value.startsWith("data:"))) || "";
    const label = input.originalFileName || input.title;
    return { type: "image", content, ...(input.storageKey ? { storageKey: input.storageKey } : {}), ...(label ? { label } : {}) };
}
