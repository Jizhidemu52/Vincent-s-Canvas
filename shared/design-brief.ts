import { z } from "zod";

/** User-authored constraints, never executable or trusted system instructions. */
export const carryoverRequirementsSchema = z.array(z.string().trim().min(1).max(800)).max(12).superRefine((items, context) => {
  if (items.join("\n").length > 6000) context.addIssue({ code: "custom", message: "沿用设计要求总长度不能超过 6000 字符" });
});

export const designBriefSchema = z.object({
  version: z.literal(1),
  sourceScene: z.string().trim().min(1).max(100),
  requirements: carryoverRequirementsSchema,
}).strict();
export type DesignBrief = z.infer<typeof designBriefSchema>;

const carriedFields = [
  ["targetProduct", "目标产品"], ["keepDetails", "关键特征"], ["preserve", "保留要求"],
  ["category", "品类"], ["silhouette", "廓形"], ["fabric", "面料"],
] as const;

/** Carry product facts and explicit keep requirements, not the previous operation or its model prompt. */
export function designBriefFromFields(sourceScene: string, fields: Record<string, unknown>): DesignBrief {
  const prior = fields.carryoverRequirements === undefined ? [] : carryoverRequirementsSchema.parse(fields.carryoverRequirements);
  let lines = [...prior];
  for (const [key, label] of carriedFields) {
    const value = fields[key];
    if (typeof value !== "string" || !value.trim() || value === "按描述判断" || value === "整体保持") continue;
    // Long user requirements are kept intact as multiple bounded lines, not silently truncated.
    lines = lines.filter(line => !line.startsWith(`${label}：`));
    const text = value.trim();
    const chunkLength = 800 - label.length - 1;
    for (let start = 0; start < text.length; start += chunkLength) lines.push(`${label}：${text.slice(start, start + chunkLength)}`);
  }
  // Only explicitly specified source colors can survive a later black-and-white sketch.
  if (fields.colorMode === "specific" && Array.isArray(fields.colors) && fields.colors.length && fields.colors.every(value => typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value))) {
    lines = lines.filter(line => !line.startsWith("已指定颜色："));
    lines.push(`已指定颜色：${fields.colors.join("、")}（仅为设计要求，不是实测色差）`);
  }
  return designBriefSchema.parse({ version: 1, sourceScene, requirements: [...new Set(lines)] });
}
