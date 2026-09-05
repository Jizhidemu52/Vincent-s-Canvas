import type { ViewportTransform } from "@/types/canvas";

const MINIMUM_OVERSCAN = 280;
const OVERVIEW_SCREEN_OVERSCAN = 96;
const DETAIL_VIEWPORT_OVERSCAN_RATIO = 0.65;

export function canvasViewportOverscan(viewport: ViewportTransform, width: number, height: number, mode: "detail" | "overview" = "detail"): number {
    const scale = Math.max(viewport.k, 0.0001);
    if (mode === "overview") return OVERVIEW_SCREEN_OVERSCAN / scale;
    // The interaction layer refreshes virtualized content after roughly half
    // a viewport of motion. A 0.65-screen buffer still leaves room after that
    // refresh point, while mounting materially fewer detailed node DOM trees.
    return Math.max(MINIMUM_OVERSCAN, (Math.max(width, height) * DETAIL_VIEWPORT_OVERSCAN_RATIO) / scale);
}
