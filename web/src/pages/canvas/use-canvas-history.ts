import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanvasHistorySnapshot } from "@/stores/canvas/use-canvas-store";

export type CanvasHistoryEntry = CanvasHistorySnapshot;

export function boundedCanvasHistory(history?: { past: CanvasHistoryEntry[]; future: CanvasHistoryEntry[] }) {
    return { past: (history?.past || []).slice(-50), future: (history?.future || []).slice(-50) };
}

/** Include a not-yet-committed edit when closing before the undo debounce fires. */
export function canvasHistoryForSave(history: { past: CanvasHistoryEntry[]; future: CanvasHistoryEntry[] }, previous: CanvasHistoryEntry | null, current: CanvasHistoryEntry, applyingHistory: boolean) {
    const saved = boundedCanvasHistory(history);
    // Chat remains in the legacy snapshot shape for storage compatibility, but
    // it is not an edit command and must neither add undo steps nor discard redo.
    const changed = previous && (["nodes", "connections", "groups", "backgroundMode", "showImageInfo"] as const).some(key => previous[key] !== current[key]);
    if (!applyingHistory && changed) return { past: [...saved.past.slice(-49), previous!], future: [] };
    return saved;
}

export function useCanvasHistoryState() {
    const historyRef = useRef<{ past: CanvasHistoryEntry[]; future: CanvasHistoryEntry[] }>({ past: [], future: [] });
    const lastHistoryRef = useRef<CanvasHistoryEntry | null>(null);
    const historyCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const applyingHistoryRef = useRef(false);
    const pendingHistoryEntryRef = useRef<CanvasHistoryEntry | null>(null);
    const historyPausedRef = useRef(false);
    const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
    return { historyRef, lastHistoryRef, historyCommitTimerRef, applyingHistoryRef, pendingHistoryEntryRef, historyPausedRef, historyState, setHistoryState };
}

export function useCanvasHistory(history: ReturnType<typeof useCanvasHistoryState>, options: {
    current: CanvasHistoryEntry; projectLoaded: boolean;
    createHistoryEntry: () => CanvasHistoryEntry; applyHistory: (entry: CanvasHistoryEntry) => void;
}) {
    const { historyRef, lastHistoryRef, historyCommitTimerRef, applyingHistoryRef, pendingHistoryEntryRef, historyPausedRef, setHistoryState } = history;
    const { projectLoaded, createHistoryEntry, applyHistory } = options;
    const { nodes, connections, groups, backgroundMode, showImageInfo } = options.current;
    const flushPendingHistory = useCallback(() => {
        if (!projectLoaded || applyingHistoryRef.current || historyPausedRef.current || !lastHistoryRef.current) return false;
        if (historyCommitTimerRef.current) {
            clearTimeout(historyCommitTimerRef.current);
            historyCommitTimerRef.current = null;
        }
        const current = createHistoryEntry();
        historyRef.current = canvasHistoryForSave(historyRef.current, lastHistoryRef.current, current, false);
        lastHistoryRef.current = current;
        setHistoryState({ canUndo: historyRef.current.past.length > 0, canRedo: historyRef.current.future.length > 0 });
        return true;
    }, [createHistoryEntry, projectLoaded]);

    useEffect(() => {
        if (!projectLoaded || applyingHistoryRef.current || historyPausedRef.current) return;
        const next = createHistoryEntry();
        const previous = lastHistoryRef.current;
        const pendingHistory = canvasHistoryForSave(historyRef.current, previous, next, false);
        const availability = { canUndo: pendingHistory.past.length > 0, canRedo: pendingHistory.future.length > 0 };
        setHistoryState(current => current.canUndo === availability.canUndo && current.canRedo === availability.canRedo ? current : availability);
        if (
            previous?.nodes === next.nodes &&
            previous.connections === next.connections &&
            previous.groups === next.groups &&
            previous.backgroundMode === next.backgroundMode &&
            previous.showImageInfo === next.showImageInfo
        )
            return;

        if (historyCommitTimerRef.current) clearTimeout(historyCommitTimerRef.current);
        historyCommitTimerRef.current = setTimeout(flushPendingHistory, 180);

        return () => {
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
        };
    }, [backgroundMode, connections, groups, createHistoryEntry, flushPendingHistory, nodes, projectLoaded, showImageInfo]);

    useLayoutEffect(() => {
        const restored = pendingHistoryEntryRef.current;
        if (!restored || nodes !== restored.nodes || connections !== restored.connections || groups !== restored.groups ||
            backgroundMode !== restored.backgroundMode || showImageInfo !== restored.showImageInfo) return;
        // The visible graph is ready now; a timer would leave rapid redo/undo ignored.
        lastHistoryRef.current = restored;
        pendingHistoryEntryRef.current = null;
        applyingHistoryRef.current = false;
        setHistoryState({ canUndo: historyRef.current.past.length > 0, canRedo: historyRef.current.future.length > 0 });
    }, [backgroundMode, connections, groups, nodes, showImageInfo]);

    const undoCanvas = useCallback(() => {
        if (!flushPendingHistory()) return;
        const previous = historyRef.current.past.pop();
        const current = lastHistoryRef.current;
        if (!previous || !current) return;
        historyRef.current.future.push(current);
        applyHistory(previous);
    }, [applyHistory, flushPendingHistory]);

    const redoCanvas = useCallback(() => {
        if (!flushPendingHistory()) return;
        const next = historyRef.current.future.pop();
        const current = lastHistoryRef.current;
        if (!next || !current) return;
        historyRef.current.past.push(current);
        applyHistory(next);
    }, [applyHistory, flushPendingHistory]);
    return { flushPendingHistory, undoCanvas, redoCanvas };
}
