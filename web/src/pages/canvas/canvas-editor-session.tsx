import { staticUiText } from "@/lib/static-ui-copy";
import { useUiLocale } from "@/lib/i18n";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { canvasThemes } from "@/lib/canvas-theme";
import { reloadCanvasProject } from "@/stores/canvas/use-canvas-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasEditLock } from "./use-canvas-edit-lock";

export type CanvasEditorFlushRef = RefObject<(() => Promise<void>) | null>;
export type CanvasEditorWriteCapability = RefObject<boolean> & { ensureWritable: () => Promise<boolean> };
export type CanvasEditorRecoveryRef = RefObject<{ backup: () => Promise<void>; discardPending: () => void } | null>;

/** Initial readonly tabs do not mount editors; interrupted editors retain their drafts. */
export function CanvasEditorSession({ owner, projectId, enabled = true, children }: {
    owner: string; projectId: string; enabled?: boolean; children: (flushRef: CanvasEditorFlushRef, writable: CanvasEditorWriteCapability, recoveryRef: CanvasEditorRecoveryRef) => ReactNode;
}) {
    useUiLocale();
    const flushRef = useRef<(() => Promise<void>) | null>(null);
    const recoveryRef = useRef<CanvasEditorRecoveryRef["current"]>(null);
    const mountedEditor = useRef(false);
    const currentEpoch = useRef(0);
    const [editorEpoch, setEditorEpoch] = useState(0);
    const backupReady = useRef(false);
    const [viewState, setViews] = useState<typeof import("./canvas-editor-session-views") | "error">();
    const views = viewState === "error" ? undefined : viewState;
    const canWriteRef = useRef<() => boolean>(() => false);
    const ensureWritableRef = useRef<() => Promise<boolean>>(async () => false);
    const writable = useMemo<CanvasEditorWriteCapability>(() => ({
        get current() { return currentEpoch.current === editorEpoch && mountedEditor.current && canWriteRef.current(); },
        async ensureWritable() {
            if (currentEpoch.current !== editorEpoch || !mountedEditor.current) return false;
            const ready = await ensureWritableRef.current();
            return ready && currentEpoch.current === editorEpoch && mountedEditor.current && canWriteRef.current();
        },
    }), [editorEpoch]);
    const flush = useCallback(async () => { await flushRef.current?.(); }, []);
    const reload = useCallback(async () => {
        if (mountedEditor.current && !backupReady.current) throw new Error("请先备份本页未保存内容，再载入最新画布。");
        await reloadCanvasProject(projectId);
        if (mountedEditor.current) {
            // Reacquisition is a new editing lifetime. Old async work and queues
            // must never inherit the new holder's write capability.
            recoveryRef.current?.discardPending();
            currentEpoch.current += 1;
        }
        backupReady.current = false;
    }, [projectId]);
    const lock = useCanvasEditLock(owner, projectId, flush, enabled, reload);
    const needsViews = !lock.isEditable && lock.status !== "checking" && lock.status !== "recovering";
    useEffect(() => {
        if (!needsViews || viewState) return;
        // A failed optional recovery chunk must not unmount the retained editor.
        // Keeping the loaded module never grants writes or changes editor epochs.
        void import("./canvas-editor-session-views").then(setViews).catch(() => setViews("error"));
    }, [needsViews, viewState]);
    canWriteRef.current = lock.canWrite;
    ensureWritableRef.current = lock.ensureWritable;
    useLayoutEffect(() => {
        // onAcquired runs before the hook enables writes. Mount the replacement
        // only afterwards, so its async observers do not see a false revocation.
        if (lock.isEditable && editorEpoch !== currentEpoch.current) setEditorEpoch(currentEpoch.current);
    }, [editorEpoch, lock.isEditable]);
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const transferring = lock.status === "checking" && Boolean(lock.holder) && mountedEditor.current;
    if (lock.isEditable) mountedEditor.current = true;
    const recovering = lock.status === "recovering";
    const blocked = !lock.isEditable || editorEpoch !== currentEpoch.current;
    const waiting = <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm" style={{ background: `${theme.canvas.background}bb`, color: theme.node.text }}>
        <p role="status">{recovering ? staticUiText("正在恢复本页编辑连接，画布内容已保留…") : transferring ? staticUiText("正在保存并移交编辑权…") : viewState === "error" ? staticUiText("恢复界面暂时无法载入，本页内容已保留。") : staticUiText("正在确认编辑权…")}</p>
        {viewState === "error" ? <button type="button" className="underline" onClick={() => setViews(undefined)}>{staticUiText("重试载入恢复界面")}</button> : null}
    </div>;
    if (mountedEditor.current) return <div className="relative h-full" data-canvas-edit-blocked={blocked ? "true" : undefined}>
        <div key={editorEpoch} inert={blocked} className="h-full">{children(flushRef, writable, recoveryRef)}</div>
        {blocked ? views ? <views.CanvasRecoveryOverlay lock={lock} transferring={transferring} recoveryRef={recoveryRef} onBackedUp={requestEditing => {
            backupReady.current = true;
            if (requestEditing) lock.requestEditing();
        }} /> : <div className="absolute inset-0 z-[100]">{waiting}</div> : null}
        {!blocked && lock.error ? <div role="status" className="absolute bottom-16 left-1/2 z-40 max-w-lg -translate-x-1/2 rounded-lg px-4 py-2 text-sm" style={{ background: theme.node.panel, color: theme.node.warning }}>{lock.error}</div> : null}
    </div>;
    return views ? <views.CanvasReadonlySession projectId={projectId} lock={lock} /> : <main data-testid="canvas-readonly-session" className="relative h-full min-h-0 overflow-hidden">{waiting}</main>;
}
