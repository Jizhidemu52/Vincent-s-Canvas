import { useCallback, useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";

type LockState = { status: "checking" | "recovering" | "editing" | "readonly" | "unsupported" | "error"; holder?: string; error?: string };

/** Only the current owner may release their lock, after a successful local flush. */
export function useCanvasEditLock(owner: string, projectId: string, flush: () => void | Promise<void>, enabled = true, onAcquired?: () => void | Promise<void>) {
    const [state, setState] = useState<LockState>({ status: "checking" });
    const flushRef = useRef(flush);
    flushRef.current = flush;
    const acquiredRef = useRef(onAcquired);
    acquiredRef.current = onAcquired;
    const requestRef = useRef<() => void>(() => undefined);
    const canWriteRef = useRef<() => boolean>(() => false);
    const ensureWritableRef = useRef<() => Promise<boolean>>(async () => false);
    useEffect(() => {
        if (!enabled) {
            canWriteRef.current = () => true;
            ensureWritableRef.current = async () => true;
            setState({ status: "editing" });
            return () => { canWriteRef.current = () => false; ensureWritableRef.current = async () => false; };
        }
        if ((!navigator.locks && typeof indexedDB === "undefined") || typeof BroadcastChannel === "undefined") {
            setState({ status: "unsupported", error: "当前浏览器无法建立跨标签页编辑保护，请使用支持 IndexedDB 的浏览器后重试。" });
            return;
        }
        const key = `canvas-editor:${JSON.stringify([owner, projectId])}`;
        // randomUUID, like Web Locks, is unavailable on HTTP intranet origins.
        const tab = nanoid();
        const channel = new BroadcastChannel(key);
        const lease = navigator.locks ? undefined : import("@/lib/canvas/canvas-edit-lease").then(module => ({
            ...module.createCanvasEditLease(), renewInterval: module.CANVAS_EDIT_LEASE_RENEW_MS,
        }));
        let closed = false, release: (() => void) | undefined, transferring = false, waiting = false;
        let pendingRequest: AbortController | undefined;
        let leaseExpiresAt = 0, editorReady = false, writeAllowed = false;
        let renewal: Promise<boolean> | undefined;
        let retry: ReturnType<typeof setTimeout> | undefined;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let acquisitionReady: Promise<void> = Promise.resolve();
        const loseLease = (error = "此画布已在其他页面继续编辑，本页暂不写入；请保留本页改动后再切换。") => {
            writeAllowed = false;
            release?.();
            if (!closed) setState({ status: "readonly", error });
        };
        const announce = () => { if (release) channel.postMessage({ type: "holder", tab }); };
        // Revalidate the SAME IDB owner atomically. A general claim here would
        // silently reopen a stale draft after another tab had edited and left.
        const refreshLease = (): Promise<boolean> => {
            if (!lease || !release || closed) return Promise.resolve(false);
            if (Date.now() >= leaseExpiresAt) {
                const shouldNotify = writeAllowed;
                writeAllowed = false;
                // canWrite() is also read by child render/save guards. Fence
                // immediately, but never update a parent while rendering a child.
                if (shouldNotify && editorReady) queueMicrotask(() => {
                    if (!closed && release && !writeAllowed && !transferring) setState({ status: "recovering", holder: tab });
                });
            }
            if (renewal) return renewal;
            const currentRelease = release;
            renewal = lease.then(client => client.resume(key, tab)).then(next => {
                if (closed || release !== currentRelease) return false;
                if (!next || Date.now() >= next.expiresAt) { loseLease(); return false; }
                leaseExpiresAt = next.expiresAt;
                if (editorReady) {
                    const resuming = !writeAllowed;
                    writeAllowed = true;
                    if (resuming) setState({ status: transferring ? "checking" : "editing", holder: tab });
                }
                return true;
            }).catch(() => {
                if (!closed && release === currentRelease) loseLease("浏览器本地存储暂时不可用，已暂停写入；请保留本页改动后重试。");
                return false;
            }).finally(() => { renewal = undefined; });
            return renewal;
        };
        canWriteRef.current = () => {
            if (closed || !release || !editorReady) return false;
            if (lease && Date.now() >= leaseExpiresAt) { void refreshLease(); return false; }
            return writeAllowed;
        };
        ensureWritableRef.current = async () => {
            if (closed || !release || !editorReady) return false;
            if (lease && (Date.now() >= leaseExpiresAt || !writeAllowed)) {
                if (!await refreshLease()) return false;
            }
            return canWriteRef.current();
        };
        const acquireLease = async (wait: boolean) => {
            if (!lease || closed || !waiting) return;
            try {
                const client = await lease;
                if (closed || !waiting) return;
                const record = await client.claim(key, tab);
                if (closed || !waiting) { if (record) await client.release(key, tab); return; }
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
                    writeAllowed = false;
                    release = undefined;
                    if (heartbeat) clearInterval(heartbeat);
                    heartbeat = undefined;
                    void client.release(key, tab).then(() => { if (!closed) channel.postMessage({ type: "released", tab }); }).catch(() => undefined);
                };
                release = releaseThisLease;
                heartbeat = setInterval(() => {
                    if (!closed && release === releaseThisLease) void refreshLease();
                }, client.renewInterval);
                try {
                    acquisitionReady = Promise.resolve().then(() => acquiredRef.current?.());
                    await acquisitionReady;
                    if (closed || release !== releaseThisLease) return;
                    if (Date.now() >= leaseExpiresAt && !await refreshLease()) return;
                    if (closed || release !== releaseThisLease) return;
                    editorReady = true;
                    writeAllowed = true;
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
            editorReady = false;
            writeAllowed = false;
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
                const held = new Promise<void>(resolve => { release = releaseThisLock = () => { writeAllowed = false; resolve(); }; });
                try {
                    // The new holder must read the durable latest graph before
                    // enabling edits; its previous readonly snapshot is stale.
                    acquisitionReady = Promise.resolve().then(() => acquiredRef.current?.());
                    await acquisitionReady;
                    if (!closed && release === releaseThisLock!) {
                        editorReady = true; writeAllowed = true;
                        if (!transferring) setState({ status: "editing", holder: tab });
                        announce();
                    }
                    await held;
                } finally { writeAllowed = false; release = undefined; }
            }).catch(error => {
                waiting = false;
                if (!closed && error?.name !== "AbortError") setState({ status: "error", error: error instanceof Error ? error.message : "编辑保护失败" });
            });
        };
        channel.onmessage = async ({ data }) => {
            if (closed || !data || data.tab === tab) return;
            if (data.type === "query") announce();
            if (data.type === "holder" && !release) setState({ status: "readonly", holder: String(data.tab) });
            if (data.type === "holder" && release && lease) void refreshLease();
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
                if (!await ensureWritableRef.current()) return;
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
        // Block the first edit synchronously while checking a suspended tab.
        // The mounted editor/draft stays intact; no reload on same-owner resume.
        const checkLease = (event: Event) => {
            if (!lease || !release || Date.now() < leaseExpiresAt) return;
            void refreshLease();
            if (event.cancelable) event.preventDefault();
            event.stopImmediatePropagation();
        };
        const guardedEvents = ["pointerdown", "keydown", "beforeinput", "focus", "pageshow"] as const;
        for (const event of guardedEvents) window.addEventListener(event, checkLease, true);
        document.addEventListener("visibilitychange", checkLease, true);
        requestRef.current = () => {
            if (closed) return;
            if (release) { if (lease) void refreshLease(); return; }
            channel.postMessage({ type: "request", tab }); acquire(true);
        };
        // React StrictMode sets up/cleans up once before the real mount. Do not
        // let that abandoned ifAvailable request briefly deny the real request.
        queueMicrotask(() => { if (!closed) acquire(false); });
        return () => {
            closed = true;
            writeAllowed = false;
            canWriteRef.current = () => false;
            ensureWritableRef.current = async () => false;
            requestRef.current = () => undefined;
            pendingRequest?.abort();
            if (retry) clearTimeout(retry);
            if (heartbeat) clearInterval(heartbeat);
            release?.();
            void lease?.then(client => client.close()).catch(() => undefined);
            channel.close();
            for (const event of guardedEvents) window.removeEventListener(event, checkLease, true);
            document.removeEventListener("visibilitychange", checkLease, true);
        };
    }, [owner, projectId, enabled]);
    const requestEditing = useCallback(() => requestRef.current(), []);
    const canWrite = useCallback(() => canWriteRef.current(), []);
    const ensureWritable = useCallback(() => ensureWritableRef.current(), []);
    return { ...state, supported: state.status !== "unsupported", isEditable: state.status === "editing", requestEditing, canWrite, ensureWritable };
}
