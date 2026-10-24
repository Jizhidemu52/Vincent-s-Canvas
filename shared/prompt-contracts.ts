import { z } from "zod";

/** Public input vocabulary only. Authoring rules are never bundled into the client. */
export const promptScenes = [
  "text-to-style", "style-to-sketch", "local-restyle", "garment-colorway", "back-design",
  "pattern-extract", "pattern-colorway", "accessory-design", "pattern-craft", "series-recipe",
  "workflow-step", "print-placement", "garment-presentation", "free-optimize", "batch-optimize", "reverse-prompt",
] as const;
export const promptInputSchema = z.object({
  scene: z.enum(promptScenes),
  fields: z.record(z.string().max(100), z.unknown()).default({}),
  userText: z.string().max(20_000).default(""),
  referenceRoles: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  mode: z.enum(["generate", "edit"]).default("edit"),
  outputLanguage: z.enum(["en", "zh"]).optional(),
  hasMask: z.boolean().default(false),
  maskReferenceIndex: z.number().int().min(1).max(49).optional(),
  compilationId: z.string().uuid().optional(),
}).strict().superRefine((input, context) => {
  if (JSON.stringify(input.fields).length > 30_000) context.addIssue({ code: "custom", message: "场景设置超过 30 KB" });
});
export type PromptInput = z.infer<typeof promptInputSchema>;
export type PromptScene = typeof promptScenes[number];
export type PromptInputData = z.input<typeof promptInputSchema>;

export const promptCompilationRequestSchema = z.object({
  requestId: z.string().min(8).max(200).regex(/^[a-zA-Z0-9:_-]+$/),
  modelConfigId: z.string().min(1).max(200),
  toolKey: z.string().max(100).optional(),
  promptInput: promptInputSchema,
  sourceUrls: z.array(z.string().max(2_000)).max(50).default([]),
}).strict();
export type PromptCompilationRequest = z.infer<typeof promptCompilationRequestSchema>;
export type PublicPromptCompilation = {
  id: string;
  requestId: string;
  status: "optimizing" | "success" | "failed" | "uncertain";
  prompt?: string;
  summaryZh?: string;
  optimized: boolean;
  errorCode?: string;
  message?: string;
};

export function requiredPromptScene(toolKey: string | undefined): PromptScene | undefined {
  if (toolKey === "series-recipe") return "series-recipe";
  const key = toolKey?.replace(/^creative-/, "");
  return toolKey?.startsWith("creative-") && (promptScenes.slice(0, 9) as readonly string[]).includes(key!) ? key as PromptScene : undefined;
}

export const promptRecipeSettingsSchema = z.object({
  name: z.string().trim().min(1).max(120), enabled: z.boolean(),
  modelConfigId: z.string().min(1).max(200).nullable(),
  failurePolicy: z.enum(["stop", "fallback"]).default("stop"),
});
export const promptRecipeVersionSchema = z.object({
  systemPrompt: z.string().trim().min(1).max(100_000),
  fieldTemplate: z.string().max(30_000).default(""),
  modelOverrides: z.record(z.string().max(200), z.string().max(30_000)).default({}),
  fallbackPrompt: z.string().max(20_000).default(""),
  outputLanguage: z.enum(["en", "zh"]).default("en"),
  changeNote: z.string().trim().max(2_000).default(""),
});
export type PromptRecipeSettings = z.infer<typeof promptRecipeSettingsSchema>;
export type PromptRecipeVersionContent = z.infer<typeof promptRecipeVersionSchema>;
export type AdminPromptRecipeVersion = PromptRecipeVersionContent & { id: string; recipeKey: string; version: number; contentHash: string; createdBy: string; createdAt: string };
export type AdminPromptRecipe = PromptRecipeSettings & { key: string; currentVersionId: string | null; updatedAt: string };
export type PromptRecipeStats = {
  total: number; success: number; failed: number; cacheHits: number; averageLatencyMs: number | null;
  inputTokens: number; outputTokens: number; actualCost: number; estimatedCost: number; unknownCostCount: number;
  costs: Array<{ currency: string; actual: number; estimated: number; unknownCount: number }>;
};
export type AdminPromptCompilation = PublicPromptCompilation & {
  /** Server-only: explicit administrator recipe test, never accepted from public input. */
  adminTest?: boolean;
  userId: string; recipeKey: string; recipeVersionId: string;
  modelConfigId: string; targetModelConfigId: string;
  inputSnapshot: { promptInput: PromptInput; sourceUrls: string[] };
  inputHash: string; reusedFromId: string | null; cacheHit: boolean;
  rawResponse: string | null; latencyMs: number | null;
  inputTokens: number | null; outputTokens: number | null;
  actualCost: number | null; estimatedCost: number | null; currency: string;
  createdAt: string; completedAt: string | null;
};
