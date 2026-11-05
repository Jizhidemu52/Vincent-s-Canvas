import { useEffect, useState, type SyntheticEvent } from "react";
import { deploymentFeatures } from "@/lib/deployment-features";
import { subscribeWorkspaceIdentity } from "@/lib/workspace-session-events";
import { fetchServerAssetPlayback, type ServerAssetPlayback } from "@/services/api/server-assets";
import { readMediaSource, serverMediaId } from "@/services/canvas-media-links";
import { useUserStore } from "@/stores/use-user-store";

export type VideoPlaybackView = {
    status: "preparing" | "ready" | "local" | "error" | "idle";
    playbackUrl?: string;
    width?: number;
    height?: number;
    durationMs?: number;
    error?: string;
    serverAssetId?: string;
};
type PlaybackLease = Omit<ServerAssetPlayback, "blob"> & { playbackUrl: string; release: () => void };
type ResolverOptions = {
    owner: () => string | null;
    subscribe: (invalidate: () => void) => () => void;
    fetch: (assetId: string, signal: AbortSignal) => Promise<ServerAssetPlayback>;
    createUrl: (blob: Blob) => string;
    revokeUrl: (url: string) => void;
};

export function validVideoPlaybackAssetId(value: unknown) {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null;
}

/** Only persisted upload provenance may fill a missing ID; never parse an arbitrary display URL. */
export async function resolveVideoPlaybackAssetId(source: { assetId?: unknown; storageKey?: string }, readSource = readMediaSource) {
    const explicit = validVideoPlaybackAssetId(source.assetId);
    if (explicit || !source.storageKey) return explicit;
    return validVideoPlaybackAssetId(serverMediaId(await readSource(source.storageKey) || ""));
}

/** Share in-flight demand only. Every new demand after completion rechecks source and ACL. */
export function createVideoPlaybackResolver(options: ResolverOptions) {
    type Entry = { controller: AbortController; promise: Promise<Omit<PlaybackLease, "release">>; refs: number; dispose: () => void };
    const pending = new Map<string, Entry>();
    return async (id: string, signal: AbortSignal): Promise<PlaybackLease> => {
        const assetId = validVideoPlaybackAssetId(id);
        if (!assetId) throw new Error("视频素材标识无效");
        signal.throwIfAborted();
        const owner = options.owner();
        if (!owner) throw new DOMException("视频预览请求已取消", "AbortError");
        const key = `${owner}\n${assetId}`;
        let entry = pending.get(key);
        if (!entry) {
            const controller = new AbortController();
            let objectUrl = "", disposed = false, unsubscribe = () => {};
            const created: Entry = { controller, refs: 0, promise: undefined as never, dispose: () => {
                if (disposed) return;
                disposed = true;
                if (pending.get(key) === created) pending.delete(key);
                unsubscribe();
                controller.abort(new DOMException("视频预览请求已取消", "AbortError"));
                if (objectUrl) options.revokeUrl(objectUrl);
            } };
            pending.set(key, created);
            unsubscribe = options.subscribe(created.dispose);
            if (disposed) unsubscribe();
            created.promise = (async () => {
                const result = await options.fetch(assetId, controller.signal);
                controller.signal.throwIfAborted();
                if (options.owner() !== owner) { created.dispose(); controller.signal.throwIfAborted(); }
                objectUrl = options.createUrl(result.blob);
                return { playbackUrl: objectUrl, width: result.width, height: result.height, durationMs: result.durationMs };
            })();
            const completed = () => { if (pending.get(key) === created) pending.delete(key); };
            void created.promise.then(completed, completed);
            entry = created;
        }
        const shared = entry;
        shared.refs++;
        let released = false;
        let rejectAbort: (error: unknown) => void = () => {};
        const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
        const release = () => {
            if (released) return;
            released = true;
            signal.removeEventListener("abort", cancel);
            shared.controller.signal.removeEventListener("abort", cancel);
            if (--shared.refs === 0) shared.dispose();
        };
        const cancel = () => { release(); rejectAbort(new DOMException("视频预览请求已取消", "AbortError")); };
        signal.addEventListener("abort", cancel, { once: true });
        shared.controller.signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted || shared.controller.signal.aborted) cancel();
        try {
            const result = await Promise.race([shared.promise, aborted]);
            signal.throwIfAborted();
            shared.controller.signal.throwIfAborted();
            return { ...result, release };
        } catch (error) { release(); throw error; }
    };
}

export function videoPlaybackOwner(state: Pick<ReturnType<typeof useUserStore.getState>, "user" | "status">) {
    if (state.status === "authenticated" && state.user) return `${state.user.id}:${state.user.role}`;
    return deploymentFeatures.authenticationEnabled ? null : "trial";
}

export const acquireVideoPlayback = createVideoPlaybackResolver({
    owner: () => videoPlaybackOwner(useUserStore.getState()),
    subscribe: invalidate => {
        const owner = videoPlaybackOwner(useUserStore.getState()), userId = useUserStore.getState().user?.id ?? null;
        const stopStore = useUserStore.subscribe(state => { if (videoPlaybackOwner(state) !== owner) invalidate(); });
        const stopWorkspace = subscribeWorkspaceIdentity(nextOwner => { if (nextOwner !== userId) invalidate(); });
        return () => { stopStore(); stopWorkspace(); };
    },
    fetch: (id, signal) => fetchServerAssetPlayback(id, { signal }),
    createUrl: blob => URL.createObjectURL(blob),
    revokeUrl: url => URL.revokeObjectURL(url),
});

/** Display state only: never replaces storage keys, original URLs, or persistent metadata. */
export function useVideoPlayback({ assetId: inputId, originalUrl, storageKey, enabled = true }: { assetId?: unknown; originalUrl: string; storageKey?: string; enabled?: boolean }) {
    const assetId = validVideoPlaybackAssetId(inputId);
    const owner = useUserStore(videoPlaybackOwner);
    const [attempt, setAttempt] = useState(0);
    const source = `${owner || ""}\n${assetId || ""}\n${storageKey || ""}\n${originalUrl}\n${enabled}\n${attempt}`;
    const initial: VideoPlaybackView = !enabled ? { status: "idle" } : assetId || storageKey ? { status: "preparing", ...(assetId ? { serverAssetId: assetId } : {}) } : { status: "local", playbackUrl: originalUrl };
    const [view, setView] = useState<{ source: string; value: VideoPlaybackView }>({ source, value: initial });
    useEffect(() => {
        setView({ source, value: initial });
        if (!enabled || (!assetId && !storageKey)) return;
        if (!owner) { setView({ source, value: { status: "error", error: "请先完成身份验证，再读取视频兼容预览。" } }); return; }
        const controller = new AbortController();
        let lease: PlaybackLease | undefined;
        void (async () => {
            const resolvedId = await resolveVideoPlaybackAssetId({ assetId, storageKey });
            if (controller.signal.aborted) return;
            if (!resolvedId) { setView({ source, value: { status: "local", playbackUrl: originalUrl } }); return; }
            setView({ source, value: { status: "preparing", serverAssetId: resolvedId } });
            const result = await acquireVideoPlayback(resolvedId, controller.signal);
            if (controller.signal.aborted) { result.release(); return; }
            lease = result;
            setView({ source, value: { status: "ready", serverAssetId: resolvedId, playbackUrl: result.playbackUrl, width: result.width, height: result.height, durationMs: result.durationMs } });
        })().catch(error => {
            if (!controller.signal.aborted) setView({ source, value: { status: "error", error: error instanceof Error ? error.message : "兼容预览暂不可用，原件未更改。" } });
        });
        return () => { controller.abort(); lease?.release(); };
    }, [source, enabled, assetId, storageKey, originalUrl, owner]);
    const update = (patch: Partial<VideoPlaybackView>) => setView(current => ({ source, value: { ...(current.source === source ? current.value : initial), ...patch } }));
    const onLoadedMetadata = (event: SyntheticEvent<HTMLVideoElement>) => {
        const video = event.currentTarget;
        update({ ...(video.videoWidth > 0 ? { width: video.videoWidth } : {}), ...(video.videoHeight > 0 ? { height: video.videoHeight } : {}), ...(Number.isFinite(video.duration) && video.duration > 0 ? { durationMs: Math.round(video.duration * 1000) } : {}) });
    };
    return {
        ...(view.source === source ? view.value : initial),
        onLoadedMetadata,
        onError: () => update({ status: "error", error: assetId || view.source === source && view.value.serverAssetId ? "当前浏览器仍无法播放兼容预览；原件未更改，可下载原件或重试预览。" : "当前浏览器无法解码本地原件；没有可用的服务端兼容预览，可下载原件。" }),
        retry: () => setAttempt(value => value + 1),
    };
}
