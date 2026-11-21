export type ImageComplexity = "low" | "medium" | "high";

const medium = new Set(["creative-text-to-style", "creative-virtual-try-on", "creative-back-design"]);
const low = new Set(["canvas-edit", "canvas-mask-edit", "canvas-batch", "image-edit", "creative-garment-colorway", "creative-pattern-colorway", "creative-local-restyle"]);

export function imageComplexityForTool(toolKey: string, fallback: ImageComplexity): ImageComplexity {
    return medium.has(toolKey) ? "medium" : low.has(toolKey) ? "low" : fallback;
}
