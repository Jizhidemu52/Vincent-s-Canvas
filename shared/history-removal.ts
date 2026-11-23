import { z } from "zod";

export const historyKinds = ["task", "local", "conversation"] as const;
export type HistoryKind = typeof historyKinds[number];
const entry = z.strictObject({ kind: z.enum(historyKinds), id: z.string().uuid().transform(id => id.toLowerCase()) });
export type HistoryEntry = z.infer<typeof entry>;
export const historyRemoval = z.strictObject({ entries: z.array(entry).min(1).max(100) })
    .refine(input => new Set(input.entries.map(historyEntryKey)).size === input.entries.length, "包含重复的记录");
export function historyEntryKey(entry: HistoryEntry) { return entry.kind + ":" + entry.id; }
export const historyTerminalStates = ["success", "failed", "cancelled"];
export function historyTaskRemovable(status:string, documentStatus?:string) {
    return historyTerminalStates.includes(status)&&documentStatus!=="partial"&&documentStatus!=="persisting";
}
