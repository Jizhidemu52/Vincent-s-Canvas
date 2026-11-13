import { useDisplayUiValue, useDisplayConfig } from "@/hooks/use-display-text";
import { staticUiText } from "@/lib/static-ui-copy";
import { useUiLocale } from "@/lib/i18n";
import { Alert, Button, Checkbox, Modal, Select, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { listUsageAnalysisModels } from "@/services/api/usage-analytics";
import {
    analyzeUsageV2,
    previewUsageV2Analysis,
    usageV2ReportPeriodError,
    type UsageV2AnalysisPreview,
    type UsageV2AnalysisResult,
    type UsageV2Query,
    type UsageV2ReportPage,
    type UsageV2ReportPeriod,
} from "@/services/api/usage-analytics-v2";

/** Parent keys this component to the applied/draft scope and template. No automatic provider call or retry. */
export default function AnalysisActionsV2({
    page,
    period,
    query,
    disabled,
}: {
    page: UsageV2ReportPage;
    period: UsageV2ReportPeriod;
    query: UsageV2Query | null;
    disabled: boolean;
}) {
    const displayUi = useDisplayUiValue();
    const displayConfig = useDisplayConfig();
    useUiLocale();
    const [models, setModels] = useState<Array<{ id: string; name: string }>>([]),
        [model, setModel] = useState<string>();
    const [preview, setPreview] = useState<UsageV2AnalysisPreview | null>(null),
        [result, setResult] = useState<UsageV2AnalysisResult | null>(null);
    const [open, setOpen] = useState(false),
        [acknowledged, setAcknowledged] = useState(false),
        [used, setUsed] = useState(false);
    const [busy, setBusy] = useState<"" | "preview" | "analyze">(""),
        [modelsBusy, setModelsBusy] = useState(false),
        [error, setError] = useState(""),
        [notice, setNotice] = useState("");
    const controller = useRef<AbortController | null>(null),
        modelsController = useRef<AbortController | null>(null);
    useEffect(
        () => () => {
            controller.current?.abort();
            modelsController.current?.abort();
        },
        [],
    );
    const periodError = usageV2ReportPeriodError(period, query?.from, query?.to);
    const blocked = disabled || !query?.from || !query.to || Boolean(periodError);
    const selectedModel = models.find((item) => item.id === model);
    const invalidate = () => {
        setPreview(null);
        setResult(null);
        setOpen(false);
        setAcknowledged(false);
        setUsed(false);
        setError("");
        setNotice("");
    };
    const run = async (kind: "preview" | "analyze", work: (signal: AbortSignal) => Promise<void>) => {
        if (blocked || controller.current) return;
        const current = new AbortController();
        controller.current = current;
        setBusy(kind);
        setError("");
        setNotice("");
        try {
            await work(current.signal);
        } catch (failure) {
            if (!current.signal.aborted)
                setError(failure instanceof Error ? failure.message : "操作结果未确认；不会自动重发。");
        } finally {
            if (controller.current === current) {
                controller.current = null;
                setBusy("");
            }
        }
    };
    const cancel = () => {
        controller.current?.abort();
        setPreview(null);
        setOpen(false);
        setAcknowledged(false);
        setNotice(
            busy === "analyze" || used
                ? "已停止等待并使本页确认失效。模型调用可能已发生或产生费用，不会自动重发；请先核查原调用。"
                : "V2预览已取消并失效；没有调用模型，不会自动重新预览。",
        );
    };
    const loadModels = async () => {
        if (blocked || busy || modelsController.current) return;
        invalidate();
        const current = new AbortController();
        modelsController.current = current;
        setModelsBusy(true);
        try {
            const data = await listUsageAnalysisModels(current.signal);
            current.signal.throwIfAborted();
            setModels(data.models);
            setModel((value) => (data.models.some((item) => item.id === value) ? value : undefined));
        } catch (failure) {
            if (!current.signal.aborted) {
                setModels([]);
                setModel(undefined);
                setError(failure instanceof Error ? failure.message : "文字模型暂不可用");
            }
        } finally {
            if (modelsController.current === current) {
                modelsController.current = null;
                setModelsBusy(false);
            }
        }
    };
    return (
        <section className="wb-surface space-y-3 p-4 sm:p-5" aria-label={staticUiText("V2匿名聚合AI分析")}>
            <h3 className="font-semibold">{staticUiText("V2 匿名聚合 AI 分析 ")}<Tag>{staticUiText("手动确认 · 可能付费")}</Tag>
            </h3>
            <p className="text-xs leading-5 text-[var(--muted-foreground)]">{staticUiText("使用当前页签、模板和全部已应用筛选，重新冻结同一套 V2 指标；与免费固定模板、下方旧版基础汇总 AI 分开。仅预览不调用模型，不发送姓名、提示词或图片。")}</p>
            <div className="flex max-w-full flex-wrap items-center gap-2">
                <Button
                    aria-label={staticUiText("加载 V2 文字模型")}
                    disabled={Boolean(blocked || busy || modelsBusy)}
                    loading={modelsBusy}
                    onClick={() => void loadModels()}
                >{staticUiText("加载 V2 文字模型")}</Button>
                <Select
                    aria-label={staticUiText("V2 AI 文字模型")}
                    placeholder={staticUiText("手动选择已配置文字模型")}
                    style={{ width: 240, maxWidth: "100%" }}
                    value={model}
                    options={displayConfig(models.map((item) => ({ value: item.id, label: item.name })), "options")}
                    disabled={Boolean(blocked || busy || modelsBusy)}
                    onChange={(value) => {
                        invalidate();
                        setModel(value);
                    }}
                />
                <Button
                    aria-label={staticUiText("预览 V2 AI 输入")}
                    aria-busy={busy === "preview"}
                    loading={busy === "preview"}
                    disabled={Boolean(blocked || busy || modelsBusy || !selectedModel)}
                    onClick={() =>
                        void run("preview", async (signal) => {
                            invalidate();
                            const next = await previewUsageV2Analysis(
                                { page, period, filters: { ...query!, from: query!.from!, to: query!.to! } },
                                signal,
                            );
                            signal.throwIfAborted();
                            setPreview(next);
                            setOpen(true);
                        })
                    }
                >{staticUiText("预览 V2 AI 输入")}</Button>
                {busy ? (
                    <Button aria-label={staticUiText("取消 V2 等待")} onClick={cancel}>{staticUiText("取消 V2 等待")}</Button>
                ) : null}
                {used ? <Tag>{staticUiText("本次已提交，不重复发送")}</Tag> : null}
            </div>
            <p className="text-xs leading-5 text-[var(--muted-foreground)]">{staticUiText("改变筛选、模板、页签、模型或刷新会使本页预览失效；取消只停止等待，不能撤回已交给供应商的调用。费用按所选模型与供应商规则结算，此处不估算金额。")}</p>
            {error ? (
                <Alert
                    type="error"
                    showIcon
                    title={displayUi(error)}
                    description={staticUiText("没有自动重试；失败或结果不确定时，请先核查原调用再明确创建新预览。")}
                />
            ) : null}
            {notice ? <Alert type="info" title={notice} /> : null}
            {result ? (
                <div className="rounded-lg border border-[var(--border)] p-3">
                    <h4 className="mb-2 font-medium">{staticUiText("基于 V2 冻结输入的辅助分析 · 请核对证据")}</h4>
                    <pre className="whitespace-pre-wrap break-words text-sm leading-7" data-testid="usage-v2-ai-result">
                        {result.content}
                    </pre>
                </div>
            ) : null}
            <Modal
                title={staticUiText("确认 V2 AI 冻结输入")}
                open={open && Boolean(preview)}
                width={{ xs: "96%", sm: "92%", md: "88%", lg: 1100 }}
                onCancel={cancel}
                footer={
                    <div className="flex flex-wrap justify-end gap-2">
                        <Button onClick={cancel}>{staticUiText("取消 V2 预览")}</Button>
                        <Button
                            type="primary"
                            aria-label={staticUiText("确认发送 V2 输入 · 可能付费")}
                            aria-busy={busy === "analyze"}
                            loading={busy === "analyze"}
                            disabled={Boolean(blocked || busy || !preview || !acknowledged || used || !selectedModel)}
                            onClick={() =>
                                void run("analyze", async (signal) => {
                                    if (!preview || !selectedModel || !acknowledged || used) return;
                                    if (Date.parse(preview.expiresAt) <= Date.now()) {
                                        setPreview(null);
                                        setOpen(false);
                                        throw new Error("V2预览已过期，未发送；请重新预览。");
                                    }
                                    setUsed(true);
                                    setAcknowledged(false);
                                    setResult(null);
                                    const next = await analyzeUsageV2(
                                        {
                                            source: "v2",
                                            previewId: preview.previewId,
                                            previewHash: preview.previewHash,
                                            modelConfigId: selectedModel.id,
                                            confirm: true,
                                        },
                                        signal,
                                    );
                                    signal.throwIfAborted();
                                    setResult(next);
                                    setOpen(false);
                                    setPreview(null);
                                })
                            }
                        >{staticUiText("确认发送 V2 输入 · 可能付费")}</Button>
                    </div>
                }
            >
                {preview ? (
                    <div className="space-y-3">
                        <Alert
                            type="warning"
                            showIcon
                            title={staticUiText("此按钮将调用所选模型，可能产生费用")}
                            description={staticUiText("只发送下面逐字展示的冻结系统提示和匿名数据，不重新读取看板、不附加提示词或图片；同一预览仅可提交一次。取消等待不承诺撤销调用或费用。")}
                        />
                        <p className="text-sm">{staticUiText("模型：")}{displayUi(selectedModel?.name || staticUiText("未选择"))}{staticUiText("；来源：V2 / ")}{preview.page}{staticUiText("；模板：")}{preview.period === "week"
                                ? staticUiText("完整自然周")
                                : preview.period === "month"
                                  ? staticUiText("完整自然月")
                                  : staticUiText("选定区间")}
                            。
                        </p>
                        <p className="break-words text-xs leading-6">{staticUiText("精确范围：[")}{preview.scope.from}, {preview.scope.to}{staticUiText(")；统计时区 Asia/Shanghai。人员筛选")}{" "}
                            {preview.scope.filters.selectedPeopleCount ?? staticUiText("全部")}{staticUiText(" 项；部门筛选")}{" "}
                            {preview.scope.filters.selectedDepartmentCount ?? staticUiText("全部")}{staticUiText(" 项；比较方式")}{" "}
                            {preview.scope.compare}{staticUiText("；部门口径 ")}{preview.scope.departmentBasis}{staticUiText("。所有匿名筛选和证据详见下方 JSON。")}</p>
                        <div className="flex flex-wrap gap-2">
                            <Tag>{staticUiText("V2 冻结输入")}</Tag>
                            <Tag>{preview.estimatedCharacters}{staticUiText(" 数据字符")}</Tag>
                            <Tag>{preview.systemPromptVersion}</Tag>
                            <Tag>{staticUiText("15 分钟内单次有效")}</Tag>
                        </div>
                        <p className="break-words text-xs">{staticUiText("失效时间：")}{new Date(preview.expiresAt).toLocaleString("zh-CN", {
                                timeZone: "Asia/Shanghai",
                                hour12: false,
                            })}{staticUiText("（北京时间）。")}</p>
                        <details>
                            <summary className="cursor-pointer text-sm font-medium">{staticUiText("冻结的系统提示")}</summary>
                            <pre
                                className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs leading-6"
                                data-testid="usage-v2-ai-system-input"
                            >
                                {preview.systemPrompt}
                            </pre>
                        </details>
                        <pre
                            className="max-h-[42vh] overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--border)] p-3 text-xs leading-6"
                            data-testid="usage-v2-ai-exact-input"
                        >
                            {preview.content}
                        </pre>
                        <Checkbox
                            aria-label={staticUiText("确认已核对 V2 输入与费用")}
                            checked={acknowledged}
                            disabled={Boolean(busy || used || blocked)}
                            onChange={(event) => setAcknowledged(event.target.checked)}
                        >{staticUiText("我已核对上述确切输入、所选模型与范围，并确认此次发送可能产生费用。")}</Checkbox>
                    </div>
                ) : null}
            </Modal>
        </section>
    );
}
