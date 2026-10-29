import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { App } from "antd";
import type { ConversationImageItem } from "@/components/conversation-image-controls";
import { loadCanvasExport } from "@/lib/canvas/canvas-export-loader";
import { uiText, useUiText } from "@/lib/i18n";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const CompareDialog = lazy(() => import("@/components/canvas/canvas-image-compare-dialog").then(module => ({ default: module.CanvasImageCompareDialog })));

export function conversationImageNode(image: ConversationImageItem): CanvasNodeData {
    return { id: image.id, type: CanvasNodeType.Image, title: `${image.label} · ${image.name}`, position: { x: 0, y: 0 }, width: 0, height: 0,
        metadata: { content: image.dataUrl, storageKey: image.storageKey, originalFileName: image.name } };
}
function sameImage(a: ConversationImageItem, b: ConversationImageItem) {
    return a.storageKey && b.storageKey ? a.storageKey === b.storageKey : Boolean(a.dataUrl && a.dataUrl === b.dataUrl);
}

/** Shared UI effects only. Each surface retains its own source-of-truth lineage. */
export function useConversationImageTools() {
    const t = useUiText();
    const { message } = App.useApp();
    const owner = useUserStore(state => state.user?.id);
    const jobs = useRef(new Map<string, AbortController>());
    const [comparison, setComparison] = useState<{ owner: string | undefined; nodes: CanvasNodeData[]; initialIds: string[] } | null>(null);
    useEffect(() => () => { for (const job of jobs.current.values()) job.abort(); jobs.current.clear(); }, [owner]);
    const download = useCallback(async (image: ConversationImageItem) => {
        if (jobs.current.has(image.id)) return;
        const job = new AbortController(); jobs.current.set(image.id, job);
        try {
            if (image.unavailableReason || (!image.storageKey && !image.dataUrl)) throw new Error(uiText(image.unavailableReason || "原图暂时无法读取"));
            const { downloadCanvasImage } = await loadCanvasExport();
            if (useUserStore.getState().user?.id !== owner) return;
            await downloadCanvasImage(conversationImageNode(image), "original", { signal: job.signal });
        } catch (error) {
            if (!job.signal.aborted && useUserStore.getState().user?.id === owner) void message.error(error instanceof Error ? error.message : uiText("图片下载失败，请重试"));
        } finally { if (jobs.current.get(image.id) === job) jobs.current.delete(image.id); }
    }, [message, owner]);
    const compare = useCallback((image: ConversationImageItem, originals: ConversationImageItem[]) => {
        const available = originals.filter((item, index) => !item.unavailableReason && (item.storageKey || item.dataUrl) && !sameImage(item, image) && !originals.slice(0, index).some(previous => sameImage(previous, item)));
        if (!available.length) { void message.info(uiText("没有可对比的原图")); return; }
        const after = conversationImageNode({ ...image, id: `comparison-result:${image.id}` });
        const before = available.map((item, index) => conversationImageNode({ ...item, id: `comparison-original:${index}:${item.id}` }));
        // More than one original requires an explicit choice; never pick the first by accident.
        setComparison({ owner, nodes: [...before, after], initialIds: before.length === 1 ? [before[0].id, after.id] : [after.id] });
    }, [message, owner]);
    const compareDialog = comparison && comparison.owner === owner ? <Suspense fallback={<div role="status">{t("正在打开图片对比…")}</div>}><CompareDialog key={comparison.initialIds.join("|")} nodes={comparison.nodes} initialIds={comparison.initialIds} comparisonBasis="original" onClose={() => setComparison(null)} /></Suspense> : null;
    return { download, compare, compareDialog };
}
