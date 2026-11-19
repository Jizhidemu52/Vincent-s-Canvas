import { z } from "zod";

export const localProcessingBoards = ["creative-pattern-colorway", "creative-local-restyle"] as const;
export const localProcessingOperations = ["recolor", "selection-composite"] as const;
export type LocalProcessingBoard = typeof localProcessingBoards[number];
export type LocalProcessingOperation = typeof localProcessingOperations[number];
const uuid = z.string().uuid().transform(value => value.toLowerCase());

const forbiddenParameterKey = /api[_-]?key|secret|password|credentials?|authorization|(?:access|refresh|auth)[_-]?token|bearer|private[_-]?key|headers|cookie|^token$|^base[_-]?url$|^storageKey$|^dataUrl$|^__proto__$|^constructor$|^prototype$/i;
function safeParameters(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 8000 && !/^(?:blob:|data:)/i.test(value);
  if (Array.isArray(value)) return value.length <= 100 && value.every(item => safeParameters(item, depth + 1));
  return typeof value === "object" && Object.keys(value).length <= 100
    && Object.entries(value).every(([key, item]) => key.length <= 80 && !forbiddenParameterKey.test(key) && safeParameters(item, depth + 1));
}
const recordParameters = z.record(z.string().max(80), z.unknown());
export const localProcessingParametersSchema = z.object({
  form: recordParameters.optional(),
  config: recordParameters.optional(),
  recolor: z.object({
    rules: z.array(z.object({ from: z.string().regex(/^#[\da-f]{6}$/i), to: z.string().regex(/^#[\da-f]{6}$/i) }).strict()).min(1).max(6),
    tolerance: z.number().min(0).max(100),
  }).strict().optional(),
  selection: z.object({ sourceAssetId: uuid, maskAssetId: uuid }).strict().optional(),
}).strict().refine(value => safeParameters(value) && new TextEncoder().encode(JSON.stringify(value)).length <= 32_768,
  "处理参数必须是完整的安全 JSON，不能包含本机地址、凭据或超过 32 KB");

export const localProcessingInputSchema = z.object({
  clientOperationId: uuid,
  assetId: uuid,
  board: z.enum(localProcessingBoards),
  operation: z.enum(localProcessingOperations),
  prompt: z.string().trim().min(1).max(8000),
  parameters: localProcessingParametersSchema,
  sourceAssetIds: z.array(uuid).min(1).max(8).refine(ids => new Set(ids).size === ids.length, "来源图片不能重复"),
  sourceTaskId: uuid.optional(),
}).strict().superRefine((input, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if (input.operation === "recolor") {
    if (input.board !== "creative-pattern-colorway" || !input.parameters.recolor || input.parameters.selection || input.sourceTaskId)
      issue("精确换色只能归档图案配色的本地操作，必须包含颜色映射且不能指定 AI 任务");
  } else {
    const selection = input.parameters.selection;
    if (input.board !== "creative-local-restyle" || !input.sourceTaskId || !selection || input.parameters.recolor)
      issue("选区合成必须关联局部改款原任务和原图、蒙版");
    if (selection && (selection.sourceAssetId === selection.maskAssetId
      || !input.sourceAssetIds.includes(selection.sourceAssetId) || !input.sourceAssetIds.includes(selection.maskAssetId)))
      issue("选区原图与蒙版必须是不同的已归档来源图片");
  }
});

export type LocalProcessingInput = z.infer<typeof localProcessingInputSchema>;
export type LocalProcessingRecord = Omit<LocalProcessingInput, "assetId" | "sourceTaskId"> & {
  version: 1;
  id: string;
  ownerUserId: string;
  outputAssetId: string;
  sourceOutputAssetId: string;
  sourceTaskId: string | null;
  createdAt: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  contentSha256: string;
  contentUrl: string;
  thumbnailUrl: string;
  previewUrl: string;
};
export type LocalProcessingPage = { records: LocalProcessingRecord[]; nextCursor: string | null; hasMore: boolean };
