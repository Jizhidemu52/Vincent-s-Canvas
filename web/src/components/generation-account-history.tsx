import { useCallback, useEffect, useRef, useState } from "react";
import { RemovableHistoryList } from "./removable-history-list";
import { historyTaskRemovable } from "../../../shared/history-removal";
import { Button, Modal, Tooltip } from "antd";
import { Check, Copy, Download, History, LoaderCircle, RefreshCw } from "lucide-react";
import { useUserStore } from "@/stores/use-user-store";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { DisplayText, useDisplayText, useDisplayValue } from "@/hooks/use-display-text";
import { useUiText } from "@/lib/i18n";
import { useWorkbenchTask } from "./workbench-tasks";
import { formatBeijingDateTime } from "@/lib/beijing-time";
import { deploymentFeatures } from "@/lib/deployment-features";
import { omitFinancialFields } from "@/lib/financial-presentation";
import { listGenerationHistory, readHistoryOriginal, historyAssetPath, type GenerationHistoryTask } from "@/services/api/generation-task-history";
import { listLocalProcessing, localProcessingBoard } from "@/services/api/local-processing";
import type { LocalProcessingRecord } from "../../../shared/local-processing-contracts";

const statusLabels: Record<string, string> = { waiting: "排队中", queued: "排队中", processing: "处理中", paused: "未完成", success: "已完成", failed: "失败", cancelled: "已取消" };
const titleOf = (task: GenerationHistoryTask) => task.userInput?.userText || task.prompt || "图片处理任务";

function OriginalPreview({ path, ownerId }: { path: string; ownerId: string }) {
    const t = useUiText();
    const [media, setMedia] = useState<{ url: string; type: string } | null>(null);
    const [error, setError] = useState("");
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        const controller = new AbortController(); let objectUrl = "";
        setMedia(null); setError("");
        void readHistoryOriginal(path, ownerId, controller.signal).then(blob => {
            controller.signal.throwIfAborted();
            objectUrl = URL.createObjectURL(blob); setMedia({ url: objectUrl, type: blob.type });
        }).catch(caught => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "原件暂时无法读取"); });
        return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
    }, [path, ownerId, attempt]);
    if (error) return <div role="alert" className="space-y-2 text-sm text-muted-foreground"><p><DisplayText text={t(error)} /></p>{historyAssetPath(path) && <Button onClick={() => setAttempt(value => value + 1)}>{t("重试读取原件")}</Button>}</div>;
    if (!media) return <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={16} className="animate-spin" />{t("正在读取所选原件…")}</p>;
    const extension = media.type === "image/png" ? "png" : media.type === "image/jpeg" ? "jpg" : media.type === "image/webp" ? "webp" : media.type === "video/mp4" ? "mp4" : "bin";
    return <div className="space-y-3">
        {media.type.startsWith("image/") ? <img src={media.url} alt={t("账号历史原件")} className="max-h-[55vh] w-full rounded-lg bg-muted object-contain" />
            : media.type.startsWith("video/") ? <video controls preload="metadata" src={media.url} className="max-h-[55vh] w-full rounded-lg bg-muted"><track kind="captions" /></video>
                : <p className="text-sm text-muted-foreground">{t("浏览器不支持此原件预览，可下载原文件。")}</p>}
        <a className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm text-primary hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary" href={media.url} download={`history-${path.split("/")[3]}.${extension}`}><Download size={16} />{t("下载原件")}</a>
    </div>;
}

function HistoryDetail({ task, ownerId, board }: { task: GenerationHistoryTask; ownerId: string; board: string }) {
    const t = useUiText();
    const display = useDisplayText();
    const displayValue = useDisplayValue();
    const sources = Array.isArray(task.sourceUrls) ? task.sourceUrls : [];
    const results = Array.isArray(task.resultUrls) ? task.resultUrls : [];
    const files = [...results.map((path, index) => ({ path, label: t("结果 {index}", { index: index + 1 }) })), ...sources.map((path, index) => ({ path, label: t("参考原图 {index}", { index: index + 1 }) }))];
    const [selected, setSelected] = useState(0);
    const [detailOpen, setDetailOpen] = useState(false);
    const { copy, copied } = useCopyFeedback();
    const hideModel = board === "layer-studio";
    // Display only: the layer workspace stays provider-neutral, including archives.
    const originalDetailJson = JSON.stringify(omitFinancialFields({ taskId: task.id, requestId: task.requestId, userInput: task.userInput, parameters: task.parameters, resultDocument: task.resultDocument }),
        (key, value) => hideModel && /model|provider/i.test(key) ? undefined : value, 2);
    const detailJson = detailOpen ? JSON.stringify(displayValue(JSON.parse(originalDetailJson)), null, 2) : originalDetailJson;
    return <div className="space-y-4" data-testid="account-history-detail">
        <p className="text-sm text-muted-foreground">{t("查看记录不会重新生成，也不会替换当前草稿。这里是原 AI 任务；精确换色与选区合成的最终成果会以独立处理记录保存。未提交的图层编辑不属于云端原件。")}</p>
        <div className="flex flex-wrap items-center gap-3 text-sm"><span>{t(statusLabels[task.status] || task.status)}</span>{!hideModel && <span>{task.modelName ? display(task.modelName) : task.modelId || t("历史模型")}</span>}<time>{formatBeijingDateTime(task.queuedAt || task.createdAt || "")}{t(" 北京时间")}</time></div>
        {files.length > 0 ? <><div className="flex flex-wrap gap-2" role="group" aria-label={t("历史原件选择")}>{files.map((file, index) => <Button key={`${file.label}:${file.path}`} aria-pressed={selected === index} className={selected === index ? "!bg-muted !font-semibold !text-foreground" : undefined} onClick={() => setSelected(index)}>{file.label}</Button>)}</div><OriginalPreview key={files[selected].path} path={files[selected].path} ownerId={ownerId} /></>
            : <p className="rounded-lg bg-muted p-4 text-sm text-muted-foreground">{t("此任务尚无已保存结果。只展示原状态，不会自动恢复查询或重新提交。")}</p>}
        <section className="space-y-2"><div className="flex items-center justify-between gap-2"><h3 className="text-base font-medium">{t("完整提示词")}</h3><Button size="small" icon={copied ? <Check size={14} /> : <Copy size={14} />} disabled={!task.prompt} onClick={() => void copy(task.prompt || "")}>{t(copied ? "已复制" : "复制提示词")}</Button></div><p className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-sm">{task.prompt ? <DisplayText text={task.prompt} /> : t("此处理任务没有提示词")}</p></section>
        <details className="text-sm" onToggle={event => setDetailOpen(event.currentTarget.open)}><summary className="cursor-pointer rounded-md py-2 focus-visible:outline-2 focus-visible:outline-primary">{t("查看输入、参数和任务编号")}</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{detailJson}</pre></details>
        {task.failureReason && <p className="text-sm text-muted-foreground">{t("原任务说明：")}{hideModel ? t("任务执行或结果保存存在异常，原记录与已保存原件保留。") : <DisplayText text={t(task.failureReason)} />}</p>}
    </div>;
}

function LocalProcessingDetail({ record, ownerId }: { record: LocalProcessingRecord; ownerId: string }) {
    const t = useUiText();
    const displayValue = useDisplayValue();
    const { copy, copied } = useCopyFeedback();
    const [selected, setSelected] = useState(0);
    const files = [{ path: record.contentUrl, label: t("最终成果") }, ...record.sourceAssetIds.map((id, index) => ({ path: `/api/assets/${id}/content`, label: t("来源原件 {index}", { index: index + 1 }) }))];
    return <div className="space-y-4" data-testid="account-local-processing-detail">
        <p className="text-sm text-muted-foreground">{t("已保存最终图片与完整处理参数，换浏览器或电脑仍可查看。此处仅查看和下载，不会重新生成、扣费或覆盖原 AI 任务。")}</p>
        <div className="flex flex-wrap items-center gap-3 text-sm"><span>{t(record.operation === "recolor" ? "精确换色 · 本地处理已归档" : "选区合成 · 最终成果已归档")}</span><time>{formatBeijingDateTime(record.createdAt)}{t(" 北京时间")}</time></div>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t("处理原件选择")}>{files.map((file, index) => <Button key={file.path} aria-pressed={selected === index} onClick={() => setSelected(index)}>{file.label}</Button>)}</div>
        <OriginalPreview key={files[selected].path} path={files[selected].path} ownerId={ownerId} />
        <section className="space-y-2"><div className="flex items-center justify-between gap-2"><h3 className="text-base font-medium">{t("完整处理要求")}</h3><Button size="small" icon={copied ? <Check size={14} /> : <Copy size={14} />} onClick={() => void copy(record.prompt)}>{t(copied ? "已复制" : "复制提示词")}</Button></div><p className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-sm"><DisplayText text={record.prompt} /></p></section>
        <details className="text-sm"><summary className="cursor-pointer rounded-md py-2 focus-visible:outline-2 focus-visible:outline-primary">{t("查看处理参数与关联原任务")}</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{JSON.stringify(displayValue({ operation: record.operation, parameters: record.parameters, sourceAssetIds: record.sourceAssetIds, sourceTaskId: record.sourceTaskId, clientOperationId: record.clientOperationId, outputAssetId: record.outputAssetId }), null, 2)}</pre></details>
    </div>;
}

type HistorySelection = { kind: "task"; task: GenerationHistoryTask } | { kind: "local"; record: LocalProcessingRecord };

function AccountHistoryList({ board, ownerId, active, onChange }: { board: string; ownerId: string; active: boolean; onChange?:()=>void }) {
    const t = useUiText();
    const display = useDisplayText();
    const [tasks, setTasks] = useState<GenerationHistoryTask[]>([]);
    const [records, setRecords] = useState<LocalProcessingRecord[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [localCursor, setLocalCursor] = useState<string | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [selected, setSelected] = useState<HistorySelection | null>(null);
    const controller = useRef<AbortController | null>(null);
    const lastRequestedCursor = useRef<{ task: string | null; local: string | null } | undefined>(undefined);
    const load = useCallback(async (next?: { task: string | null; local: string | null }) => {
        lastRequestedCursor.current = next;
        controller.current?.abort(); const current = new AbortController(); controller.current = current;
        setLoading(true); setError("");
        try {
            const localBoard = localProcessingBoard(board);
            const [page, local] = await Promise.all([
                !next || next.task ? listGenerationHistory(board, ownerId, next?.task || undefined, current.signal) : null,
                localBoard && (!next || next.local) ? listLocalProcessing(localBoard, ownerId, { cursor: next?.local || undefined, signal: current.signal }) : null,
            ]);
            current.signal.throwIfAborted();
            if (page) { setTasks(previous => next ? [...new Map([...previous, ...page.tasks].map(task => [task.id, task])).values()] : page.tasks); setCursor(page.nextCursor); }
            if (local) { setRecords(previous => next ? [...new Map([...previous, ...local.records].map(record => [record.id, record])).values()] : local.records); setLocalCursor(local.nextCursor); }
            setLoaded(true);
        } catch (caught) { if (!current.signal.aborted) setError(caught instanceof Error ? caught.message : "账号历史暂时读取失败"); }
        finally { if (!current.signal.aborted) setLoading(false); }
    }, [board, ownerId]);
    useEffect(() => {
        if (active) void load();
        else { controller.current?.abort(); setLoading(false); setSelected(null); }
        return () => controller.current?.abort();
    }, [active, load]);
    if (!active) return null;
    const entries = [...tasks.map(task => ({ kind: "task" as const, task, id: `task:${task.id}`, date: task.queuedAt || task.createdAt || "" })),
        ...records.map(record => ({ kind: "local" as const, record, id: `local:${record.id}`, date: record.createdAt }))].sort((left, right) => Date.parse(right.date) - Date.parse(left.date) || left.id.localeCompare(right.id));
    return <section className="mb-6 space-y-3" aria-label={t("账号云端历史")} data-testid="account-history">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-base font-semibold"><History size={16} />{t("账号云端历史")}</h2><Tooltip title={t(loading ? "正在读取账号历史" : "重新读取本账号的已提交记录")}><Button size="small" icon={<RefreshCw size={14} />} disabled={loading} onClick={() => void load()}>{t("刷新记录")}</Button></Tooltip></div>
        <p className="text-sm leading-relaxed text-muted-foreground">{t("本账号在此板块提交的任务与已归档的处理成果，换浏览器或电脑仍可查看。原浏览器中的旧记录继续保留，不会合并删除或覆盖。")}</p>
        <RemovableHistoryList ownerId={ownerId} disabled={loading} onRemoved={async items=>{
            const removed=new Set(items.map(r=>r.kind+":"+r.id));
            setTasks(old=>old.filter(r=>!removed.has("task:"+r.id)));setRecords(old=>old.filter(r=>!removed.has("local:"+r.id)));
            setSelected(null);onChange?.();await load();
        }} rows={entries.map(entry => { const title = entry.kind === "task" ? titleOf(entry.task) : entry.record.prompt; return {kind:entry.kind,id:entry.kind==="task"?entry.task.id:entry.record.id,title:display(t(title)).slice(0,80),disabled:entry.kind==="task"&&!historyTaskRemovable(entry.task.status,entry.task.resultDocument?.status),content:<button type="button" onClick={() => setSelected(entry)} className="flex w-full min-w-0 items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary" aria-label={t("查看云端记录：{title}", { title: display(t(title)).slice(0, 80) })}>
            <History size={18} className="shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{display(t(title))}</span><span className="mt-1 block text-xs text-muted-foreground">{formatBeijingDateTime(entry.date)} · {entry.kind === "task" ? <>{t(statusLabels[entry.task.status] || entry.task.status)} · {entry.task.resultUrls?.length || 0}{t(" 份结果")}</> : t(entry.record.operation === "recolor" ? "精确换色 · 最终成果已归档" : "选区合成 · 最终成果已归档")}</span></span><span className="shrink-0 text-xs text-primary">{t("查看")}</span>
        </button>}; })}/>
        {loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={16} className="animate-spin" />{t("正在读取账号历史…")}</p>}
        {error && <div role="alert" className="space-y-2 text-sm text-destructive"><p><DisplayText text={t(error)} /></p><Button size="small" onClick={() => void load(lastRequestedCursor.current)}>{t("重试读取历史")}</Button></div>}
        {loaded && !entries.length && !error && <p className="rounded-lg bg-muted p-4 text-sm text-muted-foreground">{t("此账号在本板块还没有可归类的云端任务或处理成果。仅存本机的旧记录仍在原浏览器保留。")}</p>}
        {(cursor || localCursor) && !error && <Button disabled={loading} onClick={() => void load({ task: cursor, local: localCursor })}>{t("加载更多云端记录")}</Button>}
        <Modal title={t(selected?.kind === "local" ? "云端处理成果详情" : "云端任务详情")} open={Boolean(selected)} onCancel={() => setSelected(null)} footer={null} width={960} destroyOnHidden>{selected?.kind === "task" ? <HistoryDetail key={selected.task.id} task={selected.task} ownerId={ownerId} board={board} /> : selected ? <LocalProcessingDetail key={selected.record.id} record={selected.record} ownerId={ownerId} /> : null}</Modal>
    </section>;
}

export function GenerationAccountHistory({ board, active = true, onChange }: { board: string; active?: boolean; onChange?:()=>void }) {
    const ownerId = useUserStore(state => state.user?.id);
    const status = useUserStore(state => state.status);
    const pane = useWorkbenchTask();
    return ownerId && (!deploymentFeatures.authenticationEnabled || status === "authenticated") ? <AccountHistoryList key={`${ownerId}:${board}`} board={board} ownerId={ownerId} active={active && pane.active} onChange={onChange} /> : null;
}
