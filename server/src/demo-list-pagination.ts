import { z } from "zod";
import { makeCursorPage, parseCursorPage } from "./cursor-pagination";

export function pageDemoRecords<T extends { id: string; createdAt: string }>(rows: T[], query: unknown) {
  const { cursor, limit } = parseCursorPage(query);
  const boundary = cursor ? new Date(cursor.createdAt).toISOString() : null;
  const ordered = rows.filter(row => !cursor || row.createdAt < boundary! || (row.createdAt === boundary && row.id < cursor.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return makeCursorPage(ordered.slice(0, limit + 1), limit, row => ({ createdAt: row.createdAt, id: row.id }));
}

export function parseDemoTaskFilters(query: unknown) {
  const parsed = z.object({ ids: z.string().max(7500).optional(), operationType: z.string().min(1).max(80).optional() }).parse(query);
  return { operationType: parsed.operationType, ids: parsed.ids ? z.array(z.string().uuid()).min(1).max(200).parse(parsed.ids.split(",")) : null };
}

export function demoTaskSummary<T extends { prompt?: string; parameters?: unknown; sourceUrls?: unknown }>(task: T) {
  const { parameters: _parameters, sourceUrls: _sourceUrls, ...row } = task;
  return { ...row, prompt: task.prompt?.slice(0, 240) || "" };
}
