import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Circle, LoaderCircle, Plus, X } from "lucide-react";
import { nanoid } from "nanoid";
import { Tooltip } from "antd";
import { createWorkspaceStorage } from "@/lib/workspace-storage";
import { uiText, useUiText } from "@/lib/i18n";
import { DisplayTranslationScope } from "@/hooks/use-display-text";
import { addWorkbenchTask, closeWorkbenchTask, DEFAULT_WORKBENCH_TASK, initialWorkbenchTasks, readWorkbenchTasks, workbenchTaskScope, type WorkbenchTaskState } from "@/lib/workbench-task-state";

type TaskStatus = { busy: boolean; pending?: boolean; ready?: boolean; label?: string };
type TaskContext = { id: string; active: boolean; ready: boolean; creating: boolean; createNewTask: () => Promise<boolean>; urlInputKey: string | null; draftScope: (base: string) => string; report: (status: TaskStatus) => void };
const defaultTask: TaskContext = { id: DEFAULT_WORKBENCH_TASK, active: true, ready: false, creating: false, createNewTask: async () => false, urlInputKey: null, draftScope: base => base, report: () => {} };
const WorkbenchTaskContext = createContext<TaskContext>(defaultTask);

export function useWorkbenchTask() { return useContext(WorkbenchTaskContext); }

export function useWorkbenchTaskStatus({ busy, pending = false, ready = true, label = "" }: TaskStatus) {
    const { report } = useWorkbenchTask();
    useEffect(() => { report({ busy, pending, ready, label }); }, [report, busy, pending, ready, label]);
}

function TaskPane({ id, active, ready, creating, createNewTask, urlInputKey, report, children, panelId, tabId }: { id: string; active: boolean; ready: boolean; creating: boolean; createNewTask: () => Promise<boolean>; urlInputKey: string | null; report: (id: string, status: TaskStatus) => void; children: ReactNode; panelId: string; tabId: string }) {
    const reportStatus = useCallback((status: TaskStatus) => report(id, status), [id, report]);
    const draftScope = useCallback((base: string) => workbenchTaskScope(base, id), [id]);
    const value = useMemo(() => ({ id, active, ready, creating, createNewTask, urlInputKey, draftScope, report: reportStatus }), [id, active, ready, creating, createNewTask, urlInputKey, draftScope, reportStatus]);
    // Keep inactive workspaces mounted: their original request/observer and frozen
    // input stay intact. Hiding a tab is not cancellation or a new submission.
    return <div role="tabpanel" id={panelId} aria-labelledby={tabId} hidden={!active} style={{ display: active ? "block" : "none" }} className="h-full min-h-0 min-w-0">
        <WorkbenchTaskContext.Provider value={value}><DisplayTranslationScope visible={active}>{children}</DisplayTranslationScope></WorkbenchTaskContext.Provider>
    </div>;
}

/** One owner per board. Only tiny task identities live here; each editor owns its existing durable input/result records. */
export function WorkbenchTasks({ boardKey, ownerId, urlInputKey, children }: { boardKey: string; ownerId?: string | null; urlInputKey?: string; children: ReactNode }) {
    useUiText();
    const prefix = useId();
    const [storage] = useState(() => createWorkspaceStorage("generation_workbench_tasks"));
    const registryKey = JSON.stringify([ownerId || "local", boardKey]);
    const [state, setState] = useState<WorkbenchTaskState>(initialWorkbenchTasks);
    const stateRef = useRef(state);
    const [ready, setReady] = useState(false);
    // Freeze ordinary URL input ownership only after restoring the task registry.
    // Tab switches and newly created panes must not retarget an incoming draft.
    const urlInputTarget = useRef<{ key: string; id: string } | null>(null);
    if (!urlInputKey) urlInputTarget.current = null;
    else if (ready && urlInputTarget.current?.key !== urlInputKey) urlInputTarget.current = { key: urlInputKey, id: state.activeId };
    const [saving, setSaving] = useState(false);
    const savingRef = useRef(false);
    const [error, setError] = useState("");
    const [attempt, setAttempt] = useState(0);
    const mounted = useRef(false);
    const tabList = useRef<HTMLDivElement>(null);
    const [statuses, setStatuses] = useState<Record<string, TaskStatus>>({});
    const report = useCallback((id: string, status: TaskStatus) => {
        setStatuses(current => {
            const previous = current[id];
            return previous?.busy === status.busy && previous?.pending === status.pending && previous?.ready === status.ready && previous?.label === status.label
                ? current : { ...current, [id]: status };
        });
    }, []);

    useEffect(() => {
        let active = true;
        mounted.current = true;
        setReady(false); setError("");
        void storage.getItem<unknown>(registryKey).then(value => {
            if (!active) return;
            const restored = readWorkbenchTasks(value);
            stateRef.current = restored; setState(restored); setReady(true);
        }).catch(caught => { if (active) setError(caught instanceof Error ? caught.message : "任务页签读取失败，请重试。"); });
        return () => { active = false; mounted.current = false; };
    }, [storage, registryKey, attempt]);

    useEffect(() => {
        if (!ready || !tabList.current) return;
        const revealActive = () => document.getElementById(`${prefix}-tab-${state.activeId}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
        revealActive();
        const observer = new ResizeObserver(revealActive);
        observer.observe(tabList.current);
        return () => observer.disconnect();
    }, [prefix, state.activeId, ready]);

    const persist = useCallback(async (next: WorkbenchTaskState) => {
        if (!ready || savingRef.current) return false;
        savingRef.current = true; setSaving(true); setError("");
        try {
            await storage.setItem(registryKey, next);
            if (!mounted.current) return false;
            stateRef.current = next; setState(next);
            return true;
        } catch (caught) {
            if (mounted.current) setError(caught instanceof Error ? caught.message : "任务页签保存失败，未创建新任务。");
            return false;
        }
        finally { savingRef.current = false; if (mounted.current) setSaving(false); }
    }, [ready, storage, registryKey]);
    const createNewTask = useCallback(() => persist(addWorkbenchTask(stateRef.current, nanoid(), Date.now())), [persist]);
    const activate = (id: string) => { if (id !== stateRef.current.activeId) void persist({ ...stateRef.current, activeId: id }); };
    const close = (id: string) => {
        const status = statuses[id];
        if (!status || status.busy || status.pending || status.ready === false) return;
        // Closing a finished tab does not delete its history, source files or draft.
        void persist(closeWorkbenchTask(stateRef.current, id));
    };

    return <section className="wb-multitask flex h-full min-h-0 min-w-0 max-w-full flex-col bg-background text-foreground" aria-label={uiText("多任务工作区")}>
        <div className="wb-task-bar">
            <Tooltip title={uiText(!ready ? "正在准备工作区，请稍候" : saving ? "正在保存任务页签" : "开始独立任务，当前任务继续处理")}><span className="inline-flex shrink-0"><button type="button" disabled={!ready || saving} className="wb-task-new"
                onClick={() => void createNewTask()}><Plus size={16} />{uiText("新建任务")}</button></span></Tooltip>
            <div ref={tabList} role="tablist" aria-label={uiText("任务列表")} className="wb-task-list">
                {state.tasks.map(task => {
                    const status = statuses[task.id];
                    const title = uiText("任务 {number}", { number: task.number });
                    const statusText = !status || status.ready === false ? uiText("读取中") : status.busy ? uiText("处理中") : status.pending ? uiText("待核查") : uiText(status.label || "可编辑");
                    const active = state.activeId === task.id;
                    return <div key={task.id} className={`wb-task-item${active ? " is-active" : ""}`}>
                        <Tooltip title={`${title} · ${statusText}`}><span className="inline-flex"><button type="button" role="tab" id={`${prefix}-tab-${task.id}`} aria-controls={`${prefix}-panel-${task.id}`} aria-selected={active} tabIndex={active ? 0 : -1}
                            disabled={!ready || saving} className="wb-task-tab"
                            onClick={() => activate(task.id)} onKeyDown={event => {
                                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                                event.preventDefault();
                                const index = state.tasks.findIndex(item => item.id === task.id);
                                const next = event.key === "Home" ? 0 : event.key === "End" ? state.tasks.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + state.tasks.length) % state.tasks.length;
                                activate(state.tasks[next].id);
                                document.getElementById(`${prefix}-tab-${state.tasks[next].id}`)?.focus();
                            }}>
                            {status?.busy ? <LoaderCircle size={12} className="animate-spin" aria-hidden="true" /> : status?.pending ? <Circle size={10} aria-hidden="true" /> : status?.label === "已完成" ? <Check size={12} aria-hidden="true" /> : null}
                            <span>{title}</span><span className="text-muted-foreground">{statusText}</span>
                        </button></span></Tooltip>
                        {task.id !== DEFAULT_WORKBENCH_TASK && <Tooltip title={uiText(!ready || !status || status.ready === false ? "正在准备工作区，请稍候" : saving ? "正在保存任务页签" : status.busy || status.pending ? "原任务仍在处理或待核查，暂不能关闭页签" : "仅关闭已结束的页签，记录和原图仍保留")}><span className="inline-flex"><button type="button" aria-label={uiText("关闭任务 {number} 页签", { number: task.number })}
                            disabled={!ready || saving || !status || status.busy || status.pending || status.ready === false}
                            className="mr-1 rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30" onClick={() => close(task.id)}><X size={12} /></button></span></Tooltip>}
                    </div>;
                })}
            </div>
        </div>
        {error && <div role="alert" className="flex shrink-0 items-center gap-2 px-3 py-2 text-xs text-destructive"><span>{uiText(error)}</span>{!ready && <button type="button" className="underline" onClick={() => setAttempt(value => value + 1)}>{uiText("重试读取")}</button>}</div>}
        {!ready && !error ? <div role="status" className="p-4 text-sm text-muted-foreground">{uiText("正在读取任务列表…")}</div> : null}
        <div className="min-h-0 min-w-0 flex-1">{ready && state.tasks.map(task => <TaskPane key={task.id} id={task.id} active={state.activeId === task.id} ready={ready} creating={saving} createNewTask={createNewTask} urlInputKey={urlInputTarget.current?.id === task.id ? urlInputTarget.current.key : null} report={report} panelId={`${prefix}-panel-${task.id}`} tabId={`${prefix}-tab-${task.id}`}>{children}</TaskPane>)}</div>
    </section>;
}
