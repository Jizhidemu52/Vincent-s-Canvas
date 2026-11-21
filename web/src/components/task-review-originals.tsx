import { useEffect, useRef, useState } from "react";
import { saveAs } from "file-saver";
import { useUserStore } from "@/stores/use-user-store";
import { listReviewOriginals, readReviewOriginal, type ReviewOriginal } from "@/services/api/task-review-originals";
import { uiText, useUiText } from "@/lib/i18n";

export function TaskReviewOriginals({ taskId, owner }: { taskId: string; owner: string }) {
    useUiText();
    const [items, setItems] = useState<ReviewOriginal[]>();
    const [attempt, setAttempt] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const active = useRef<AbortController | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        active.current = controller;
        setError(""); setItems(undefined); setBusy(false);
        void listReviewOriginals(taskId, owner, controller.signal).then(found => {
            if (!controller.signal.aborted) setItems(found);
        }).catch(() => { if (!controller.signal.aborted) setError("暂时无法核对原件，请刷新原件列表。"); });
        return () => { controller.abort(); active.current = null; };
    }, [taskId, owner, attempt]);

    async function download(original: ReviewOriginal) {
        const signal = active.current?.signal;
        if (!signal || busy) return;
        setBusy(true); setError("");
        try {
            const blob = await readReviewOriginal(original, owner, signal);
            if (!signal.aborted && useUserStore.getState().user?.id === owner) saveAs(blob, original.filename);
        } catch (caught) {
            if (!signal.aborted) setError(caught instanceof Error ? caught.message : "暂时无法下载原件，请稍后重试。");
        } finally { if (!signal.aborted) setBusy(false); }
    }
    return <div className="grid gap-1 text-xs">
        {items?.map(item => <button type="button" key={item.assetId} className="underline" disabled={busy} onClick={() => void download(item)}>{uiText("下载已保存原件")}{items.length > 1 ? ` · ${item.resultIndex + 1}` : ""}</button>)}
        {items?.length === 0 && <small>{uiText("这笔任务没有可下载的已保存原件。")}</small>}
        {error && <small role="status">{uiText(error)}</small>}
        {error && !items && <button type="button" className="underline" onClick={() => setAttempt(n => n + 1)}>{uiText("刷新原件列表")}</button>}
    </div>;
}
