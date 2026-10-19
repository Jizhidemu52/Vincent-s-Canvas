import { z } from "zod";
import { makeCursorPage, parseCursorPage } from "./cursor-pagination";

export const assetBatchSchema = z.object({
  action: z.enum(["delete", "download", "add-to-canvas", "move-project"]),
  assetIds: z.array(z.string().uuid()).min(1).max(50).refine(ids => new Set(ids).size === ids.length, "素材不能重复"),
  projectId: z.string().uuid().optional(),
}).superRefine((input, context) => {
  if (input.action === "move-project" && !input.projectId) context.addIssue({ code: "custom", path: ["projectId"], message: "请选择目标项目" });
});

export function parseAssetListQuery(query: Record<string, unknown>) {
  const input = z.object({
    kind: z.enum(["image", "video", "text", "other"]).optional(),
    q: z.string().trim().max(200).optional(), projectId: z.string().uuid().optional(),
    ownerUserId: z.string().uuid().optional(),
  }).parse(query);
  const page = parseCursorPage(query);
  const cursor = page.cursor ? { time: page.cursor.createdAt, id: z.string().uuid().parse(page.cursor.id) } : undefined;
  return { ...input, limit: page.limit, cursor };
}

export function assetPage<T extends { id: string; createdAt: string | Date }>(rows: T[], limit: number) {
  const { items, ...page } = makeCursorPage(rows, limit, item => ({ id: item.id, createdAt: typeof item.createdAt === "string" ? item.createdAt : item.createdAt.toISOString() }));
  return { assets: items, ...page };
}

export const assetListMetadataFields = ["title", "tags", "source", "width", "height", "naturalWidth", "naturalHeight", "module", "imageName", "imageVersion"] as const;
export function lightAssetMetadata(metadata: Record<string, unknown>) {
  return Object.fromEntries(assetListMetadataFields.filter(key => metadata[key] !== undefined).map(key => [key, metadata[key]]));
}
