import { useEffect, useRef, useState } from "react";
import { App, Button, Tooltip } from "antd";
import { uiText, useUiText } from "@/lib/i18n";
import { canCancelQueuedTask } from "@/lib/generation-task-cancel";
import { generationErrorMessage } from "@/lib/generation-feedback";
import { cancelQueuedTask, getQueuedTask, type QueuedTask } from "@/services/api/generation-tasks";
import { watchTaskEvents } from "@/services/api/task-events";
import { useUserStore } from "@/stores/use-user-store";

/** Cancellation is offered only after reading the original task's server boundary. */
export function GenerationTaskCancel({ taskId }: { taskId?: string }) {
    useUiText();
    const ownerId = useUserStore(state => state.user?.id);
    const { modal, message } = App.useApp();
    const [task, setTask] = useState<QueuedTask | null>(null);
    const [busy, setBusy] = useState(false);
    const [reload, setReload] = useState(0);
    const working = useRef(false);
    useEffect(() => {
        setTask(null);
        if (!taskId || !ownerId) return;
        const controller = new AbortController(), events = watchTaskEvents([taskId]);
        void (async () => {
            try {
                while (!controller.signal.aborted) {
                    const revision = events.version;
                    const current = await getQueuedTask(taskId, controller.signal);
                    if (controller.signal.aborted || useUserStore.getState().user?.id !== ownerId) return;
                    setTask(current);
                    if (!current || ["success", "failed", "cancelled"].includes(current.status)) return;
                    await events.next(revision, 15_000, controller.signal, 5_000);
                }
            } catch { if (!controller.signal.aborted) setTask(null); }
            finally { events.close(); }
        })();
        return () => { controller.abort(); events.close(); };
    }, [taskId, ownerId, reload]);
    if (!taskId) return null;
    if (task?.status === "cancelled") return <span role="status" className="text-xs text-muted-foreground">{uiText("任务已取消；额度以账户记录为准。")}</span>;
    const cancel = () => modal.confirm({ title: uiText("取消此排队任务？"), content: uiText("只取消尚未提交上游的原任务。若任务已开始执行，取消会被拒绝；额度是否释放以账户记录为准。"), okText: uiText("确认取消任务"), cancelText: uiText("保留任务"), onOk: async () => {
        if (working.current || useUserStore.getState().user?.id !== ownerId) return;
        working.current = true; setBusy(true);
        try {
            const current = await cancelQueuedTask(taskId);
            if (useUserStore.getState().user?.id !== ownerId) return;
            setTask(current);
            if (current.status === "cancelled") message.success(uiText("任务已取消；额度以账户记录为准。"));
            else message.warning(uiText("任务状态已变化，未确认取消；请继续查询原任务。"));
        } catch (error) { setTask(null); message.warning(uiText(generationErrorMessage(error))); }
        finally { working.current = false; setBusy(false); }
    } });
    return <div className="flex flex-wrap items-center justify-center gap-2">
        <Tooltip title={uiText("仅可取消尚未提交上游的排队或暂停任务；运行中任务请继续查询。")}><Button size="small" disabled={!canCancelQueuedTask(task) || busy} loading={busy} onClick={cancel}>{uiText("取消任务")}</Button></Tooltip>
        {!task && <Button size="small" type="link" disabled={busy} onClick={() => setReload(value => value + 1)}>{uiText("刷新任务状态")}</Button>}
    </div>;
}
