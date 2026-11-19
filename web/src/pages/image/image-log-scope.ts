export type ImageLogOrigin = {
    ownerId?: string;
    tool?: string;
    images: Array<{ sourceTaskId?: string }>;
};

type SourceTask = {
    userId?: string;
    ownerUserId?: string;
    parameters?: Record<string, unknown>;
};

export function imageLogMatchesTool(recordTool: string, currentTool: string) {
    return recordTool === currentTool || currentTool === "image-edit" && recordTool === "image-generation";
}

/** Read source identity, never infer a tool from a prompt, model or operation type. */
export async function partitionImageLogs<T extends ImageLogOrigin>(
    records: T[],
    scope: { ownerId: string; tool: string },
    readTask: (id: string) => Promise<SourceTask | null>,
): Promise<{ logs: T[]; unclassified: T[] }> {
    const tasks = new Map<string, Promise<SourceTask | null>>();
    const loadTask = (id: string) => {
        if (!tasks.has(id)) tasks.set(id, readTask(id).catch(() => null));
        return tasks.get(id)!;
    };
    const logs: T[] = [];
    const unclassified: T[] = [];
    for (const record of records) {
        if (record.ownerId && record.ownerId !== scope.ownerId) continue;
        if (record.tool) {
            if (imageLogMatchesTool(record.tool, scope.tool)) logs.push(record);
            continue;
        }
        // Existing records can be identified by their original task without rewriting them.
        const ids = [...new Set(record.images.map(image => image.sourceTaskId))];
        const sources = ids.length && ids.every((id): id is string => Boolean(id))
            ? await Promise.all(ids.map(loadTask)) : [];
        if (sources.some(task => task && (task.userId || task.ownerUserId) && (task.userId || task.ownerUserId) !== scope.ownerId)) continue;
        const tools = sources.map(task => task?.parameters?.tool);
        const tool = tools[0];
        if (typeof tool !== "string" || !tool || tools.some(value => value !== tool)) {
            unclassified.push(record);
        } else if (imageLogMatchesTool(tool, scope.tool)) {
            logs.push({ ...record, tool, ownerId: scope.ownerId });
        }
    }
    return { logs, unclassified };
}
