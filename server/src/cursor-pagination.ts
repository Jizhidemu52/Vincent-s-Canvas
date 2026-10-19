import { z } from "zod";

export type PageCursor = { createdAt: string; id: string };
const cursorSchema = z.tuple([z.string().datetime({ offset: true }), z.string().min(1).max(200)]);

export function encodeCursor(cursor: PageCursor) {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id])).toString("base64url");
}

export function parseCursorPage(query: unknown, options: { defaultLimit?: number; maxLimit?: number } = {}) {
  const parsed = z.object({
    limit: z.coerce.number().int().min(1).max(options.maxLimit ?? 200).default(options.defaultLimit ?? 60),
    cursor: z.string().max(1200).optional(),
  }).parse(query);
  let cursor: PageCursor | null = null;
  if (parsed.cursor) {
    let decoded: unknown;
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(parsed.cursor)) throw new Error("Invalid encoding");
      decoded = JSON.parse(Buffer.from(parsed.cursor, "base64url").toString("utf8"));
    } catch {
      decoded = null;
    }
    const [createdAt, id] = cursorSchema.parse(decoded);
    cursor = { createdAt, id };
  }
  return { limit: parsed.limit, cursor };
}

/** Pass LIMIT + 1 rows, and preserve the database timestamp precision in the key. */
export function makeCursorPage<T>(rows: T[], limit: number, getKey: (item: T) => PageCursor) {
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return { items, hasMore, nextCursor: hasMore && items.length ? encodeCursor(getKey(items[items.length - 1])) : null };
}
