/** Track only this tab's mutations, never treat its stale list as the whole database. */
export function collectProjectChanges<T extends { id: string }>(previous: T[], next: T[], pending = new Map<string, T | null>()) {
    const before = new Map(previous.map(project => [project.id, project]));
    const after = new Set(next.map(project => project.id));
    for (const project of next) if (before.get(project.id) !== project) pending.set(project.id, project);
    for (const project of previous) if (!after.has(project.id)) pending.set(project.id, null);
    return pending;
}

export function mergeProjectChanges<T extends { id: string }>(stored: T[], changes: ReadonlyMap<string, T | null>): T[] {
    const existing = new Set(stored.map(project => project.id));
    const created = [...changes.values()].filter((project): project is T => !!project && !existing.has(project.id));
    return [...created, ...stored.flatMap(project => {
        const change = changes.get(project.id);
        return change === null ? [] : [change || project];
    })];
}

/** Calls are serialized by the storage writer. Failed mutations survive its next flush. */
export function createProjectChangeBuffer<T extends { id: string }>() {
    let pending = new Map<string, T | null>();
    return {
        async write(changes: ReadonlyMap<string, T | null>, persist: (changes: ReadonlyMap<string, T | null>) => Promise<void>) {
            pending = new Map([...pending, ...changes]);
            await persist(pending);
            pending.clear();
        },
        clear() { pending.clear(); },
    };
}

export async function withCanvasStorageLock<T>(name: string, write: () => Promise<T>): Promise<T> {
    if (typeof navigator !== "undefined" && navigator.locks) {
        return navigator.locks.request(`canvas-storage:${name}`, write);
    }
    return write();
}
