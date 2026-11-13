import { useDisplayUiValue, useDisplayConfig } from "@/hooks/use-display-text";
import { staticUiText } from "@/lib/static-ui-copy";
import { useUiLocale } from "@/lib/i18n";
import { Alert, Button, Checkbox, Modal, Select, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { saveAs } from "file-saver";
import { analyzeUsage, exportUsageRecords, listUsageAnalysisModels, previewUsageAnalysis, type UsageAnalysisPreview, type UsageAnalysisResult, type UsageFilters } from "@/services/api/usage-analytics";

/** Preserve the server-frozen preview and one-shot paid confirmation. No automatic POST retries. */
export function LegacyActions({ filters, reason, onBusy }: { filters: UsageFilters | null; reason?: string; onBusy: (busy: boolean) => void }) {
    const displayUi = useDisplayUiValue();
    const displayConfig = useDisplayConfig();
    useUiLocale();
    const [models, setModels] = useState<Array<{ id: string; name: string }>>([]),
        [model, setModel] = useState<string>();
    const [samples, setSamples] = useState(false),
        [preview, setPreview] = useState<UsageAnalysisPreview | null>(null),
        [used, setUsed] = useState(false),
        [result, setResult] = useState<UsageAnalysisResult | null>(null);
    const [error, setError] = useState(""),
        [notice, setNotice] = useState(""),
        [busy, setBusy] = useState(""),
        [progress, setProgress] = useState(0),
        [exportOpen, setExportOpen] = useState(false);
    const controller = useRef<AbortController | null>(null);
    const modelController = useRef<AbortController | null>(null);
    const [modelsBusy, setModelsBusy] = useState(false);
    useEffect(() => {
        onBusy(Boolean(busy));
        return () => onBusy(false);
    }, [busy, onBusy]);
    useEffect(
        () => () => {
            controller.current?.abort();
            modelController.current?.abort();
        },
        [],
    );
    const run = async (kind: string, work: (signal: AbortSignal) => Promise<void>) => {
        if (controller.current || !filters) return;
        const current = new AbortController();
        controller.current = current;
        setBusy(kind);
        setError("");
        setNotice("");
        try {
            await work(current.signal);
        } catch (failure) {
            if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : "操作未完成，请手动重试。");
        } finally {
            if (controller.current === current) {
                controller.current = null;
                setBusy("");
            }
        }
    };
    const cancel = () => {
        controller.current?.abort();
        setNotice(busy === "analyze" ? "已取消等待。请求可能已交给供应商并产生费用；不会自动重发。" : "操作已取消；未完成的导出不会保存。");
    };
    const loadModels = async () => {
        if (modelsBusy) return;
        const current = new AbortController();
        modelController.current = current;
        setModelsBusy(true);
        setError("");
        try {
            const data = await listUsageAnalysisModels(current.signal);
            current.signal.throwIfAborted();
            setModels(data.models);
            setModel((value) => (data.models.some((item) => item.id === value) ? value : undefined));
        } catch (failure) {
            if (!current.signal.aborted) {
                setModels([]);
                setModel(undefined);
                setError(failure instanceof Error ? failure.message : "文字模型读取失败");
            }
        } finally {
            setModelsBusy(false);
        }
    };
    return (
        <section className="wb-surface space-y-3 p-4 sm:p-5" aria-label={staticUiText("原始记录与付费分析")}>
            <h3 className="font-semibold">{staticUiText("原始记录与手动 AI 分析")}</h3>
            <p className="text-xs leading-5 text-[var(--muted-foreground)]">{staticUiText("保留完整 JSONL 与已有预览确认流程。AI 使用当前日期 / 人员 / 单板块 / 单模型的基础汇总，不包含本页新增的时长、流程、比较指标；默认不发送姓名、原始提示词或图片。")}</p>
            {reason ? <Alert type="warning" showIcon title={staticUiText("当前筛选不支持旧版操作")} description={displayUi(reason)} /> : null}
            <div className="flex flex-wrap gap-2">
                <Button disabled={!filters || Boolean(busy)} onClick={() => setExportOpen(true)}>{staticUiText("导出完整 JSONL")}</Button>
                <Button disabled={!filters || Boolean(busy)} loading={modelsBusy} onClick={() => void loadModels()}>{staticUiText("加载 / 刷新文字模型")}</Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
                <Select
                    aria-label={staticUiText("手动分析文字模型")}
                    placeholder={staticUiText("先加载并选择文字模型")}
                    style={{ minWidth: 220, maxWidth: "100%" }}
                    value={model}
                    options={displayConfig(models.map((item) => ({ value: item.id, label: item.name })), "options")}
                    disabled={!filters || Boolean(busy) || modelsBusy}
                    onChange={setModel}
                />
                <Checkbox
                    disabled={!filters || Boolean(busy)}
                    checked={samples}
                    onChange={(event) => {
                        setSamples(event.target.checked);
                        setPreview(null);
                        setUsed(false);
                        setResult(null);
                    }}
                >{staticUiText("额外包含少量脱敏提示词摘要")}</Checkbox>
            </div>
            <div className="flex flex-wrap gap-2">
                <Button
                    disabled={!filters || Boolean(busy)}
                    loading={busy === "preview"}
                    onClick={() =>
                        void run("preview", async (signal) => {
                            setPreview(null);
                            setUsed(false);
                            setResult(null);
                            const next = await previewUsageAnalysis({ ...filters!, includePromptSamples: samples }, signal);
                            signal.throwIfAborted();
                            setPreview(next);
                        })
                    }
                >{staticUiText("预览将发送的汇总")}</Button>
                <Button
                    type="primary"
                    disabled={!filters || Boolean(busy) || !preview || used || !model || !models.some((item) => item.id === model)}
                    loading={busy === "analyze"}
                    onClick={() =>
                        void run("analyze", async (signal) => {
                            if (!preview || used || !model) return;
                            if (+new Date(preview.expiresAt) <= Date.now()) throw new Error("预览已过期，请重新预览。");
                            setUsed(true);
                            setResult(null);
                            const next = await analyzeUsage({ previewId: preview.previewId, previewHash: preview.previewHash, modelConfigId: model, confirm: true }, signal);
                            signal.throwIfAborted();
                            setResult(next);
                        })
                    }
                >{staticUiText("发送已预览汇总 · 可能付费")}</Button>
                {busy ? <Button onClick={cancel}>{staticUiText("取消")}{busy === "analyze" ? staticUiText("等待") : staticUiText("操作")}</Button> : null}
            </div>
            {error ? <Alert type="error" title={displayUi(error)} description={staticUiText("不会自动重发付费请求；失败或不确定时请先核对再生成新预览。")} /> : null}
            {notice ? <Alert type="info" title={notice} /> : null}
            {preview ? (
                <div className="rounded-lg border border-[var(--border)] p-3">
                    <div className="mb-2 flex flex-wrap gap-2">
                        <Tag>{preview.estimatedCharacters}{staticUiText(" 字符")}</Tag>
                        <Tag>{preview.includesPromptSamples ? staticUiText("含 {p0} 条脱敏摘要", { p0: `${preview.sampleCount}` }) : staticUiText("仅基础汇总")}</Tag>
                        {used ? <Tag>{staticUiText("已提交，不重复发送")}</Tag> : null}
                    </div>
                    {preview.warnings.map((warning, i) => (
                        <p key={i} className="mb-2 text-xs">
                            {displayUi(warning)}
                        </p>
                    ))}
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs leading-6" data-testid="usage-v2-preview">
                        {preview.content}
                    </pre>
                </div>
            ) : null}
            {result ? (
                <div className="rounded-lg border border-[var(--border)] p-3">
                    <h4 className="mb-2 font-medium">{staticUiText("辅助分析结果")}</h4>
                    <pre className="whitespace-pre-wrap break-words text-sm leading-7">{result.content}</pre>
                </div>
            ) : null}
            <Modal
                title={staticUiText("导出当前支持范围的完整 JSONL")}
                open={exportOpen}
                onCancel={() => {
                    if (busy === "export") cancel();
                    setExportOpen(false);
                }}
                footer={
                    <>
                        <Button
                            onClick={() => {
                                if (busy === "export") cancel();
                                setExportOpen(false);
                            }}
                        >{staticUiText("取消")}</Button>
                        <Button
                            type="primary"
                            loading={busy === "export"}
                            disabled={!filters || Boolean(busy && busy !== "export")}
                            onClick={() =>
                                void run("export", async (signal) => {
                                    setProgress(0);
                                    const exported = await exportUsageRecords(filters!, { signal, onProgress: setProgress });
                                    signal.throwIfAborted();
                                    if (exported.blob) saveAs(exported.blob, `使用原始记录-${new Date().toISOString().slice(0, 10)}.jsonl`);
                                    setNotice(`已完整导出 ${exported.recordCount} 条记录；收到完整结束标记后才保存。`);
                                    setExportOpen(false);
                                })
                            }
                        >{staticUiText("确认导出")}</Button>
                    </>
                }
            >
                <Alert type="warning" showIcon title={staticUiText("文件包含业务敏感记录，请妥善保管")} description={staticUiText("包含当前可采集的完整请求与已保存提示词，不含密钥或图片字节；不自动发送给他人。浏览器决定保存位置。")} />
                <p className="mt-3 text-xs">{staticUiText("范围：")}{filters?.from}{staticUiText(" 至 ")}{filters?.to}{staticUiText("（不含终点）；")}{filters?.userIds ? staticUiText("{p0} 位指定人员", { p0: `${filters.userIds.length}` }) : staticUiText("当前范围全部人员")}；{filters?.boardKey || staticUiText("全部板块")}；{filters?.modelConfigId || staticUiText("全部模型")}。
                </p>
                {busy === "export" ? (
                    <p className="mt-3" role="status">{staticUiText("已读取 ")}{progress}{staticUiText(" 条，等待完整结束标记…")}</p>
                ) : null}
            </Modal>
        </section>
    );
}
