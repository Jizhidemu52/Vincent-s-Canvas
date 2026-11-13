import { staticUiText } from "@/lib/static-ui-copy";
import { useUiLocale } from "@/lib/i18n";
import { Alert, Button, Progress, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { getUsageRollupJob, recomputeUsageRollups, type UsageRollupJob } from "@/services/api/usage-analytics-v2";
import { UsageAnalyticsError } from "@/services/api/usage-analytics";
import { createClientUuid } from "@/lib/client-uuid";
import { beijingDay, type UsageFilterForm } from "./filters";
import { abortableRollupDelay, comparisonDayRange, readRollupAttempt, rollupRangeError, rollupTerminal, saveRollupAttempt, type DayRange, type RollupAttempt } from "./rollup-state";

export default function RollupActions({ actorId, filters, disabled, refreshRequired, onComplete, onLegacy }: { actorId: string; filters: UsageFilterForm; disabled: boolean; refreshRequired: boolean; onComplete: () => void; onLegacy: () => void }) {
    useUiLocale();
    const [attempt, setAttempt] = useState<RollupAttempt | null>(() => readRollupAttempt(actorId));
    const [waiting, setWaiting] = useState(false),
        [problem, setProblem] = useState(""),
        [storageProblem, setStorageProblem] = useState("");
    const current = useRef(attempt),
        controller = useRef<AbortController | null>(null),
        revision = useRef(0),
        active = useRef(false),
        completedJob = useRef("");
    const finish = useRef(onComplete);
    finish.current = onComplete;
    const selected = { fromDay: filters.from, toDay: filters.to },
        selectedError = rollupRangeError(selected);
    let comparison: DayRange | null = null;
    try {
        comparison = comparisonDayRange(filters);
    } catch {
        /* invalid filter is already explained */
    }
    const comparisonError = comparison ? rollupRangeError(comparison) : "";
    const unresolved = Boolean(attempt && !attempt.rejected && !rollupTerminal(attempt.job));
    useEffect(
        () => () => {
            revision.current++;
            active.current = false;
            controller.current?.abort();
        },
        [],
    );
    const save = (value: RollupAttempt) => {
        current.current = value;
        setAttempt(value);
        setStorageProblem(saveRollupAttempt(actorId, value) ? "" : "浏览器无法保存本次刷新标识。请保持本页打开，使用下方同一次回执查询，不要重复创建任务。");
    };
    const run = async (value: RollupAttempt) => {
        if (active.current) return;
        active.current = true;
        const version = ++revision.current,
            abort = new AbortController();
        controller.current?.abort();
        controller.current = abort;
        setWaiting(true);
        setProblem("");
        let latest = value;
        const deadline = Date.now() + 120000;
        const timeout = setTimeout(() => abort.abort(), 120000);
        const accept = (job: UsageRollupJob) => {
            if (abort.signal.aborted || revision.current !== version) return false;
            if (job.fromDay !== value.request.fromDay || job.toDay !== value.request.toDay || (latest.job && latest.job.jobId !== job.jobId)) throw new UsageAnalyticsError("刷新回执与本次任务不匹配，请查询同一回执。", "INVALID_RESPONSE");
            latest = { ...value, job, rejected: false };
            save(latest);
            if (job.status === "completed" && completedJob.current !== job.jobId) {
                completedJob.current = job.jobId;
                finish.current();
            }
            return rollupTerminal(job);
        };
        try {
            const first = latest.job ? await getUsageRollupJob(latest.job.jobId, abort.signal) : await recomputeUsageRollups(latest.request, abort.signal);
            if (accept(first)) return;
            for (let step = 0; Date.now() < deadline; step++) {
                await abortableRollupDelay(Math.min(1000 * 2 ** Math.min(step, 4), 10000), abort.signal);
                const job = await getUsageRollupJob(first.jobId, abort.signal);
                if (accept(job)) return;
            }
            setProblem("本机等待已到 2 分钟，后台任务可能仍在处理。请继续查询同一任务，不会新建刷新任务。");
        } catch (failure) {
            if (revision.current !== version) return;
            if (failure instanceof Error && failure.name === "AbortError") {
                setProblem("本机等待已停止，不能据此判断后台是否完成。请查询同一任务或找回同一次回执。");
            } else {
                const notEnabled = !latest.job && failure instanceof UsageAnalyticsError && failure.status === 503 && failure.code === "USAGE_ROLLUP_NOT_ENABLED";
                const rejected = notEnabled || (!latest.job && failure instanceof UsageAnalyticsError && failure.status !== undefined && [400, 401, 403, 404, 409, 422].includes(failure.status));
                if (rejected) save({ ...latest, rejected: true });
                setProblem(
                    `${failure instanceof Error ? failure.message : "刷新状态读取失败。"}${notEnabled ? "" : rejected ? " 本次请求被拒绝，可核对日期后明确发起新刷新。" : latest.job ? " 后台任务不会因此自动重启；请继续查询同一任务。" : " 尚未获得可靠回执；找回时会复用原日期与 idempotencyKey，不创建新的逻辑请求。"}`,
                );
            }
        } finally {
            clearTimeout(timeout);
            if (revision.current === version) {
                active.current = false;
                setWaiting(false);
            }
        }
    };
    const start = (range: DayRange) => {
        if (active.current || disabled || (current.current && !current.current.rejected && !rollupTerminal(current.current.job))) return;
        const invalid = rollupRangeError(range);
        if (invalid) {
            setProblem(invalid);
            return;
        }
        try {
            const next: RollupAttempt = { request: { ...range, idempotencyKey: createClientUuid() }, job: null, rejected: false };
            save(next);
            void run(next);
        } catch {
            setProblem("浏览器缺少安全随机数能力，未提交刷新任务。请使用支持安全随机数的浏览器后重试。");
        }
    };
    const pause = () => {
        revision.current++;
        active.current = false;
        controller.current?.abort();
        setWaiting(false);
        setProblem("已暂停本机等待，未取消后台任务。保留本次标识，可查询同一任务或找回同一次回执。");
    };
    const job = attempt?.job,
        total = attempt ? (Date.parse(attempt.request.toDay) - Date.parse(attempt.request.fromDay)) / 86400000 + 1 : 0;
    const blocked = disabled || waiting || unresolved;
    return (
        <section className="wb-surface space-y-3 p-4 text-sm" aria-label={staticUiText("日事实刷新")} data-testid="usage-rollup-actions">
            <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">{staticUiText("日事实刷新")}</h3>
                <Tag>{staticUiText("只重算已有记录 · 不调用模型")}</Tag>
            </div>
            <p className="text-xs leading-5 text-[var(--muted-foreground)]">{staticUiText("与“刷新读取”不同：这里会提交后台重算任务，覆盖指定北京时间日期的日事实（不按人员或板块过滤）。202 / 排队回执不是完成，不修改业务任务或账本。")}</p>
            {refreshRequired ? (
                <Alert type="warning" showIcon title={staticUiText("当前缺少可用日事实，需先重算")} description={staticUiText("本期和对比期都可能需要刷新。每次最多 31 天；可缩短顶部日期、分别刷新本期/对比期，或暂时用独立筛选的旧版实时分析核查。读取不会自动回填。")} />
            ) : null}
            <div className="flex flex-wrap gap-2">
                <Button
                    disabled={blocked}
                    onClick={() => {
                        const today = beijingDay(new Date());
                        start({ fromDay: today, toDay: today });
                    }}
                >{staticUiText("刷新今天")}</Button>
                <Button disabled={blocked || Boolean(selectedError)} onClick={() => start(selected)}>{staticUiText("刷新所选日期")}</Button>
                {comparison ? (
                    <Button disabled={blocked || Boolean(comparisonError)} onClick={() => start(comparison!)}>{staticUiText("刷新对比日期")}</Button>
                ) : null}
                {refreshRequired ? (
                    <Button disabled={waiting} onClick={onLegacy}>{staticUiText("打开旧版实时分析")}</Button>
                ) : null}
            </div>
            <p className="text-xs">{staticUiText("所选：")}{selected.fromDay}{staticUiText(" 至 ")}{selected.toDay}
                {comparison ? staticUiText("；对比：{p0} 至 {p1}", { p0: `${comparison.fromDay}`, p1: `${comparison.toDay}` }) : ""}。{selectedError || comparisonError}
            </p>
            {attempt ? (
                <div className="space-y-2 rounded border border-[var(--border)] p-3" aria-live="polite">
                    <p>{staticUiText("本次刷新：")}{attempt.request.fromDay}{staticUiText(" 至 ")}{attempt.request.toDay} ·{" "}
                        {job
                            ? staticUiText({ queued: "已排队，尚未完成", running: "正在重算，尚未全部完成", completed: "全部日期重算完成", failed: "刷新失败，未自动重新启动" }[job.status])
                            : attempt.rejected
                              ? staticUiText("请求被拒绝")
                              : waiting
                                ? staticUiText("正在提交或找回回执")
                                : staticUiText("回执待确认")}
                    </p>
                    {job ? (
                        <>
                            <Progress percent={Math.floor((job.completedDays.length / total) * 100)} status={job.status === "failed" ? "exception" : job.status === "completed" ? "success" : "active"} />
                            <p className="text-xs">{staticUiText("真实已提交 ")}{job.completedDays.length} / {total}{staticUiText(" 天：")}{job.completedDays.join("、") || staticUiText("尚无")}。{job.status === "failed" ? staticUiText("失败代码：{p0}；已提交日期不会回滚。只有再次点击刷新才创建新任务。", { p0: `${job.failureCode || staticUiText("未提供")}` }) : ""}
                            </p>
                        </>
                    ) : null}
                    <details className="text-xs">
                        <summary className="cursor-pointer">{staticUiText("刷新标识与状态恢复")}</summary>
                        <p className="mt-2 break-all">
                            idempotencyKey：{attempt.request.idempotencyKey}
                            {job ? `；jobId：${job.jobId}` : ""}
                        </p>
                        <p>{staticUiText("在当前标签页按管理员身份保存，重新打开页面不会自动提交。原日期与标识固定；切换筛选不改变已有任务。")}</p>
                    </details>
                    {waiting ? (
                        <Button size="small" onClick={pause}>{staticUiText("暂停本机等待")}</Button>
                    ) : unresolved ? (
                        <Button
                            size="small"
                            onClick={() => {
                                if (current.current) void run(current.current);
                            }}
                        >
                            {job ? staticUiText("继续查询同一任务") : staticUiText("找回本次刷新回执")}
                        </Button>
                    ) : null}
                </div>
            ) : null}
            {problem ? <Alert type="warning" showIcon title={problem} /> : null}
            {storageProblem ? <Alert type="warning" showIcon title={storageProblem} /> : null}
        </section>
    );
}
