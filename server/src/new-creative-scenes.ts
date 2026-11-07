import { z } from "zod";
import { carryoverRequirementsSchema } from "../../shared/design-brief";
import type { PromptInput } from "../../shared/prompt-contracts";
import { PromptOptimizationError } from "./prompt-safety";

const common = {
  description: z.string().trim().max(4000).default(""),
  keepDetails: z.string().trim().max(2000).optional(),
  carryoverRequirements: carryoverRequirementsSchema.optional(),
};
const tryOnFields = z.object(common).strict();
const sketchFields = z.object({ ...common,
  fabric: z.string().trim().min(1).max(500),
  colorDescription: z.string().trim().min(1).max(500),
  presentation: z.enum(["白底平铺", "白底悬浮"]),
}).strict();

export function newCreativeFields(input: PromptInput): Record<string, unknown> | undefined {
  const schema = input.scene === "virtual-try-on" ? tryOnFields : input.scene === "sketch-to-photo" ? sketchFields : null;
  if (!schema) return undefined;
  const parsed = schema.safeParse(input.fields);
  if (!parsed.success) throw new PromptOptimizationError("PROMPT_FIELDS_INVALID", input.scene === "sketch-to-photo"
    ? "线稿转实拍需要有效的面料、配色和展示方式，描述或保留要求不能超过长度限制，未提交优化。"
    : "虚拟试穿的模特与画面描述、保留特征或沿用要求格式无效或超过长度限制，未提交优化。", 400);
  return structuredClone(parsed.data);
}

/** Validate form-specific contracts before any source read or paid optimization. */
export function validateNewCreativeReferences(input: PromptInput, fields: Record<string, unknown>, sourceCount: number) {
  if (input.scene !== "virtual-try-on" && input.scene !== "sketch-to-photo") return;
  if (input.mode !== "edit" || input.hasMask || input.maskReferenceIndex !== undefined) throw new PromptOptimizationError("PROMPT_OPERATION_INVALID", "此场景仅支持整图参考编辑，不支持选区或生成模式", 400);
  if (sourceCount < 1 || sourceCount > 2) throw new PromptOptimizationError("PROMPT_REFERENCE_INVALID", "此场景需要一张主图，最多附加一张辅助参考图，未提交优化", 400);
  if (input.scene === "virtual-try-on" && sourceCount === 1 && !String(fields.description ?? "").trim()) throw new PromptOptimizationError("PROMPT_FIELDS_INVALID", "未上传模特图时，请填写成年模特与画面描述，未提交优化", 400);
  const roles = (input.scene === "virtual-try-on" ? ["产品图", "模特图"] : ["线稿图", "材质与配色参考图"]).slice(0, sourceCount);
  if (input.referenceRoles.length && (input.referenceRoles.length !== roles.length || input.referenceRoles.some((role, index) => role !== roles[index]))) {
    throw new PromptOptimizationError("PROMPT_REFERENCE_INVALID", "参考图顺序或分工与当前场景不一致，未提交优化", 400);
  }
  input.referenceRoles = roles;
}
