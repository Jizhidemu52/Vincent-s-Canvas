import { useUserStore } from "@/stores/use-user-store";

const eventName = "canvas-assets-changed";
export const ASSET_VISIBLE_REFRESH_MS = 20_000;

export function notifyAssetsChanged(ownerId: string | undefined) {
    if (!ownerId || useUserStore.getState().user?.id !== ownerId || typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(eventName, { detail: { ownerId } }));
    if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel(eventName);
        channel.postMessage({ ownerId });
        channel.close();
    }
}

export function watchVisibleAssetChanges(ownerId: string, refresh: (signal: AbortSignal) => Promise<unknown>) {
    let active = true, running = false, requested = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const visible = () => active && useUserStore.getState().user?.id === ownerId && !document.hidden && navigator.onLine !== false;
    const schedule = (delay = ASSET_VISIBLE_REFRESH_MS) => {
        clearTimeout(timer);
        if (visible()) timer = setTimeout(() => { void run(); }, delay);
    };
    const run = async () => {
        if (!visible()) return;
        if (running) { requested = true; return; }
        running = true; requested = false;
        controller = new AbortController();
        try { await refresh(controller.signal); }
        catch { }
        finally { running = false; schedule(requested ? 200 : ASSET_VISIBLE_REFRESH_MS); }
    };
    const changed = (event: Event | MessageEvent) => {
        const value = "data" in event ? event.data : (event as CustomEvent).detail;
        if (value?.ownerId === ownerId) schedule(200);
    };
    const wake = () => {
        if (visible()) schedule(200);
        else { clearTimeout(timer); controller?.abort(); }
    };
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(eventName);
    channel?.addEventListener("message", changed);
    window.addEventListener(eventName, changed);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    window.addEventListener("offline", wake);
    document.addEventListener("visibilitychange", wake);
    schedule();
    return () => {
        active = false; clearTimeout(timer); controller?.abort(); channel?.close();
        window.removeEventListener(eventName, changed);
        window.removeEventListener("focus", wake);
        window.removeEventListener("online", wake);
        window.removeEventListener("offline", wake);
        document.removeEventListener("visibilitychange", wake);
    };
}
