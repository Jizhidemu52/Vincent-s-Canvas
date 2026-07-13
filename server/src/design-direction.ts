export const designDirections = [
  "pattern", "apparel", "product", "image_edit", "detail_enhance",
  "angle_control", "batch_edit", "seamless_stitch",
] as const;

export type DesignDirection = (typeof designDirections)[number];
export const directionRuleVersion = "v1";

const operationDirections: Record<string, DesignDirection> = {
  seamless_stitch: "seamless_stitch",
  upscale: "detail_enhance",
  batch_image: "batch_edit",
  remove_background: "image_edit",
};

const keywordRules: Array<{ direction: DesignDirection; pattern: RegExp }> = [
  { direction: "pattern", pattern: /花型|图案|印花|纹样|四方连续|pattern|print/i },
  { direction: "apparel", pattern: /服装|款式|上衣|裙|裤|外套|garment|apparel|fashion/i },
  { direction: "product", pattern: /商品|产品|白底|电商|product|catalog/i },
  { direction: "angle_control", pattern: /角度|视角|正面|侧面|俯视|angle|view/i },
  { direction: "detail_enhance", pattern: /细节|增强|高清|放大|upscale|detail/i },
];

export function classifyDesignDirection(input: {
  operationType?: string | null;
  prompt?: string | null;
  tool?: unknown;
  adminTags?: string[];
}) {
  const adminDirection = input.adminTags?.find((tag): tag is DesignDirection =>
    designDirections.includes(tag as DesignDirection));
  if (adminDirection) {
    return result(adminDirection, [], "admin_tag", adminDirection);
  }
  if (input.tool === "angle-control") return result("angle_control", [], "tool", "angle-control");
  const operationDirection = input.operationType ? operationDirections[input.operationType] : undefined;
  const keywords = keywordRules.filter((rule) => rule.pattern.test(input.prompt ?? "")).map((rule) => rule.direction);
  if (operationDirection) return result(operationDirection, keywords.filter((item) => item !== operationDirection), "operation_type", input.operationType!);
  if (input.operationType === "inpaint") {
    const primary = keywords[0] ?? "image_edit";
    const secondary: DesignDirection[] = ["image_edit", ...keywords.slice(1)];
    return result(primary, secondary.filter((item) => item !== primary), keywords[0] ? "prompt_keyword" : "operation_type", keywords[0] ?? "inpaint");
  }
  const primary = keywords[0] ?? "product";
  return result(primary, keywords.slice(1), keywords[0] ? "prompt_keyword" : "fallback", keywords[0] ?? "product");
}

function result(primaryDirection: DesignDirection, secondaryDirections: DesignDirection[], source: string, matched: string) {
  return {
    primaryDirection,
    secondaryDirections: [...new Set(secondaryDirections)],
    ruleVersion: directionRuleVersion,
    evidence: { source, matched },
  };
}
