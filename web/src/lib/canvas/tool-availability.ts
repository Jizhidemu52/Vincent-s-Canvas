import type { ModuleKey } from "@/services/api/modules";

/** Local design tools share a switch; downloading existing work is always available. */
export const canvasActionModules: Partial<Record<string, ModuleKey>> = {
    referenceImport: "reference-import", group: "canvas-local-tools",
    compare: "canvas-local-tools", designTemplate: "canvas-local-tools", manualEdit: "canvas-local-tools",
    imageSequence: "canvas-image",
    crop: "canvas-local-tools", split: "canvas-local-tools", upscale: "canvas-local-tools", resize: "canvas-local-tools",
    maskEdit: "canvas-mask-edit", angle: "canvas-angle", reversePrompt: "canvas-chat",
    generateImage: "canvas-image", generate: "canvas-image", batch: "canvas-batch",
};
