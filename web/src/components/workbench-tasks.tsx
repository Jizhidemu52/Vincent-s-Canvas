import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { nanoid } from "nanoid";
import { createWorkspaceStorage } from "@/lib/workspace-storage";
import { uiText, useUiText } from "@/lib/i18n";
import { DisplayTranslationScope } from "@/hooks/use-display-text";
import { addWorkbenchTask, DEFAULT_WORKBENCH_TASK, initialWorkbenchTasks, readWorkbenchTasks, workbenchTaskScope, type WorkbenchTaskState } from "@/lib/workbench-task-state";

type TaskContext = { id: string; active: boolean; ready: boolean; creating: boolean; createNewTask: () => Promise<boolean>; urlInputKey: string | null; draftScope: (base: string) => string };
const WorkbenchTaskContext = createContext<TaskContext>({ id: DEFAULT_WORKBENCH_TASK, active: true, ready: false, creating: false, createNewTask: async () => false, urlInputKey: null, draftScope: base => base });

export function useWorkbenchTask() { return useContext(WorkbenchTaskContext); }

function TaskPane({ id, active, ready, creating, createNewTask, urlInputKey, children }: Omit<TaskContext, "draftScope"> & { children: ReactNode }) {
    const draftScope = useCallback((base: string) => workbenchTaskScope(base, id), [id]);
    const value = useMemo(() => ({ id, active, ready, creating, createNewTask, urlInputKey, draftScope }), [id, active, ready, creating, createNewTask, urlInputKey, draftScope]);
    return <div hidden={!active} className="h-full min-h-0 min-w-0">
        <WorkbenchTaskContext.Provider value={value}><DisplayTranslationScope visible={active}>{children}</DisplayTranslationScope></WorkbenchTaskContext.Provider>
    </div>;
}

export function WorkbenchTasks({ boardKey, ownerId, urlInputKey, children }: { boardKey: string; ownerId?: string | null; urlInputKey?: string; children: ReactNode }) {
    useUiText();
    const [storage] = useState(() => createWorkspaceStorage("generation_workbench_tasks"));
    const registryKey = JSON.stringify([ownerId || "local", boardKey]);
    const [state, setState] = useState<WorkbenchTaskState>(initialWorkbenchTasks);
    const stateRef = useRef(state);
    const [ready, setReady] = useState(false);
    const urlInputTarget = useRef<{ key: string; id: string } | null>(null);
    if (!urlInputKey) urlInputTarget.current = null;
    else if (ready && urlInputTarget.current?.key !== urlInputKey) urlInputTarget.current = { key: urlInputKey, id: state.activeId };
    const [saving, setSaving] = useState(false);
    const savingRef = useRef(false);
    const [error, setError] = useState("");
    const [attempt, setAttempt] = useState(0);
    const mounted = useRef(false);

    useEffect(() => {
        let active = true;
        mounted.current = true;
        setReady(false); setError("");
        void storage.getItem<unknown>(registryKey).then(value => {
            if (!active) return;
            const restored = readWorkbenchTasks(value);
            stateRef.current = restored; setState(restored); setReady(true);
        }).catch(caught => { if (active) setError(caught instanceof Error ? caught.message : "工作区读取失败，请重试。"); });
        return () => { active = false; mounted.current = false; };
    }, [storage, registryKey, attempt]);

    const createNewTask = useCallback(async () => {
        if (!ready || urlInputKey || savingRef.current) return false;
        savingRef.current = true; setSaving(true); setError("");
        try {
            const next = addWorkbenchTask(stateRef.current, nanoid(), Date.now());
            await storage.setItem(registryKey, next);
            if (!mounted.current) return false;
            stateRef.current = next; setState(next);
            return true;
        } catch (caught) {
            if (mounted.current) setError(caught instanceof Error ? caught.message : "工作区保存失败，原内容未改变。");
            return false;
        } finally { savingRef.current = false; if (mounted.current) setSaving(false); }
    }, [ready, urlInputKey, storage, registryKey]);

    return <section className="flex h-full min-h-0 min-w-0 max-w-full flex-col bg-background text-foreground" aria-label={uiText("创作工作区")}>
        {error && <div role="alert" className="flex shrink-0 items-center gap-2 px-3 py-2 text-xs text-destructive"><span>{uiText(error)}</span>{!ready && <button type="button" className="underline" onClick={() => setAttempt(value => value + 1)}>{uiText("重试读取")}</button>}</div>}
        {!ready && !error ? <div role="status" className="p-4 text-sm text-muted-foreground">{uiText("正在打开工作区…")}</div> : null}
        <div className="min-h-0 min-w-0 flex-1">{ready && state.tasks.map(task => <TaskPane key={task.id} id={task.id} active={state.activeId === task.id} ready={!urlInputKey} creating={saving} createNewTask={createNewTask} urlInputKey={urlInputTarget.current?.id === task.id ? urlInputTarget.current.key : null}>{children}</TaskPane>)}</div>
    </section>;
}
