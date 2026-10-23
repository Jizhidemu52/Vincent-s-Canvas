import { useUserStore } from "@/stores/use-user-store";

type Visibility = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
type EventConnection = Pick<EventSource, "addEventListener" | "close">;
type Watch = { ids: Set<string>; version: number; ownerId: string | undefined; listeners: Set<() => void>; closed: boolean };

/** One notification connection per workspace, regardless of how many views watch a task. */
export function createTaskEventStream(options: {
    owner: () => string | undefined;
    visibility?: Visibility;
    connect?: (url: string) => EventConnection;
}) {
    const watches = new Set<Watch>();
    let source: EventConnection | undefined;
    let sourceKey = "", healthy = false;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    const wake = (watch: Watch) => { for (const listener of [...watch.listeners]) listener(); };
    const closeSource = () => { source?.close(); source = undefined; sourceKey = ""; healthy = false; };
    const activeIds = () => [...new Set([...watches].filter(watch => watch.ownerId === options.owner()).flatMap(watch => [...watch.ids]))].sort();
    const rebuild = () => {
        reconnect = undefined;
        const ids = activeIds();
        const ownerId = options.owner();
        if (!ids.length || !ownerId || !options.connect || options.visibility?.hidden || ids.length > 100) { closeSource(); return; }
        const key = `${ownerId}:${ids.join(",")}`;
        if (source && sourceKey === key) return;
        closeSource();
        try {
            const connection = options.connect(`/api/tasks/events?${new URLSearchParams({ ids: ids.join(","), ownerId })}`);
            source = connection;
            sourceKey = key;
            connection.addEventListener("tasks-changed", event => {
                if (source !== connection || options.owner() !== ownerId) return;
                try {
                    const payload = JSON.parse((event as MessageEvent).data) as { ids?: unknown };
                    if (!Array.isArray(payload.ids) || !payload.ids.every(id => typeof id === "string")) return;
                    healthy = true;
                    const changed = new Set(payload.ids);
                    for (const watch of watches) if (watch.ownerId === ownerId && [...watch.ids].some(id => changed.has(id))) {
                        watch.version++;
                        wake(watch);
                    }
                } catch { /* A malformed notification cannot replace the authoritative GET snapshot. */ }
            });
            connection.addEventListener("error", () => {
                if (source !== connection) return;
                healthy = false;
                for (const watch of watches) { watch.version++; wake(watch); }
            });
        } catch { closeSource(); }
    };
    const schedule = () => { clearTimeout(reconnect); reconnect = setTimeout(rebuild, 30); };
    const onVisibility = () => {
        if (options.visibility?.hidden) closeSource();
        else { for (const watch of watches) { watch.version++; wake(watch); } schedule(); }
    };
    function subscribe(ids: string[]) {
        const watch: Watch = { ids: new Set(ids.map(id => id.toLowerCase())), version: 0, ownerId: options.owner(), listeners: new Set(), closed: false };
        if (!watches.size) options.visibility?.addEventListener("visibilitychange", onVisibility);
        watches.add(watch);
        schedule();
        const assertCurrent = () => {
            if (watch.closed) throw new Error("任务观察已关闭");
            if (options.owner() !== watch.ownerId) throw new Error("员工会话已变化，已停止查询原任务");
        };
        const wait = (ready: () => boolean, ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const cleanup = () => { clearTimeout(timer); watch.listeners.delete(check); signal?.removeEventListener("abort", abort); };
            const finish = (error?: unknown) => { cleanup(); if (error) reject(error); else resolve(); };
            const abort = () => finish(signal?.reason || new DOMException("已停止查询", "AbortError"));
            const check = () => {
                try { assertCurrent(); signal?.throwIfAborted(); if (ready()) finish(); }
                catch (error) { finish(error); }
            };
            watch.listeners.add(check);
            signal?.addEventListener("abort", abort, { once: true });
            timer = setTimeout(() => finish(), Math.max(0, ms));
            check();
        });
        return {
            get version() { return watch.version; },
            ready: (ms: number, signal?: AbortSignal) => wait(() => !options.visibility?.hidden, ms, signal),
            next: (version: number, ms: number, signal?: AbortSignal, fallbackMs = 2_500) => wait(
                () => !options.visibility?.hidden && watch.version !== version,
                Math.min(ms, healthy ? 30_000 : fallbackMs), signal,
            ),
            close() {
                if (watch.closed) return;
                watch.closed = true;
                wake(watch);
                watches.delete(watch);
                if (watches.size) schedule();
                else {
                    clearTimeout(reconnect);
                    closeSource();
                    options.visibility?.removeEventListener("visibilitychange", onVisibility);
                }
            },
        };
    }
    return {
        subscribe,
        identityChanged() { closeSource(); for (const watch of watches) wake(watch); schedule(); },
    };
}

let sharedStream: ReturnType<typeof createTaskEventStream> | undefined;
export function watchTaskEvents(ids: string[]) {
    sharedStream ||= createTaskEventStream({
        owner: () => useUserStore.getState().user?.id,
        visibility: typeof document === "undefined" ? undefined : document,
        connect: typeof EventSource === "undefined" ? undefined : url => new EventSource(url, { withCredentials: true }),
    });
    return sharedStream.subscribe(ids);
}
useUserStore.subscribe((state, previous) => {
    if (state.user?.id !== previous.user?.id) sharedStream?.identityChanged();
});
