/** Update a sorted history in memory without rereading every IndexedDB record. */
export function upsertGenerationLog<T extends { id: string; createdAt: number }>(logs: T[], log: T): T[] {
    const next = logs.filter((item) => item.id !== log.id);
    const index = next.findIndex((item) => item.createdAt < log.createdAt);
    next.splice(index < 0 ? next.length : index, 0, log);
    return next;
}
