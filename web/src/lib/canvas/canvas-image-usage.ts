import { canvasToolKey } from "@/hooks/use-tool-config";
import { imageModelProfile } from "@/lib/image-model-settings";
import { modelOptionName } from "@/stores/use-config-store";

/** Price the same operation the canvas submits; Blend references are not an edit. */
export function canvasImageUsageInput(model: string, referenceCount: number, profile = imageModelProfile(model)) {
    const toolKey = canvasToolKey("image", referenceCount > 0, profile.kind);
    return { toolKey, operationType: toolKey === "canvas-edit" ? "inpaint" : "image_generation", modelId: modelOptionName(model), quantity: 1 };
}
