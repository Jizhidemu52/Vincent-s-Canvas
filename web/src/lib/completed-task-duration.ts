import type { QueuedTask } from "@/services/api/generation-tasks";

type TaskTiming = Pick<QueuedTask, "status" | "queuedAt" | "startedAt" | "completedAt" | "createdAt" | "updatedAt">;

/** Queue-to-completion time excludes browser preparation, late recovery and local downloads. */
export function completedTaskDurationMs(task: TaskTiming): number | null {
    if (task.status !== "success") return null;
    // Production timestamps must not fall back to demo fields when missing or invalid.
    const production = "queuedAt" in task || "startedAt" in task || "completedAt" in task;
    const start = production ? task.queuedAt : task.createdAt;
    const end = production ? task.completedAt : task.updatedAt;
    const startedAt = typeof start === "string" && start.trim() ? Date.parse(start) : NaN;
    const completedAt = typeof end === "string" && end.trim() ? Date.parse(end) : NaN;
    return Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt
        ? completedAt - startedAt
        : null;
}
