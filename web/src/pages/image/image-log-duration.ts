import { completedTaskDurationMs } from "@/lib/completed-task-duration";
import type { QueuedTask } from "@/services/api/generation-tasks";

type TimingLog = {
    status: string;
    durationMs: number | null;
    images: Array<{ sourceTaskId?: string; durationMs: number | null }>;
};

/** Recheck only the selected history record; never generate, resume or scan other logs. */
export async function refreshImageLogDuration<T extends TimingLog>(log: T, read: (id: string) => Promise<QueuedTask | null>): Promise<T> {
    if (log.status !== "成功") return log;
    const ids = [...new Set(log.images.map(image => image.sourceTaskId).filter((id): id is string => Boolean(id)))];
    const durations = new Map<string, number | null>();
    await Promise.all(ids.map(async id => {
        try {
            const task = await read(id);
            if (task?.id === id && task.status === "success") durations.set(id, completedTaskDurationMs(task));
        } catch { /* A failed lookup cannot erase an existing successful result. */ }
    }));
    if (!durations.size) return log;
    const images = log.images.map(image => image.sourceTaskId && durations.has(image.sourceTaskId) ? { ...image, durationMs: durations.get(image.sourceTaskId)! } : image);
    // Current records hold one original task. A mixed historical record has no
    // single task duration; do not add parallel durations or use browser time.
    const allChecked = images.every(image => image.sourceTaskId && durations.has(image.sourceTaskId));
    const durationMs = allChecked ? ids.length === 1 ? durations.get(ids[0]!)! : null : log.durationMs;
    return { ...log, images, durationMs };
}
