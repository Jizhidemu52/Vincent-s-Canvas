import { useCallback, useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { CANVAS_EDIT_LEASE_RENEW_MS, createCanvasEditLease } from "@/lib/canvas/canvas-edit-lease";

type LockState = { status: "checking" | "editing" | "readonly" | "unsupported" | "error"; holder?: string; error?: string };

/** Only the current owner may release their lock, after a successful local flush. */
export function useCanvasEditLock(owner: string, projectId: string, flush: () => void | Promise<void>, enabled = true, onAcquired?: () => void | Promise<void>) {
    const [state, setState] = useState<LockState>({ status: "checking" });
    const flushRef = useRef(flush);
    flushRef.current = flush;
    const acquiredRef = useRef(onAcquired);
    acquiredRef.current = onAcquired;
    const requestRef = useRef<() => void>(() => undefined);
    useEffect(() => {
        if (!enabled) { setState({ status: "editing" }); return; }
        if ((!navigator.locks && typeof indexedDB === "undefined") || typeof BroadcastChannel === "undefined") {
            setState({ status: "unsupported", error: "当前浏览器无法建立跨标签页编辑保护，请使用支持 IndexedDB 的浏览器后重试。" });
            return;
        }
        const key = `canvas-editor:${JSON.stringify([owner, projectId])}`;
        // randomUUID, like Web Locks, is unavailable on HTTP intranet origins.
        const tab = nanoid();
        const channel = new BroadcastChannel(key);
        const lease = navigator.locks ? undefined : createCanvasEditLease();
        let closed = false, release: (() => void) | undefined, transferring = false, waiting = false;
        let pendingRequest: AbortController | undefined;
        let leaseExpiresAt = 0, renewing = false;
        let retry: ReturnType<typeof setTimeout> | undefined;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let acquisitionReady: Promise<void> = Promise.resolve();
        const loseLease = (error = "编辑权已失效，已停止编辑；请重新申请后载入最新内容。") => {
            release?.();
            if (!closed) setState({ status: "readonly", error });
        };
        const announce = () => { if (release) channel.postMessage({ type: "holder", tab }); };
        const acquireLease = async (wait: boolean) => {
            if (!lease || closed || !waiting) return;
            try {
                const record = await lease.claim(key, tab);
                if (closed || !waiting) { if (record) await lease.release(key, tab); return; }
                if (!record) {
                    setState({ status: "readonly" });
                    channel.postMessage({ type: "query" });
                    if (wait) retry = setTimeout(() => { void acquireLease(true); }, 500);
                    else waiting = false;
                    return;
                }
                waiting = false;
                leaseExpiresAt = record.expiresAt;
                const releaseThisLease = () => {
                    if (release !== releaseThisLease) return;
                    release = undefined;
                    if (heartbeat) clearInterval(heartbeat);
                    heartbeat = undefined;
                    void lease.release(key, tab).then(() => { if (!closed) channel.postMessage({ type: "released", tab }); }).catch(() => undefined);
                };
                release = releaseThisLease;
                heartbeat = setInterval(() => {
                    if (closed || release !== releaseThisLease || renewing) return;
                    if (Date.now() >= leaseExpiresAt) { loseLease(); return; }
                    renewing = true;
                    void lease.renew(key, tab).then(next => {
                        if (closed || release !== releaseThisLease) return;
                        if (!next) loseLease();
                        else leaseExpiresAt = next.expiresAt;
                    }).catch(() => { if (!closed && release === releaseThisLease) loseLease("无法续约编辑保护，已停止编辑；请检查本机存储后重新申请。"); }).finally(() => { renewing = false; });
                }, CANVAS_EDIT_LEASE_RENEW_MS);
                try {
                    acquisitionReady = Promise.resolve().then(() => acquiredRef.current?.());
                    await acquisitionReady;
                    if (closed || release !== releaseThisLease) return;
                    if (Date.now() >= leaseExpiresAt) { loseLease(); return; }
                    if (!transferring) setState({ status: "editing", holder: tab });
                    announce();
                } catch (error) {
                    releaseThisLease();
                    if (!closed) setState({ status: "error", error: error instanceof Error ? error.message : "无法载入最新画布" });
                }
            } catch (error) {
                waiting = false;
                if (!closed) setState({ status: "error", error: error instanceof Error ? error.message : "编辑保护失败" });
            }
        };
        const acquire = (wait: boolean) => {
            if (waiting) return;
            waiting = true;
            const abort = wait ? new AbortController() : undefined;
            pendingRequest = abort;
            setState({ status: "checking" });
            if (lease) { void acquireLease(wait); return; }
            void navigator.locks.request(key, wait ? { signal: abort!.signal } : { ifAvailable: true }, async lock => {
                if (closed) return;
                waiting = false;
                pendingRequest = undefined;
                if (!lock) { setState({ status: "readonly" }); channel.postMessage({ type: "query" }); return; }
                let releaseThisLock: () => void;
                const held = new Promise<void>(resolve => { release = releaseThisLock = resolve; });
                try {
                    // The new holder must read the durable latest graph before
                    // enabling edits; its previous readonly snapshot is stale.
                    acquisitionReady = Promise.resolve().then(() => acquiredRef.current?.());
                    await acquisitionReady;
                    if (!closed && release === releaseThisLock!) { if (!transferring) setState({ status: "editing", holder: tab }); announce(); }
                    await held;
                } finally { release = undefined; }
            }).catch(error => {
                waiting = false;
                if (!closed && error?.name !== "AbortError") setState({ status: "error", error: error instanceof Error ? error.message : "编辑保护失败" });
            });
        };
        channel.onmessage = async ({ data }) => {
            if (closed || !data || data.tab === tab) return;
            if (data.type === "query") announce();
            if (data.type === "holder" && !release) setState({ status: "readonly", holder: String(data.tab) });
            if (data.type === "denied" && !release) {
                pendingRequest?.abort(); pendingRequest = undefined; waiting = false;
                if (retry) clearTimeout(retry);
                setState({ status: "readonly", holder: String(data.tab), error: "另一标签页尚未保存成功，请先在该页面保存或导出备份。" });
            }
            if (data.type !== "request" || !release || transferring) return;
            const transferringRelease = release;
            transferring = true;
            // Block edits while draining. A rejected save never gives the lock away.
            setState({ status: "checking", holder: tab });
            try {
                await acquisitionReady;
                if (closed || release !== transferringRelease) return;
                await flushRef.current();
                if (closed || release !== transferringRelease) return;
                transferringRelease();
                release = undefined;
                setState({ status: "readonly", holder: String(data.tab) });
            } catch {
                if (!closed && release === transferringRelease) {
                    setState({ status: "editing", holder: tab, error: "本页尚未保存成功，未移交编辑权；请先保存或导出备份。" });
                    channel.postMessage({ type: "denied", tab });
                }
            } finally { transferring = false; }
        };
        // A suspended HTTP tab must not mutate before its expired lease is checked.
        const checkLease = (event: Event) => {
            if (!lease || !release || Date.now() < leaseExpiresAt) return;
            loseLease();
            if (event.cancelable) event.preventDefault();
            event.stopImmediatePropagation();
        };
        const guardedEvents = ["pointerdown", "keydown", "beforeinput", "focus", "pageshow"] as const;
        for (const event of guardedEvents) window.addEventListener(event, checkLease, true);
        document.addEventListener("visibilitychange", checkLease, true);
        requestRef.current = () => { if (release || closed) return; channel.postMessage({ type: "request", tab }); acquire(true); };
        // React StrictMode sets up/cleans up once before the real mount. Do not
        // let that abandoned ifAvailable request briefly deny the real request.
        queueMicrotask(() => { if (!closed) acquire(false); });
        return () => {
            closed = true;
            requestRef.current = () => undefined;
            pendingRequest?.abort();
            if (retry) clearTimeout(retry);
            if (heartbeat) clearInterval(heartbeat);
            release?.();
            lease?.close();
            channel.close();
            for (const event of guardedEvents) window.removeEventListener(event, checkLease, true);
            document.removeEventListener("visibilitychange", checkLease, true);
        };
    }, [owner, projectId, enabled]);
    const requestEditing = useCallback(() => requestRef.current(), []);
    return { ...state, supported: state.status !== "unsupported", isEditable: state.status === "editing", requestEditing };
}
