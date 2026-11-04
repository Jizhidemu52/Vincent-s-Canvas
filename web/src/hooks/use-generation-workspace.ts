import { useEffect, useRef, useState } from "react";
import type { HistoryDeletionResult } from "@/lib/history-batch-delete";

/**
 * Shared workbench interactions. Model rules, reference validation and durable
 * media storage stay in each image/video runtime, not in this UI state owner.
 * Mount one instance per employee/tool (the page wrappers provide that key).
 */
export function useGenerationWorkspace<Reference, Log extends { id: string }>() {
    const [references, setReferences] = useState<Reference[]>([]);
    const [logs, setLogs] = useState<Log[]>([]);
    const [running, setRunning] = useState(false);
    const [startedAt, setStartedAt] = useState(0);
    const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<Log | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [deletingLogs, setDeletingLogs] = useState(false);
    const deleting = useRef(false);
    const mounted = useRef(false);
    const latestPreview = useRef(previewLog);
    latestPreview.current = previewLog;

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    // Do not clear selection or dismiss confirmation until persistence succeeds.
    // A synchronous guard also rejects a second click before React rerenders.
    const deleteSelectedHistory = async (remove: (selected: Log[]) => Promise<void | HistoryDeletionResult>, requestedIds = selectedLogIds) => {
        if (running || deleting.current || !mounted.current) return null;
        const selectedIds = new Set(requestedIds);
        const selected = logs.filter(log => selectedIds.has(log.id));
        if (!selected.length) return null;
        deleting.current = true;
        setDeletingLogs(true);
        try {
            const result = await remove(selected);
            if (!mounted.current) return null;
            const deletedIds = new Set(result ? result.deletedIds.filter(id => selectedIds.has(id)) : selected.map(log => log.id));
            const failedIds = selected.filter(log => !deletedIds.has(log.id)).map(log => log.id);
            const previewRemoved = Boolean(latestPreview.current && deletedIds.has(latestPreview.current.id));
            setLogs(current => current.filter(log => !deletedIds.has(log.id)));
            setSelectedLogIds(current => [...new Set([...current.filter(id => !deletedIds.has(id)), ...failedIds])]);
            setPreviewLog(current => current && deletedIds.has(current.id) ? null : current);
            setDeleteConfirmOpen(Boolean(failedIds.length));
            return { previewRemoved, deletedIds: [...deletedIds], failedIds };
        } finally {
            deleting.current = false;
            if (mounted.current) setDeletingLogs(false);
        }
    };

    return {
        references, setReferences, logs, setLogs, running, setRunning, startedAt, setStartedAt, activeTaskId, setActiveTaskId,
        previewLoading, setPreviewLoading, logsOpen, setLogsOpen, settingsOpen, setSettingsOpen,
        promptDialogOpen, setPromptDialogOpen, assetPickerOpen, setAssetPickerOpen,
        selectedLogIds, setSelectedLogIds, previewLog, setPreviewLog, deleteConfirmOpen, setDeleteConfirmOpen,
        deletingLogs, deleteSelectedHistory,
    };
}
