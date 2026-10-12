import { mapCanvasAsyncPool } from "./canvas-async-pool";

export type CanvasProjectMetadata = { id: string; title: string };

/** One workspace lifetime: successful names never cross an identity change. */
export function createCanvasProjectMetadataSync(options: {
    ownerId: string;
    getProjects: () => readonly CanvasProjectMetadata[];
    isCurrentOwner: () => boolean;
    isVisible: () => boolean;
    submit: (ownerId: string, project: CanvasProjectMetadata, signal: AbortSignal) => Promise<void>;
}) {
    const syncedNames = new Map<string, string>();
    const abort = new AbortController();
    let running: Promise<void> | null = null;
    const active = () => !abort.signal.aborted && options.isCurrentOwner() && options.isVisible();

    const run = async () => {
        const projects = options.getProjects().map(({ id, title }) => ({ id, title: title.trim() }));
        const ids = new Set(projects.map(project => project.id));
        for (const id of syncedNames.keys()) if (!ids.has(id)) syncedNames.delete(id);
        const changed = projects.filter(project => syncedNames.get(project.id) !== project.title);
        await mapCanvasAsyncPool(changed, 4, async project => {
            // Visibility/identity may change while earlier requests occupy the pool.
            if (!active()) return;
            try {
                await options.submit(options.ownerId, project, abort.signal);
                if (!abort.signal.aborted && options.isCurrentOwner()) syncedNames.set(project.id, project.title);
            } catch {
                // Failed/aborted writes stay dirty and are retried on a later refresh.
            }
        });
    };

    return {
        sync(): Promise<void> {
            if (running) return running;
            if (!active()) return Promise.resolve();
            running = run().finally(() => { running = null; });
            return running;
        },
        dispose() {
            abort.abort();
            syncedNames.clear();
        },
    };
}
