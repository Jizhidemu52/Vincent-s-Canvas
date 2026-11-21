import { imageComplexityForTool, type ImageComplexity } from "../../shared/image-complexity";
import { BillingError } from "./billing";

export type ImageAdmissionDefaults = { quality: "low" | "medium" | "high"; complexity: ImageComplexity };
type Target = { protocol: string; modelId: string; workflowConfigId?: string | null };

export function imageAdmissionParameters(parameters: Record<string, unknown>, target: Target | undefined, toolKey: string, hasReferences: boolean, defaults?: ImageAdmissionDefaults) {
    if (!defaults || !target || target.protocol !== "apimart" || target.workflowConfigId) return parameters;
    const gpt = ["gpt-image-2.6-flare", "gpt-image-2.6-sunburst"].includes(target.modelId);
    if (!gpt && target.modelId !== "gemini-nano-banana-2.1") return parameters;
    const next = { ...parameters };
    if (next.size === "follow") {
        if (!hasReferences) throw new BillingError("INVALID_IMAGE_PARAMETERS", "跟随原图需要参考图，请添加图片或选择明确尺寸");
        delete next.size;
    }
    if (gpt) {
        if (next.quality === undefined || next.quality === "auto") next.quality = defaults.quality;
        if (next.complexity === undefined) next.complexity = imageComplexityForTool(toolKey, defaults.complexity);
    }
    return next;
}
