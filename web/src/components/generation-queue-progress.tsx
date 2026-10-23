import { useEffect, useState } from "react";
import { getQueuedTaskProgress, type QueuedTaskProgress } from "@/services/api/generation-tasks";
import { useUserStore } from "@/stores/use-user-store";
import { watchTaskEvents } from "@/services/api/task-events";

type ProgressView = { progress: QueuedTaskProgress | null; unavailable: boolean };

/** A separate, low-frequency read-only query; never controls/resubmits a task. */
export function watchGenerationProgress(
    taskId: string,
    publish: (view: ProgressView) => void,
    visibility: Pick<Document, "hidden" | "addEventListener" | "removeEventListener"> = document,
    load = getQueuedTaskProgress,
    intervalMs = 15_000,
) {
    let disposed = false, terminal = false, controller: AbortController | null = null;
    const events = watchTaskEvents([taskId]);
    const stopRequest = () => {
        controller?.abort();
        controller = null;
    };
    const poll = async () => {
        if (disposed || terminal || visibility.hidden || controller) return;
        const current = new AbortController();
        controller = current;
        const revision = events.version;
        try {
            const progress = await load(taskId, current.signal);
            if (disposed || current.signal.aborted) return;
            publish({ progress, unavailable: !progress });
            terminal = !progress || progress.phase === "complete" || progress.phase === "paused";
        } catch {
            if (!disposed && !current.signal.aborted) publish({ progress: null, unavailable: true });
        } finally {
            if (!disposed && !current.signal.aborted && !terminal && !visibility.hidden) {
                try { await events.next(revision, intervalMs, current.signal, 5_000); }
                catch { if (!current.signal.aborted) terminal = true; }
                if (controller === current) controller = null;
                if (!disposed && !current.signal.aborted && !terminal && !visibility.hidden) void poll();
            } else if (controller === current) controller = null;
            if (terminal) events.close();
        }
    };
    const onVisibility = () => {
        stopRequest();
        if (!visibility.hidden) void poll();
    };
    visibility.addEventListener("visibilitychange", onVisibility);
    void poll();
    return () => {
        disposed = true;
        stopRequest();
        events.close();
        visibility.removeEventListener("visibilitychange", onVisibility);
    };
}

export function generationProgressText(progress: QueuedTaskProgress): string {
    if (progress.phase === "complete") return progress.status === "success" ? "生成完成" : progress.status === "cancelled" ? "任务已取消" : "生成失败";
    if (progress.phase === "paused") return "任务已暂停，请查询原任务";
    const stage = progress.runtime === "demo" ? "生成中（本机无共享排队）"
        : progress.phase === "waiting" ? progress.queuePosition === null ? "排队中，名次暂不可用" : `同模型可运行队列第 ${progress.queuePosition} 位`
        : progress.phase === "delayed" ? "等待调度重试"
        : progress.phase === "preparing" ? "正在准备生成" : "正在生成";
    if (progress.estimatedRemainingSeconds === null) return `${stage} · 暂无可靠耗时估算`;
    const wait = progress.estimatedWaitSeconds;
    return `${stage}${wait !== null && wait > 0 ? ` · 预计排队约 ${humanSeconds(wait)}` : ""} · 预计还需约 ${humanSeconds(progress.estimatedRemainingSeconds)}（仅供参考）`;
}

function humanSeconds(seconds: number) {
    return seconds < 60 ? `${Math.max(1, Math.ceil(seconds / 5) * 5)} 秒` : `${Math.ceil(seconds / 60)} 分钟`;
}

/** Mount only for the generation being viewed, never once per history item. */
export function GenerationQueueProgress({ taskId, active }: { taskId?: string | null; active: boolean }) {
    const ownerId = useUserStore(state => state.user?.id);
    const [view, setView] = useState<ProgressView>({ progress: null, unavailable: false });
    useEffect(() => {
        setView({ progress: null, unavailable: false });
        if (!active || !taskId) return;
        return watchGenerationProgress(taskId, setView);
    }, [taskId, active, ownerId]);
    if (!active || !taskId) return null;
    const text = view.progress ? generationProgressText(view.progress)
        : view.unavailable ? "排队状态暂不可用，生成仍在继续" : "正在查询排队状态…";
    return <span role="status" className="text-xs text-muted-foreground" title="名次只含当前同模型可运行队列，按实际优先级排序；预计时间基于最近 7 天最多 30 次同类成功任务，不是完成时间保证，可能受插队、调度和上游速度影响。">{text}</span>;
}
