type DatabaseAccess = { barrier: Promise<void>; active: Set<Promise<unknown>> };
const databases = new Map<string, DatabaseAccess>();

/** Store creation can upgrade a shared IndexedDB database and close its old connection. */
export function createStorageAccess(databaseName: string, initialize: () => Promise<unknown>) {
    let database = databases.get(databaseName);
    if (!database) {
        database = { barrier: Promise.resolve(), active: new Set() };
        databases.set(databaseName, database);
    }
    const shared = database;
    let initialized: Promise<void> | undefined;
    const ready = () => {
        if (!initialized) {
            initialized = shared.barrier.then(async () => {
                // Existing transactions finish before a new store changes the schema.
                // Later operations wait on this barrier rather than using a closing DB.
                await Promise.allSettled([...shared.active]);
                await initialize();
            });
            // A failed store must not poison unrelated, already usable stores.
            shared.barrier = initialized.catch(() => undefined);
        }
        return initialized;
    };
    return {
        ready,
        async run<T>(operation: () => Promise<T>): Promise<T> {
            await ready();
            let barrier: Promise<void>;
            do {
                barrier = shared.barrier;
                await barrier;
            } while (barrier !== shared.barrier);
            // Register before invoking the operation so another initializer can drain it.
            const pending = Promise.resolve().then(operation);
            shared.active.add(pending);
            try { return await pending; }
            finally { shared.active.delete(pending); }
        },
    };
}
