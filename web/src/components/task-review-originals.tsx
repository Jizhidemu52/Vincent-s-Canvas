import { useEffect, useRef, useState } from "react";
import { saveAs } from "file-saver";
import { useUserStore } from "@/stores/use-user-store";
import {
    listReviewOriginals,
    originalSizeReissue,
    readReviewOriginal,
    ReissueNotSubmitted,
    type ReviewOriginal,
} from "@/services/api/task-review-originals";
import type { ReissueReceipt } from "../../../shared/task-review-originals";
import { uiText, useUiText } from "@/lib/i18n";

export function TaskReviewOriginals({ taskId, owner }: { taskId: string; owner: string }) {
    useUiText();
    const [items, setItems] = useState<ReviewOriginal[]>();
    const [attempt, setAttempt] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [canCheck, setCanCheck] = useState(false);
    const [reissue, setReissue] = useState<ReissueReceipt>();
    const [checking, setChecking] = useState(false);
    const [reissueError, setReissueError] = useState("");
    const inFlight = useRef(false);
    const active = useRef<AbortController | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        active.current = controller;
        setError("");
        setItems(undefined);
        setBusy(false);
        void listReviewOriginals(taskId, owner, controller.signal)
            .then((found) => {
                if (!controller.signal.aborted) {
                    setItems(found.originals);
                    setCanCheck(found.canCheckOriginalSize === true);
                }
            })
            .catch(() => {
                if (!controller.signal.aborted) setError("暂时无法核对原件，请刷新原件列表。");
            });
        return () => {
            controller.abort();
            active.current = null;
        };
    }, [taskId, owner, attempt]);

    async function download(original: ReviewOriginal) {
        const signal = active.current?.signal;
        if (!signal || busy) return;
        setBusy(true);
        setError("");
        try {
            const blob = await readReviewOriginal(original, owner, signal);
            if (!signal.aborted && useUserStore.getState().user?.id === owner) saveAs(blob, original.filename);
        } catch (caught) {
            if (!signal.aborted) setError(caught instanceof Error ? caught.message : "暂时无法下载原件，请稍后重试。");
        } finally {
            if (!signal.aborted) setBusy(false);
        }
    }
    async function checkOrSubmit(confirmation?: string) {
        const signal = active.current?.signal;
        if (!signal || inFlight.current) return;
        inFlight.current = true;
        setChecking(true);
        setReissueError("");
        setReissue(undefined);
        try {
            const next = await originalSizeReissue(taskId, owner, signal, confirmation);
            if (!signal.aborted) setReissue(next);
        } catch (caught) {
            if (!signal.aborted)
                setReissueError(
                    confirmation && !(caught instanceof ReissueNotSubmitted)
                        ? "未能确认是否受理。请重新查询原单的重出记录，不要另行生成。"
                        : caught instanceof Error
                          ? caught.message
                          : "暂时无法查询重出记录。",
                );
        } finally {
            inFlight.current = false;
            if (!signal.aborted) setChecking(false);
        }
    }
    return (
        <div className="grid gap-1 text-xs">
            {items?.map((item) => (
                <button
                    type="button"
                    key={item.assetId}
                    className="underline"
                    disabled={busy}
                    onClick={() => void download(item)}
                >
                    {uiText("下载已保存原件")}
                    {items.length > 1 ? ` · ${item.resultIndex + 1}` : ""}
                </button>
            ))}
            {items?.length === 0 && <small>{uiText("这笔任务没有可下载的已保存原件。")}</small>}
            {error && <small role="status">{uiText(error)}</small>}
            {error && !items && (
                <button type="button" className="underline" onClick={() => setAttempt((n) => n + 1)}>
                    {uiText("刷新原件列表")}
                </button>
            )}
            {canCheck && (!reissue || "task" in reissue) && (
                <button type="button" className="underline" disabled={checking} onClick={() => void checkOrSubmit()}>
                    {uiText(reissue || reissueError ? "查询重出记录" : "按原图尺寸重出（计费）")}
                </button>
            )}
            {reissue && "quote" in reissue && (
                <div role="group" aria-label={uiText("确认按原图尺寸重出")} className="grid gap-2 rounded border p-2">
                    <p>
                        {uiText("将按原图尺寸生成 1 张，新任务单独计费。")} {reissue.quote.width} × {reissue.quote.height} px ·{" "}
                        {reissue.quote.modelName} · {reissue.quote.credits} {uiText("积分")} · {uiText("预计")} ¥
                        {reissue.quote.estimatedRmb}
                    </p>
                    <div className="flex flex-wrap justify-center gap-2">
                    <button type="button" className="rounded border border-current px-3 py-1.5 font-medium" onClick={() => void checkOrSubmit(reissue.quote.confirmation)}>
                        {uiText("确认重出 1 张")}
                    </button>
                    <button type="button" className="rounded px-3 py-1.5 underline" onClick={() => setReissue(undefined)}>
                        {uiText("取消")}
                    </button>
                    </div>
                </div>
            )}
            {reissue && "task" in reissue && (
                <small role="status">
                    {uiText("独立重出任务")} {reissue.task.id} ·{" "}
                    {uiText(
                        (
                            {
                                waiting: "已排队",
                                processing: "生成中",
                                success: "已完成",
                                failed: "失败",
                                paused: "待核查",
                                cancelled: "已取消",
                            } as Record<string, string>
                        )[reissue.task.status] || "状态待查询",
                    )}{" "}
                    {reissue.task.output && (
                        <a href={reissue.task.output} target="_blank" rel="noreferrer">
                            {uiText("查看重出原图")}
                        </a>
                    )}
                </small>
            )}
            {reissueError && <small role="status">{uiText(reissueError)}</small>}
        </div>
    );
}
