import { useCallback, useEffect, useRef, useState } from "react";
import { createWorkspaceStorage } from "@/lib/workspace-storage";
import { createClientId } from "@/lib/client-id";
import { getQueuedTask, getQueuedTaskByRequestId, recoverQueuedTask } from "@/services/api/generation-tasks";
import { watchTaskReconciliation } from "@/services/api/task-result-reconciliation";
import { createLayerStudioTask } from "@/services/api/layer-studio";
import { applyLayerStudioSnapshot, layerStudioSubmission, newLayerStudioWorkspace, readLayerStudioWorkspace, unresolvedLayerStudioJob, type LayerStudioJob, type LayerStudioWorkspace } from "./page-state";
import { submitLayerStudioOnce } from "./page-request";

export function useLayerStudioWorkspace(ownerId: string, workspaceId: string) {
    const [storage] = useState(() => createWorkspaceStorage("layer_studio_workspaces"));
    const key = `workspace:${workspaceId}`;
    const [state, setState] = useState(() => newLayerStudioWorkspace(ownerId, workspaceId));
    const current = useRef(state);
    const [ready, setReady] = useState(false);
    const readyRef = useRef(false);
    const mounted = useRef(false);
    const queue = useRef(Promise.resolve());
    const [error, setError] = useState("");
    const [queryNotice, setQueryNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const queryingRef = useRef(false);
    const [paused, setPaused] = useState(false);
    const [readAttempt, setReadAttempt] = useState(0);
    const assertCurrent = useCallback(() => {
        storage.assertIdentity();
        if (!mounted.current || !readyRef.current) throw new Error("工作区尚未完成安全读取。");
    }, [storage]);
    useEffect(() => {
        let active = true;
        mounted.current = true; readyRef.current = false; setReady(false);
        void storage.getItem(key).then(value => {
            if (!active) return;
            const restored = readLayerStudioWorkspace(value, ownerId, workspaceId);
            current.current = restored; setState(restored); readyRef.current = true; setReady(true); setError("");
        }).catch(() => { if (active) setError("工作区暂时无法读取；已有记录未覆盖。请重试读取。"); });
        return () => { active = false; mounted.current = false; readyRef.current = false; };
    }, [key, ownerId, workspaceId, storage, readAttempt]);

    const save = useCallback((next: LayerStudioWorkspace) => {
        assertCurrent();
        current.current = next; setState(next);
        const write = queue.current.catch(() => {}).then(async () => {
            assertCurrent(); await storage.setItem(key, next); assertCurrent();
        });
        queue.current = write;
        void write.then(() => { if (mounted.current) setError(""); }).catch(() => { if (mounted.current) setError("本地保存失败；当前内容保留在页面中，暂不能提交新任务，请重试保存。"); });
        return write;
    }, [assertCurrent, key, storage]);
    const update = useCallback((change: (previous: LayerStudioWorkspace) => LayerStudioWorkspace) => save(change(current.current)), [save]);
    const saveJob = useCallback((job: LayerStudioJob) => update(previous => {
        const exists = previous.jobs.some(item => item.requestId === job.requestId);
        return { ...previous, jobs: exists ? previous.jobs.map(item => item.requestId === job.requestId ? job : item) : [job, ...previous.jobs], selectedRequestId: previous.selectedRequestId || job.requestId };
    }), [update]);
    const reconcile = useCallback(async (signal?: AbortSignal) => {
        assertCurrent();
        if (queryingRef.current) return;
        queryingRef.current = true;
        try { for (const original of current.current.jobs.filter(unresolvedLayerStudioJob)) {
            signal?.throwIfAborted();
            const task = original.taskId ? await getQueuedTask(original.taskId, signal) : await getQueuedTaskByRequestId(original.requestId, signal);
            assertCurrent(); signal?.throwIfAborted();
            if (!task) { setQueryNotice("暂未查到原请求；已保留编号，未重新提交。请稍后查询或联系管理员核对。"); continue; }
            const latest = current.current.jobs.find(item => item.requestId === original.requestId);
            if (latest && unresolvedLayerStudioJob(latest)) await saveJob(applyLayerStudioSnapshot(latest, task));
            setQueryNotice("");
        } } finally { queryingRef.current = false; }
    }, [assertCurrent, saveJob]);
    const pendingKey = state.jobs.filter(unresolvedLayerStudioJob).map(job => `${job.requestId}:${job.taskId || ""}`).join("|");
    useEffect(() => {
        if (!ready || !pendingKey || busy || paused) return;
        const controller = new AbortController();
        void watchTaskReconciliation({ taskIds: current.current.jobs.filter(unresolvedLayerStudioJob).flatMap(job => job.taskId ? [job.taskId] : []), signal: controller.signal,
            intervalMs: 8_000, foregroundOnly: false, reconcile: () => reconcile(controller.signal),
            onError: () => { if (!controller.signal.aborted && storage.isCurrent()) setQueryNotice("查询暂不可用；原任务继续保留，网络恢复后只查询原任务。"); },
        }).catch(() => {});
        return () => controller.abort();
    }, [ready, pendingKey, busy, paused, reconcile, storage]);

    const submit = async () => {
        assertCurrent();
        if (busyRef.current || current.current.jobs.some(unresolvedLayerStudioJob) || error) return;
        busyRef.current = true; setBusy(true); setQueryNotice(""); setPaused(false);
        try {
            const requestId = createClientId();
            const submission = layerStudioSubmission(current.current, requestId);
            const job: LayerStudioJob = { requestId, ownerId, workspaceId, createdAt: Date.now(), submission, phase: "submitting" };
            await submitLayerStudioOnce(job, { assertCurrent, create: createLayerStudioTask,
                persist: async next => { await update(previous => ({ ...previous, jobs: previous.jobs.some(item => item.requestId === next.requestId)
                    ? previous.jobs.map(item => item.requestId === next.requestId ? next : item) : [next, ...previous.jobs], selectedRequestId: next.requestId })); } });
        } catch { if (mounted.current) setError("请求记录未能安全保存或工作区已变化；未重复提交。请保留页面并核对原记录。"); }
        finally { busyRef.current = false; if (mounted.current) setBusy(false); }
    };
    const refresh = async () => {
        setPaused(false);
        try { await reconcile(); } catch { if (storage.isCurrent()) setQueryNotice("查询暂不可用；原请求编号保留，不会重新生成。"); }
    };
    const resume = async (job: LayerStudioJob) => {
        if (busyRef.current || !job.taskId || job.taskStatus !== "paused" || !job.upstreamAccepted) return;
        busyRef.current = true; setBusy(true);
        try {
            assertCurrent();
            const task = await recoverQueuedTask(job.taskId);
            assertCurrent();
            const latest = current.current.jobs.find(item => item.requestId === job.requestId);
            if (latest) await saveJob(applyLayerStudioSnapshot(latest, task));
            setPaused(false);
        } catch { if (storage.isCurrent()) setQueryNotice("原任务暂不能恢复查询或保存；已保留记录，不会创建新的生成请求。"); }
        finally { busyRef.current = false; if (mounted.current) setBusy(false); }
    };
    return { state, current, ready, busy, error, queryNotice, paused, update, submit, refresh, resume, assertCurrent,
        pause: () => setPaused(true), retrySave: () => save(current.current), retryRead: () => setReadAttempt(value => value + 1) };
}
