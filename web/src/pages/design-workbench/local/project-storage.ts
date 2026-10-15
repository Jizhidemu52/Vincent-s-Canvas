export type ProjectStorage = {
    getItem<T>(key: string): Promise<T | null>;
    setItem<T>(key: string, value: T): Promise<T>;
};

/** Bind an immutable owner and check it on both sides of every asynchronous read/write. */
export function createWorkbenchProjectStorage(storage: ProjectStorage, ownerId: string | null, currentOwner: () => string | null, isActive: () => boolean) {
    const prefix = ownerId === null ? "trial:" : `owner:${encodeURIComponent(ownerId)}:`;
    const assertCurrent = () => {
        if (!isActive() || currentOwner() !== ownerId) throw new Error("账号身份已变化，请重新打开工作台");
    };
    return {
        assertCurrent,
        async saveProject(key: string, value: unknown) {
            assertCurrent();
            const snapshot = structuredClone(value);
            await storage.setItem(prefix + key, snapshot);
            assertCurrent();
        },
        async loadProject(key: string) {
            assertCurrent();
            const value = await storage.getItem(prefix + key);
            assertCurrent();
            return value;
        },
    };
}
