export type WorkbenchTask = { id: string; number: number; createdAt: number };
export type WorkbenchTaskState = { version: 1; tasks: WorkbenchTask[]; activeId: string; nextNumber: number };

export const DEFAULT_WORKBENCH_TASK = "default";

export function initialWorkbenchTasks(): WorkbenchTaskState {
    return { version: 1, tasks: [{ id: DEFAULT_WORKBENCH_TASK, number: 1, createdAt: 0 }], activeId: DEFAULT_WORKBENCH_TASK, nextNumber: 2 };
}

export function workbenchTaskScope(base: string, id = DEFAULT_WORKBENCH_TASK) {
    return id === DEFAULT_WORKBENCH_TASK ? base : `${base}:task:${id}`;
}

export function matchesWorkbenchTask(record: { workspaceId?: string }, id = DEFAULT_WORKBENCH_TASK) {
    return (record.workspaceId || DEFAULT_WORKBENCH_TASK) === id;
}

/** Invalid persisted identity must not silently create a replacement paid workspace. */
export function readWorkbenchTasks(value: unknown): WorkbenchTaskState {
    if (value === null || value === undefined) return initialWorkbenchTasks();
    const state = value as WorkbenchTaskState;
    if (state.version !== 1 || !Array.isArray(state.tasks) || !state.tasks.length
        || !state.tasks.every(task => task && typeof task.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(task.id)
            && Number.isSafeInteger(task.number) && task.number > 0 && Number.isFinite(task.createdAt) && task.createdAt >= 0)
        || new Set(state.tasks.map(task => task.id)).size !== state.tasks.length
        || new Set(state.tasks.map(task => task.number)).size !== state.tasks.length
        || !state.tasks.some(task => task.id === DEFAULT_WORKBENCH_TASK)
        || !state.tasks.some(task => task.id === state.activeId)
        || !Number.isSafeInteger(state.nextNumber) || state.nextNumber <= Math.max(...state.tasks.map(task => task.number))) {
        throw new Error("任务页签记录暂时无法读取，请重试；原任务和草稿未被覆盖。");
    }
    return structuredClone(state);
}

export function addWorkbenchTask(state: WorkbenchTaskState, id: string, createdAt: number): WorkbenchTaskState {
    return readWorkbenchTasks({ ...state, tasks: [...state.tasks, { id, number: state.nextNumber, createdAt }], activeId: id, nextNumber: state.nextNumber + 1 });
}

export function closeWorkbenchTask(state: WorkbenchTaskState, id: string): WorkbenchTaskState {
    if (id === DEFAULT_WORKBENCH_TASK) return state;
    const index = state.tasks.findIndex(task => task.id === id);
    if (index < 0) return state;
    const tasks = state.tasks.filter(task => task.id !== id);
    return { ...state, tasks, activeId: state.activeId === id ? tasks[Math.max(0, index - 1)].id : state.activeId };
}
