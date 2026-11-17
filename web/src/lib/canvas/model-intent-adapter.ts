/**
 * Model Intent Adapter
 * 负责将前端统一的语义交互转化为不同模型底层所需的协议参数
 */

export type ModelIntent = "recolor" | "restyle" | "enhance" | "modify-structure";

export interface ModelCommand {
  intent: ModelIntent;
  params: Record<string, any>;
}

export const getModelAdapter = (modelId: string) => {
  const isGpt26 = modelId.startsWith("gpt-image-2.6-");
  const isNano21 = modelId.includes("nano-banana-2.1");

  return {
    mapIntentToParams: (intent: ModelIntent, userAction: any) => {
      if (isGpt26) {
        return {
          protocol: "structural-manipulation",
          reconstructionFactor: userAction.strength ?? 0.5,
          paletteMapping: userAction.palette ?? "auto",
          structuralConstraint: intent === "modify-structure" ? "strict" : "flexible"
        };
      }
      if (isNano21) {
        return {
          protocol: "diffusion-process",
          denoisingStep: Math.floor(userAction.strength * 40 + 10),
          diffusionKernel: intent === "enhance" ? "sharp" : "smooth",
          quantizedWeight: 0.8
        };
      }
      return { protocol: "standard" };
    },
    getParamLabel: (param: string) => {
      if (isGpt26) return "重构强度";
      if (isNano21) return "去噪步数";
      return "参数";
    }
  };
};

export const useModelIntentAdapter = (modelId: string) => {
  return getModelAdapter(modelId);
};
