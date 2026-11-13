import { SensitiveDisplayValue, useDisplayUiValue } from "@/hooks/use-display-text";
import { staticUiText } from "@/lib/static-ui-copy";
import { useUiLocale } from "@/lib/i18n";
import { Alert, Button, Modal, Pagination, Spin, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { adminLabel } from "../../admin-labels";
import {
    getUsageTaskDetail,
    getUsageTaskPrompt,
    getUsageTaskThumbnail,
    USAGE_TASK_EVIDENCE_LABELS,
    USAGE_TASK_PARAMETER_LABELS,
    type UsageTaskDetail,
    type UsageTaskPrompt,
    type UsageTaskResult,
} from "@/services/api/usage-task-detail";

const dateText = (value: string | null) =>
    value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "缺失";
const durationText = (value: number | null) => (value === null ? "缺失" : `${(value / 1000).toFixed(1)} 秒`);
function ResultItem({ userId, taskId, item }: { userId: string; taskId: string; item: UsageTaskResult }) {
    const displayUi = useDisplayUiValue();
    useUiLocale();
    const [url, setUrl] = useState("");
    const [busy, setBusy] = useState(false),
        [error, setError] = useState("");
    const controller = useRef<AbortController | null>(null),
        objectUrl = useRef("");
    useEffect(
        () => () => {
            controller.current?.abort();
            if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
        },
        [],
    );
    const load = async (width: 256 | 1024) => {
        if (!item.assetId || controller.current) return;
        const current = new AbortController();
        controller.current = current;
        setBusy(true);
        setError("");
        try {
            const blob = await getUsageTaskThumbnail(userId, taskId, item.assetId, width, current.signal);
            current.signal.throwIfAborted();
            if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
            objectUrl.current = URL.createObjectURL(blob);
            setUrl(objectUrl.current);
        } catch (failure) {
            if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : "缩略图未加载");
        } finally {
            if (controller.current === current) {
                controller.current = null;
                setBusy(false);
            }
        }
    };
    return (
        <article
            className="min-w-0 space-y-2 rounded-lg border border-[var(--border)] p-3"
            data-testid={`usage-task-result-${item.position}`}
        >
            <h4 className="font-medium">{staticUiText("结果项 ")}{item.position} {item.kind === "video" ? staticUiText("· 视频封面") : ""}
            </h4>
            {url ? (
                <img
                    src={url}
                    alt={staticUiText("结果项 {p0} 缩略预览", { p0: `${item.position}` })}
                    className="h-36 w-full rounded object-contain"
                />
            ) : (
                <p className="flex min-h-20 items-center justify-center text-center text-xs text-[var(--muted-foreground)]">
                    {item.assetId ? staticUiText("尚未加载图片") : staticUiText("无可授权关联的内部素材；不读取旧外链")}
                </p>
            )}
            <div className="flex flex-wrap gap-2">
                <Button
                    size="small"
                    disabled={!item.thumbnailAvailable || busy}
                    loading={busy}
                    onClick={() => void load(256)}
                >{staticUiText("加载缩略图")}</Button>
                <Button size="small" disabled={!item.previewAvailable || busy} onClick={() => void load(1024)}>{staticUiText("查看较大预览")}</Button>
            </div>
            {item.assetId && !item.thumbnailAvailable ? (
                <p className="text-xs text-[var(--muted-foreground)]">{staticUiText("缺少 256 缩略图；不改取原图。")}</p>
            ) : null}
            {error ? (
                <p role="alert" className="text-xs leading-5">
                    {displayUi(error)}
                </p>
            ) : null}
            <div className="space-y-1 text-xs leading-5">
                {item.evidence.length ? (
                    item.evidence.map((event) => (
                        <p key={event.eventType}>
                            {USAGE_TASK_EVIDENCE_LABELS[event.eventType]} · {event.count}{staticUiText(" 条")}{event.basis === "client_reported" ? staticUiText("客户端回执") : staticUiText("服务端记录")}{staticUiText("；最近")}{" "}
                            {dateText(event.lastAt)}
                        </p>
                    ))
                ) : (
                    <p className="text-[var(--muted-foreground)]">{staticUiText("未找到本素材的有效结果事件；不推断未使用或已采纳。")}</p>
                )}
            </div>
        </article>
    );
}

/** Mounted only after an explicit task click. Parent keys it to employee/task/scope/page. */
export default function TaskDetail({
    userId,
    taskId,
    onClose,
}: {
    userId: string;
    taskId: string;
    onClose: () => void;
}) {
    const displayUi = useDisplayUiValue();
    useUiLocale();
    const [page, setPage] = useState(1),
        [data, setData] = useState<UsageTaskDetail | null>(null);
    const [busy, setBusy] = useState(true),
        [error, setError] = useState("");
    const [prompt, setPrompt] = useState<UsageTaskPrompt | null>(null),
        [promptBusy, setPromptBusy] = useState(false),
        [promptError, setPromptError] = useState("");
    const promptController = useRef<AbortController | null>(null);
    useEffect(() => {
        const current = new AbortController();
        setBusy(true);
        setError("");
        setData(null);
        void getUsageTaskDetail(userId, taskId, page, current.signal)
            .then((value) => {
                if (!current.signal.aborted) setData(value);
            })
            .catch((failure) => {
                if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : "任务读取失败");
            })
            .finally(() => {
                if (!current.signal.aborted) setBusy(false);
            });
        return () => current.abort();
    }, [userId, taskId, page]);
    useEffect(() => () => promptController.current?.abort(), []);
    const loadPrompt = async () => {
        if (!data || promptController.current) return;
        const current = new AbortController();
        promptController.current = current;
        setPromptBusy(true);
        setPromptError("");
        setPrompt(null);
        try {
            const value = await getUsageTaskPrompt(userId, taskId, current.signal);
            current.signal.throwIfAborted();
            setPrompt(value);
        } catch (failure) {
            if (!current.signal.aborted) setPromptError(failure instanceof Error ? failure.message : "提示词未读取");
        } finally {
            if (promptController.current === current) {
                promptController.current = null;
                setPromptBusy(false);
            }
        }
    };
    return (
        <Modal
            title={staticUiText("单任务详情 · 按需读取")}
            open
            width={{ xs: "96%", sm: "92%", md: "88%", lg: 1100 }}
            onCancel={onClose}
            footer={<Button onClick={onClose}>{staticUiText("关闭任务详情")}</Button>}
        >
            <div className="max-h-[72vh] min-w-0 space-y-4 overflow-y-auto pr-1" data-testid="usage-task-detail">
                <Alert
                    type="info"
                    showIcon
                    title={staticUiText("仅本次点击的任务；图片与原始提示词分别加载")}
                    description={staticUiText("读取会记录审计。仅显示可核对的已有字段；缺失不补造。缩略图每次核对素材、员工与任务关联，不读取原图或旧外链。")}
                />
                {busy ? (
                    <div role="status" className="flex items-center gap-2 py-4">
                        <Spin size="small" />{staticUiText("正在读取此任务…可关闭取消等待。")}</div>
                ) : null}
                {error ? <Alert type="error" title={displayUi(error)} /> : null}
                {data ? (
                    <>
                        <p className="break-all text-xs text-[var(--muted-foreground)]">{staticUiText("任务 ")}{data.taskId}{staticUiText(" · 本次读取 ")}{dateText(data.asOf)}{staticUiText("（北京时间）；与历史日汇总的读取时点可能不同。")}</p>
                        <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                            <p>{staticUiText("状态：")}{adminLabel(data.status)}</p>
                            <p>{staticUiText("操作：")}{adminLabel(data.operationType)}</p>
                            <p>{staticUiText("模型：")}{displayUi(data.modelName || staticUiText("缺失"))}</p>
                            <p>{staticUiText("提交：")}{dateText(data.queuedAt)}</p>
                            <p>{staticUiText("开始：")}{dateText(data.startedAt)}</p>
                            <p>{staticUiText("完成：")}{dateText(data.completedAt)}</p>
                            <p>{staticUiText("队列等待：")}{durationText(data.timing.waitMs)}</p>
                            <p>{staticUiText("Worker 运行段：")}{durationText(data.timing.runMs)}</p>
                            <p>{staticUiText("提交到完成：")}{durationText(data.timing.totalMs)}</p>
                            <p>{staticUiText("已记账金额：")}<strong>{data.bookedCny === null ? staticUiText("缺失") : `¥${data.bookedCny}`}</strong>
                            </p>
                            <p>{staticUiText("提交的参考项数：")}{data.submittedReferenceCount ?? staticUiText("缺失")}</p>
                        </div>
                        <p className="text-xs leading-5 text-[var(--muted-foreground)]">{staticUiText("耗时来自任务时间戳，不是员工工时；Worker 段可能含等待、重试和保存。金额仅为同员工成功生成历史的已记账人民币，不等于供应商实付。参考项按数组长度计数，不推断不同图片数。")}</p>
                        <section className="space-y-2">
                            <h3 className="font-semibold">{staticUiText("可展示参数 ")}<Tag>{staticUiText("安全字段白名单")}</Tag>
                            </h3>
                            <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
                                {Object.entries(USAGE_TASK_PARAMETER_LABELS).map(([key, label]) => (
                                    <p key={key}>
                                        {displayUi(label)}：{data.parameters[key as keyof typeof data.parameters] ?? staticUiText("缺失")}
                                    </p>
                                ))}
                            </div>
                            <p className="text-xs text-[var(--muted-foreground)]">{staticUiText("缺失包含未记录或不符合当前安全格式；不展示任意参数对象、蒙版内容或私有扩展。")}</p>
                        </section>
                        <section className="space-y-3">
                            <h3 className="font-semibold">{staticUiText("保存的结果项 · 本页 ")}{data.results.items.length}{staticUiText(" / 共")}{" "}
                                {data.results.available ? data.results.pagination.total : staticUiText("未知")}{staticUiText(" 项")}</h3>
                            <p className="text-xs leading-5 text-[var(--muted-foreground)]">{staticUiText("按保存结果数组逐项展示，不是去重生成图片数，同图不同版本可能重复。事件仅为本素材当前有效记录；下载 / 导出回执不证明文件落盘、正式采纳或质量。")}</p>
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                {data.results.items.map((item) => (
                                    <ResultItem
                                        key={`${page}:${item.position}`}
                                        userId={userId}
                                        taskId={taskId}
                                        item={item}
                                    />
                                ))}
                            </div>
                            {!data.results.items.length ? (
                                <p className="text-sm text-[var(--muted-foreground)]">{staticUiText("本页没有保存的结果项。")}</p>
                            ) : null}
                            <Pagination
                                current={page}
                                pageSize={12}
                                total={data.results.pagination.total}
                                showSizeChanger={false}
                                onChange={setPage}
                            />
                        </section>
                        <section className="space-y-3 border-t border-[var(--border)] pt-3">
                            <p className="text-xs leading-5">{staticUiText("原始提示词可能包含业务敏感内容；只有点击下面按钮才读取并记录审计，不自动发送给模型或他人。")}</p>
                            <Button
                                aria-label={staticUiText("明确查看此任务原始提示词")}
                                loading={promptBusy}
                                disabled={promptBusy}
                                onClick={() => void loadPrompt()}
                            >{staticUiText("明确查看此任务原始提示词")}</Button>
                            {promptError ? <Alert type="error" title={displayUi(promptError)} /> : null}
                            {prompt ? (
                                <div className="space-y-2" data-testid="usage-task-private-prompt">
                                    <Button size="small" onClick={() => setPrompt(null)}>{staticUiText("隐藏已读取提示词")}</Button>
                                    {prompt.truncated ? (
                                        <Alert type="warning" title={staticUiText("长文本仅展示前 32,000 字符；不是完整原文。")} />
                                    ) : null}
                                    <h4 className="text-sm font-medium">{staticUiText("任务保存的提交提示词（可能已优化）")}</h4>
                                    <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words text-xs leading-6">
                                        <SensitiveDisplayValue value={prompt.prompt || staticUiText("未保存文本")} />
                                    </pre>
                                    <h4 className="text-sm font-medium">{staticUiText("保存的原始用户文本（userText）")}</h4>
                                    <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words text-xs leading-6">
                                        <SensitiveDisplayValue value={prompt.userInput === null
                                            ? staticUiText("缺失，未从其他字段推断")
                                            : prompt.userInput || staticUiText("保存为空文本")} />
                                    </pre>
                                </div>
                            ) : null}
                        </section>
                    </>
                ) : null}
            </div>
        </Modal>
    );
}
