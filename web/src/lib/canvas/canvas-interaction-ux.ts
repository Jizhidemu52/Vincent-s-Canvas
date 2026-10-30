import type { CanvasNodeData, Position, ViewportTransform } from "@/types/canvas";
import { clampCanvasZoom } from "./canvas-zoom";
import { canvasOnboardingAvailableArea } from "./canvas-onboarding-state";

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

export function fitCanvasNodes(nodes: Pick<CanvasNodeData, "position" | "width" | "height">[], area: { left: number; top: number; width: number; height: number }): ViewportTransform {
    if (!nodes.length) return { x: area.left + area.width / 2, y: area.top + area.height / 2, k: 1 };
    const left = Math.min(...nodes.map(node => node.position.x));
    const top = Math.min(...nodes.map(node => node.position.y));
    const width = Math.max(...nodes.map(node => node.position.x + node.width)) - left;
    const height = Math.max(...nodes.map(node => node.position.y + node.height)) - top;
    const k = clampCanvasZoom(Math.min(1, Math.max(1, area.width - 64) / Math.max(1, width), Math.max(1, area.height - 64) / Math.max(1, height)));
    return { x: area.left + area.width / 2 - (left + width / 2) * k, y: area.top + area.height / 2 - (top + height / 2) * k, k };
}

/** Imported images are fitted within 640px, so these cells never overlap. */
export function canvasImportGridPosition(origin: Position, index: number, count: number): Position {
    const columns = Math.min(4, Math.ceil(Math.sqrt(count)));
    return { x: origin.x + (index % columns) * 688, y: origin.y + Math.floor(index / columns) * 688 };
}
