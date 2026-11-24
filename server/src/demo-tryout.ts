import type { TaskSubmission } from "../../shared/task-contracts";
import { colorPrompt, materialEdit, tryoutImageOptions, wearPrompt } from "../../shared/tryout-prompts";
import { outfitTryout, refineTryout, type TryoutSubmission } from "../../shared/tryout-submission";
import { DemoToolConfigurationError } from "./demo-tool-configuration";
import type { z } from "zod";

export const demoMaterialPresets = [
  ["粗针", "粗针羊毛针织，线圈粗大清晰，表面蓬松厚实。"],
  ["罗纹", "针织纵向罗纹，凸条与凹槽均匀交替，有弹性。"],
  ["绞花", "针织线圈交叉形成有起伏的绞花纹理，纹路沿产品走向延伸。"],
  ["马海毛", "表面覆盖轻盈细长的毛羽，边缘柔和，织物透气蓬松。"],
  ["摇粒绒", "密集细小的卷曲绒粒，表面柔软哑光，绒面均匀。"],
  ["灯芯绒", "表面有平行纵向绒条与窄凹槽，顺毛处轻微反光。"],
].map(([name, description], index) => ({ id: `60000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, name: name!, description: description!, thumbAssetId: null }));

export type DemoTryoutInput = TryoutSubmission | z.output<typeof refineTryout> | z.output<typeof outfitTryout>;
type Portrait = { id: string; name: string };
type Material = { description: string; useColor: boolean };
type Prior = { status: string; projectId?: string; prompt?: string; sourceUrls?: string[]; parameters?: Record<string, unknown> };
type Recipe = { kind: TryoutSubmission["kind"]; prompt: string; sourceUrls: string[]; model?: { assetId: string; name: string } };
const content = (id: string) => `/api/assets/${id}/content`;

export function demoTryoutTask(input: DemoTryoutInput, options: {
  requestId: string;
  modelConfigId: string;
  portraits: Portrait[];
  materials: Map<string, Material>;
  prior: (taskId: string) => Prior | undefined;
}): TaskSubmission {
  const { requestId, modelConfigId, portraits, materials, prior } = options;
  const tier = input.kind === "refine" ? "hd" : input.kind === "outfit" ? "quick" : input.tier;
  let recipe: Recipe;
  if (input.kind === "color") {
    recipe = { kind: input.kind, prompt: colorPrompt(null, input.part ?? null, input.color, input.fallbackHex), sourceUrls: [content(input.sourceAssetId)] };
  } else if (input.kind === "material") {
    if (input.boundary) throw new DemoToolConfigurationError("TRYOUT_REGION_UNAVAILABLE", "本机试款支持整件换材质");
    const selection = input.material;
    const spec = (() => {
      if ("presetId" in selection) {
        const preset = demoMaterialPresets.find(entry => entry.id === selection.presetId);
        return preset && { type: "text" as const, name: preset.name, description: preset.description };
      }
      const photo = materials.get(selection.assetId);
      return photo && { type: "photo" as const, assetId: selection.assetId, ...photo };
    })();
    if (!spec) throw new DemoToolConfigurationError("TRYOUT_MATERIAL_UNAVAILABLE", "该材质不存在或已移除");
    const result = materialEdit(input.sourceAssetId, null, input.part ?? null, spec, input.fallbackHex);
    recipe = { kind: input.kind, prompt: result.prompt, sourceUrls: result.ids.map(content) };
  } else if (input.kind === "wear") {
    const selection = input.model;
    const model = "auto" in selection ? portraits[0] : "assetId" in selection ? portraits.find(entry => entry.id === selection.assetId) : undefined;
    if (!model) throw new DemoToolConfigurationError("TRYOUT_MODEL_UNAVAILABLE", "请先在试款台上传个人模特");
    recipe = { kind: input.kind, prompt: wearPrompt(input.productAssetIds.map(() => null)), sourceUrls: [model.id, ...input.productAssetIds].map(content), model: { assetId: model.id, name: model.name } };
  } else {
    const original = prior(input.kind === "refine" ? input.sourceTaskId : input.originTaskId);
    const kind = original?.parameters?.tryoutKind;
    const node = input.kind === "refine" ? input.nodeId : input.originNodeId;
    if (!original || original.status !== "success" || original.projectId !== input.canvasId || original.parameters?.tryoutNodeId !== node || !original.prompt || !original.sourceUrls?.length || (kind !== "color" && kind !== "material" && kind !== "wear")) {
      throw new DemoToolConfigurationError("TRYOUT_ORIGIN_UNAVAILABLE", "请选择当前画布中已生成的试款图");
    }
    const model = original.parameters?.tryoutModel as Recipe["model"];
    if (input.kind === "refine") {
      if (original.parameters?.tryoutTier !== "quick") throw new DemoToolConfigurationError("TRYOUT_ORIGIN_UNAVAILABLE", "请选择快速档结果");
      recipe = { kind, prompt: original.prompt, sourceUrls: original.sourceUrls, model };
    } else {
      const sourceUrls = [...original.sourceUrls, content(input.sourceAssetId)];
      if (kind !== "wear" || sourceUrls.length > 5 || new Set(sourceUrls).size !== sourceUrls.length) throw new DemoToolConfigurationError("TRYOUT_REFERENCES", "请选择一套上身图和至多四件不同产品");
      recipe = { kind, prompt: wearPrompt(sourceUrls.slice(1).map(() => null)), sourceUrls, model };
    }
  }
  return {
    requestId, projectId: input.canvasId, toolKey: "canvas-edit", operationType: "inpaint", modelConfigId,
    prompt: recipe.prompt, sourceUrls: recipe.sourceUrls, priority: "normal",
    parameters: { ...tryoutImageOptions(recipe.kind, tier), tryoutTier: tier, tryoutKind: recipe.kind, tryoutNodeId: input.nodeId, ...(recipe.model ? { tryoutModel: recipe.model } : {}) },
  };
}
