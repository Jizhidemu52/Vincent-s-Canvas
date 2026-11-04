import type { Position } from "@/types/canvas";
import { canvasOnboardingAvailableArea } from "./canvas-onboarding-state";
export { fitCanvasNodes } from "./canvas-node-size";

export function ignoreCanvasPromptKey(event: { isComposing?: boolean; keyCode?: number; repeat?: boolean }) {
    return Boolean(event.isComposing || event.keyCode === 229 || event.repeat);
}

/** Use the same visible horizontal region as the empty-state guide. */
export function canvasUsableArea(container: HTMLElement | null, fallback: { width: number; height: number }) {
    const bounds = container?.getBoundingClientRect();
    if (!bounds) return { left: 0, top: 80, width: fallback.width, height: Math.max(1, fallback.height - 160) };
    const panels = [...(container?.closest(".cw-workspace")?.querySelectorAll<HTMLElement>(".cw-create-panel, .cw-agent-panel, .cw-generator-mobile") || [])]
        .filter(panel => !panel.classList.contains("is-collapsed") && !panel.classList.contains("is-hidden") && getComputedStyle(panel).display !== "none" && getComputedStyle(panel).visibility !== "hidden")
        .map(panel => panel.getBoundingClientRect());
    return { ...canvasOnboardingAvailableArea(bounds, panels), top: 80, height: Math.max(1, bounds.height - 160) };
}

/** Imported images are fitted within 640px, so these cells never overlap. */
export function canvasImportGridPosition(origin: Position, index: number, count: number): Position {
    const columns = Math.min(4, Math.ceil(Math.sqrt(count)));
    return { x: origin.x + (index % columns) * 688, y: origin.y + Math.floor(index / columns) * 688 };
}
