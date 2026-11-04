export type HistoryDeletionResult = { deletedIds: string[]; failedIds: string[] };

/** Keep individual persistence receipts: one failed record must not hide successful removals. */
export async function deleteHistoryEntries<T extends { id: string }>(entries: T[], remove: (entry: T) => Promise<unknown>): Promise<HistoryDeletionResult> {
    const unique = [...new Map(entries.map(entry => [entry.id, entry])).values()];
    const settled = await Promise.allSettled(unique.map(entry => Promise.resolve().then(() => remove(entry))));
    return {
        deletedIds: unique.filter((_, index) => settled[index]?.status === "fulfilled").map(entry => entry.id),
        failedIds: unique.filter((_, index) => settled[index]?.status === "rejected").map(entry => entry.id),
    };
}
