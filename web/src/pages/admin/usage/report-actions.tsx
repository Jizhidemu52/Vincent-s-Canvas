import { useDisplayUiValue, useDisplayConfig, useDisplayValue } from "@/hooks/use-display-text";
import { staticUiText } from "@/lib/static-ui-copy";
import { useUiLocale } from "@/lib/i18n";
import { Alert, Button, Modal, Select, Spin, Tabs, Tag } from "antd";
import { saveAs } from "file-saver";
import { Download, FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    generateUsageV2Report,
    usageV2ReportPeriodError,
    type UsageV2Query,
    type UsageV2ReportPage,
    type UsageV2ReportPeriod,
    type UsageV2ReportResult,
} from "@/services/api/usage-analytics-v2";
import { beijingDay } from "./filters";
import AnalysisActionsV2 from "./analysis-actions-v2";

/** The validated v2 report contains only server-projected anonymous aggregates.
 * Opt-in display may translate its prose and table labels, never technical
 * identifiers, state values, numbers or the downloadable source string. */
export function displayUsageReportJson(value: unknown, translate: (text: string) => string, displayHuman: (value: unknown) => unknown): unknown {
    const displayed = displayHuman(value);
    if (!value || typeof value !== "object" || Array.isArray(value) || !displayed || typeof displayed !== "object" || Array.isArray(displayed)) return displayed;
    const source = value as Record<string, unknown>, result = displayed as Record<string, unknown>;
    if (source.schemaVersion !== 2 || source.reportVersion !== "usage-report-v2.1") return displayed;
    const human = (item: unknown) => typeof item === "string" && /[\u3400-\u9fff]/.test(item) ? translate(item) : item;
    return { ...result,
        ...(typeof source.instructions === "string" ? { instructions: human(source.instructions) } : {}),
        ...(Array.isArray(source.warnings) ? { warnings: source.warnings.map(human) } : {}),
        ...(Array.isArray(result.tables) ? { tables: result.tables.map(table => {
            if (!table || typeof table !== "object" || Array.isArray(table)) return table;
            const row = table as Record<string, unknown>;
            return { ...row,
                ...(Array.isArray(row.columns) ? { columns: row.columns.map(human) } : {}),
                ...(Array.isArray(row.rows) ? { rows: row.rows.map(cells => Array.isArray(cells) ? cells.map(human) : cells) } : {}),
            };
        }) } : {}),
    };
}

/** A scope-keyed, explicit server read. No model, background generation, storage or automatic retry. */
export default function ReportActions({
    page,
    query,
    disabled,
    reason,
    scopeText,
}: {
    page: UsageV2ReportPage;
    query: UsageV2Query | null;
    disabled: boolean;
    reason?: string;
    scopeText: string;
}) {
    const displayUi = useDisplayUiValue();
    const displayConfig = useDisplayConfig();
    const displayJson = useDisplayValue();
    const locale = useUiLocale();
    const [period, setPeriod] = useState<UsageV2ReportPeriod>("selected");
    const [report, setReport] = useState<UsageV2ReportResult | null>(null);
    const [reportTab, setReportTab] = useState("markdown");
    const [translationApproval, setTranslationApproval] = useState<{ report: UsageV2ReportResult; tabs: string[] } | null>(null);
    const [open, setOpen] = useState(false),
        [busy, setBusy] = useState(false),
        [error, setError] = useState(""),
        [notice, setNotice] = useState("");
    const translateReport = open && locale === "en-US" && translationApproval?.report === report && translationApproval.tabs.includes(reportTab);
    const controller = useRef<AbortController | null>(null);
    useEffect(() => () => controller.current?.abort(), []);
    const weekError = usageV2ReportPeriodError("week", query?.from, query?.to),
        monthError = usageV2ReportPeriodError("month", query?.from, query?.to);
    const periodError = usageV2ReportPeriodError(period, query?.from, query?.to);
    const generate = async () => {
        if (disabled || controller.current || !query?.from || !query.to || periodError) return;
        const current = new AbortController();
        controller.current = current;
        setBusy(true);
        setError("");
        setNotice("");
        setReport(null);
        setReportTab("markdown");
        try {
            const next = await generateUsageV2Report(
                { page, period, filters: { ...query, from: query.from, to: query.to } },
                current.signal,
            );
            current.signal.throwIfAborted();
            setReport(next);
            setOpen(true);
        } catch (failure) {
            if (!current.signal.aborted)
                setError(failure instanceof Error ? failure.message : "报告生成未完成，请手动重试。");
        } finally {
            if (controller.current === current) {
                controller.current = null;
                setBusy(false);
            }
        }
    };
    const download = (format: "md" | "json") => {
        if (!report || disabled) return;
        try {
            const from = beijingDay(new Date(report.scope.from)),
                to = beijingDay(new Date(Date.parse(report.scope.to) - 1));
            saveAs(
                new Blob([format === "md" ? report.markdown : report.content], {
                    type: format === "md" ? "text/markdown;charset=utf-8" : "application/json;charset=utf-8",
                }),
                `免费统计报告-${report.page}-${report.period}-${from}-${to}.${format}`,
            );
            setNotice("已交给浏览器保存；仅下载本机，不自动分享或发送给模型。");
        } catch {
            setError("浏览器未能保存报告，请检查下载权限后重试。不会重新读取或调用模型。");
        }
    };
    return (
        <>
            <section className="wb-surface space-y-3 p-4 sm:p-5" aria-label={staticUiText("免费统计报告")}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h3 className="flex items-center gap-2 font-semibold">
                            <FileText size={17} />{staticUiText("免费统计报告")}<Tag>{staticUiText("不调用模型")}</Tag>
                        </h3>
                        <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">{staticUiText("服务端按已应用筛选重新取数，生成固定模板与依据表。仅匿名聚合，不含姓名、原始提示词或图片；与原手动 AI 分析独立。")}</p>
                    </div>
                    <div className="flex max-w-full flex-wrap items-center gap-2">
                        <Select
                            aria-label={staticUiText("免费统计报告模板")}
                            value={period}
                            disabled={disabled || busy || !query}
                            style={{ width: 180, maxWidth: "100%" }}
                            options={displayConfig([
                                { value: "selected", label: staticUiText("区间报告 · 当前日期") },
                                { value: "week", label: staticUiText("周报 · 完整自然周"), disabled: Boolean(weekError) },
                                { value: "month", label: staticUiText("月报 · 完整自然月"), disabled: Boolean(monthError) },
                            ], "options")}
                            onChange={(value) => {
                                setPeriod(value);
                                setReport(null);
                                setReportTab("markdown");
                                setError("");
                                setNotice("");
                            }}
                        />
                        <Button
                            aria-label={staticUiText("生成免费统计报告")}
                            aria-busy={busy}
                            disabled={disabled || !query || Boolean(periodError) || busy}
                            loading={busy}
                            onClick={() => void generate()}
                        >{staticUiText("生成免费统计报告")}</Button>
                        {report ? (
                            <Button disabled={disabled} onClick={() => setOpen(true)}>{staticUiText("打开报告预览")}</Button>
                        ) : null}
                    </div>
                </div>
                <p className="text-xs leading-5">{scopeText}</p>
                <p className="text-xs leading-5 text-[var(--muted-foreground)]">{staticUiText("周报需周一至周日，月报需月初至月末；不符合时请用区间报告。模板不会调整日期。更改筛选、页签或刷新读取后会清空预览。")}</p>
                {reason ? <Alert type="info" title={displayUi(reason)} /> : null}
                {busy ? (
                    <div role="status" className="flex items-center gap-2 text-sm">
                        <Spin size="small" />{staticUiText("正在按本次筛选生成免费报告…")}<Button
                            size="small"
                            onClick={() => {
                                controller.current?.abort();
                                setNotice("已取消等待，未自动重试。不会调用模型。");
                            }}
                        >{staticUiText("取消报告等待")}</Button>
                    </div>
                ) : null}
                {error ? <Alert type="error" showIcon title={displayUi(error)} /> : null}
                {notice ? <Alert type="info" title={notice} /> : null}
                <Modal
                    title={staticUiText("免费统计报告预览")}
                    open={open && Boolean(report)}
                    width={{ xs: "96%", sm: "92%", md: "88%", lg: 1100 }}
                    onCancel={() => setOpen(false)}
                    footer={
                        <div className="flex flex-wrap justify-end gap-2">
                            <Button onClick={() => setOpen(false)}>{staticUiText("关闭预览")}</Button>
                            <Button
                                icon={<Download size={14} />}
                                disabled={!report || disabled}
                                onClick={() => download("md")}
                            >{staticUiText("下载 Markdown")}</Button>
                            <Button
                                icon={<Download size={14} />}
                                disabled={!report || disabled}
                                onClick={() => download("json")}
                            >{staticUiText("下载 JSON")}</Button>
                        </div>
                    }
                >
                    {report ? (
                        <>
                            <Alert
                                type="info"
                                showIcon
                                title={staticUiText("免费固定模板 · 不调用模型")}
                                description={staticUiText("这是服务端本次重新读取的报告，筛选与看板一致，但读取时点可能不同。文件仅保存本机；不要把结果使用、记账金额或观察差异当作正式采纳、实付或因果。")}
                            />
                            <div className="my-3 flex flex-wrap gap-2">
                                <Tag>{report.estimatedCharacters}{staticUiText(" 字符")}</Tag>
                                <Tag>{report.metricVersion || staticUiText("指标版本不可用")}</Tag>
                                <Tag>{staticUiText("匿名聚合")}</Tag>
                            </div>
                            {locale === "en-US" ? <p className="mb-3 text-xs text-muted-foreground">
                                Report generation does not use a model. Optional English translation uses the configured text model. Downloads keep the original report.
                                {!translateReport ? <button type="button" className="ml-2 underline" onClick={() => setTranslationApproval({ report, tabs: [...(translationApproval?.report === report ? translationApproval.tabs : []), reportTab] })}>Translate this preview into English</button> : null}
                            </p> : null}
                            <Tabs
                                activeKey={reportTab}
                                onChange={setReportTab}
                                items={[
                                    {
                                        key: "markdown",
                                        label: staticUiText("报告与依据表"),
                                        children: (
                                            <div
                                                className="max-h-[58vh] min-w-0 space-y-3 overflow-auto text-sm leading-7"
                                                data-testid="usage-v2-free-report-preview"
                                            >
                                                <ReactMarkdown
                                                    skipHtml
                                                    remarkPlugins={[remarkGfm]}
                                                    components={{
                                                        h1: ({ children }) => (
                                                            <h1 className="mb-4 text-xl font-semibold">{children}</h1>
                                                        ),
                                                        h2: ({ children }) => (
                                                            <h2 className="mb-2 mt-6 text-base font-semibold">
                                                                {children}
                                                            </h2>
                                                        ),
                                                        h3: ({ children }) => (
                                                            <h3 className="mb-2 mt-4 font-semibold">{children}</h3>
                                                        ),
                                                        p: ({ children }) => (
                                                            <p className="mb-3 break-words">{children}</p>
                                                        ),
                                                        ul: ({ children }) => (
                                                            <ul className="ml-5 list-disc space-y-2">{children}</ul>
                                                        ),
                                                        table: ({ children }) => (
                                                            <div className="my-3 max-w-full overflow-x-auto rounded border border-[var(--border)]">
                                                                <table className="w-full border-collapse text-xs">
                                                                    {children}
                                                                </table>
                                                            </div>
                                                        ),
                                                        th: ({ children }) => (
                                                            <th className="whitespace-nowrap border-b border-[var(--border)] px-3 py-2 text-left font-medium">
                                                                {children}
                                                            </th>
                                                        ),
                                                        td: ({ children }) => (
                                                            <td className="whitespace-nowrap border-b border-[var(--border)] px-3 py-2">
                                                                {children}
                                                            </td>
                                                        ),
                                                        a: ({ children }) => <span>{children}</span>,
                                                        img: () => null,
                                                    }}
                                                >
                                                    {translateReport && reportTab === "markdown" ? displayUi(report.markdown) : report.markdown}
                                                </ReactMarkdown>
                                            </div>
                                        ),
                                    },
                                    {
                                        key: "json",
                                        label: staticUiText("聚合 JSON"),
                                        children: (
                                            <pre
                                                className="max-h-[58vh] overflow-auto whitespace-pre-wrap break-words text-xs leading-6"
                                                data-testid="usage-v2-free-report-json"
                                            >
                                                {JSON.stringify(translateReport && reportTab === "json" ? displayUsageReportJson(JSON.parse(report.content), displayUi, displayJson) : JSON.parse(report.content), null, 2)}
                                            </pre>
                                        ),
                                    },
                                ]}
                            />
                        </>
                    ) : null}
                </Modal>
            </section>
            <AnalysisActionsV2 key={period} page={page} period={period} query={query} disabled={disabled || busy} />
        </>
    );
}
