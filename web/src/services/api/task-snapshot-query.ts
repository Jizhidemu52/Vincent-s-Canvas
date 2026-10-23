import { queryClient } from "@/lib/query-client";
import { useUserStore } from "@/stores/use-user-store";

/** Deduplicate in-flight reads without letting one unmounted view cancel other consumers. */
export function readTaskSnapshot<T>(ids: string[], read: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) {
    signal.throwIfAborted();
    const ownerId = useUserStore.getState().user?.id;
    const pending = queryClient.fetchQuery({
        queryKey: ["task-snapshot", ownerId ?? "trial", [...ids].sort()],
        staleTime: 0,
        gcTime: 60_000,
        queryFn: async ({ signal: querySignal }) => {
            const result = await read(AbortSignal.any([querySignal, AbortSignal.timeout(20_000)]));
            if (useUserStore.getState().user?.id !== ownerId) throw new Error("员工会话已变化，已停止查询原任务");
            return result;
        },
    });
    return new Promise<T>((resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        pending.then(value => {
            signal.removeEventListener("abort", abort);
            if (!signal.aborted) resolve(value);
        }, error => {
            signal.removeEventListener("abort", abort);
            if (!signal.aborted) reject(error);
        });
        if (signal.aborted) abort();
    });
}

useUserStore.subscribe((state, previous) => {
    if (state.user?.id === previous.user?.id) return;
    void queryClient.cancelQueries({ queryKey: ["task-snapshot"] });
    queryClient.removeQueries({ queryKey: ["task-snapshot"] });
});
