import { fetchServerImageThumbnail, type ServerImageThumbnail } from "./api/server-assets";
import { deploymentFeatures } from "@/lib/deployment-features";
import { useUserStore } from "@/stores/use-user-store";
import { subscribeWorkspaceIdentity } from "@/lib/workspace-session-events";

type ThumbnailLease = { url: string; release: () => void };
type ResolverOptions = {
    owner: () => string | null;
    subscribe: (invalidate: () => void) => () => void;
    fetch: (url: string, signal: AbortSignal) => Promise<ServerImageThumbnail>;
    createUrl: (blob: Blob) => string;
    revokeUrl: (url: string) => void;
    timeoutMs?: number;
    maxRequests?: number;
};

/** No original fallback and no shared cache that could outlive an employee. */
export function createServerImageThumbnailResolver(options: ResolverOptions) {
    return async (url: string, signal: AbortSignal): Promise<ThumbnailLease> => {
        const owner = options.owner();
        if (!owner || signal.aborted) throw new DOMException("图片预览请求已取消", "AbortError");
        const controller = new AbortController();
        let objectUrl = "";
        let released = false;
        let unsubscribe = () => {};
        const release = () => {
            if (released) return;
            released = true;
            unsubscribe();
            if (objectUrl) options.revokeUrl(objectUrl);
        };
        const cancel = () => controller.abort(new DOMException("图片预览请求已取消", "AbortError"));
        const assertCurrent = () => {
            controller.signal.throwIfAborted();
            if (options.owner() !== owner) { cancel(); controller.signal.throwIfAborted(); }
        };
        unsubscribe = options.subscribe(() => { cancel(); release(); });
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        const timer = setTimeout(() => controller.abort(new Error("图片预览等待超时，请重试")), options.timeoutMs ?? 30_000);
        let rejectAbort: (error: unknown) => void = () => {};
        const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
        // A pre-aborted request can fail the identity check before entering a race.
        void aborted.catch(() => {});
        const onAbort = () => rejectAbort(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
        try {
            for (let count = 0; count < (options.maxRequests ?? 12); count++) {
                assertCurrent();
                const result = await Promise.race([options.fetch(url, controller.signal), aborted]);
                assertCurrent();
                if (result.status === "ready") {
                    objectUrl = options.createUrl(result.blob);
                    return { url: objectUrl, release };
                }
                let waitTimer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([new Promise<void>(resolve => { waitTimer = setTimeout(resolve, result.retryAfterMs); }), aborted]);
                } finally { clearTimeout(waitTimer); }
            }
            throw new Error("图片预览等待超时，请重试");
        } catch (error) {
            release();
            throw error;
        } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
            controller.signal.removeEventListener("abort", onAbort);
        }
    };
}

export function serverImagePreviewOwner(state: Pick<ReturnType<typeof useUserStore.getState>, "user" | "status">) {
    if (state.status === "authenticated" && state.user) return `${state.user.id}:${state.user.role}`;
    return deploymentFeatures.authenticationEnabled ? null : "trial";
}

export const acquireServerImageThumbnail = createServerImageThumbnailResolver({
    owner: () => serverImagePreviewOwner(useUserStore.getState()),
    subscribe: invalidate => {
        const owner = serverImagePreviewOwner(useUserStore.getState());
        const userId = useUserStore.getState().user?.id ?? null;
        const stopStore = useUserStore.subscribe(state => { if (serverImagePreviewOwner(state) !== owner) invalidate(); });
        const stopWorkspace = subscribeWorkspaceIdentity(nextOwner => { if (nextOwner !== userId) invalidate(); });
        return () => { stopStore(); stopWorkspace(); };
    },
    fetch: fetchServerImageThumbnail,
    createUrl: blob => URL.createObjectURL(blob),
    revokeUrl: url => URL.revokeObjectURL(url),
});
