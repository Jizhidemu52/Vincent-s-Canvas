import { useDisplayUiValue, useDisplayConfig } from "@/hooks/use-display-text";
import { staticUiText } from "@/lib/static-ui-copy";
import { useUiLocale } from "@/lib/i18n";
import { Alert, Button, Form, Image, Input, Select, Tag } from "antd";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useConfirmUnsavedChanges, useUnsavedGuard } from "@/hooks/use-unsaved-guard";
import { createClientId } from "@/lib/client-id";
import { quickImageReferenceFileError, quickImageTitle } from "@/lib/quick-image-tools";
import {
    AdminQuickImageRequestError, findAdminQuickImageTest, getAdminQuickImageConfigurations,
    saveAdminQuickImageConfiguration, testAdminQuickImageConfiguration, recoverAdminQuickImageTest,
    type AdminQuickImageCatalog, type AdminQuickImageConfiguration, type QuickImageAction,
    type QuickImageConfigurationInput, type QuickImageEligibleModel,
} from "@/services/api/admin-quick-image";
import { requirePromptAdmin } from "@/services/api/admin-prompt-recipes";
import type { QueuedTask } from "@/services/api/generation-tasks";
import { uploadServerAsset } from "@/services/api/server-assets";
import { classifyTaskRecovery, submissionInvestigationMessage } from "@/services/api/task-result-reconciliation";
import { useUserStore } from "@/stores/use-user-store";

type Draft = { modelConfigId: string; prompt: string; parametersJson: string };
type TestRun = { requestId: string; task?: QueuedTask; notice?: string; rejected?: boolean };
type SourceImage = { file: File; preview: string; sourceUrl?: string };
const draftOf = (configuration: AdminQuickImageConfiguration): Draft => ({ modelConfigId: configuration.modelConfigId || "", prompt: configuration.prompt, parametersJson: JSON.stringify(configuration.parameters, null, 2) });
const messageOf = (error: unknown) => error instanceof Error ? error.message : "操作失败，请检查后重试。";
const terminal = (run: TestRun | null) => Boolean(run?.rejected || (run?.task && ["success", "failed", "cancelled"].includes(run.task.status)));
const receiptKey = (owner: string, action: QuickImageAction) => `canvas:admin-quick-image-test:${owner}:${action}`;
const statusText: Record<string, string> = { waiting: "排队中", processing: "处理中", paused: "等待恢复查询", success: "已完成", failed: "失败", cancelled: "已取消" };

export function parseQuickImageDraft(draft: Draft, models: QuickImageEligibleModel[]): QuickImageConfigurationInput {
    if (!models.some(model => model.id === draft.modelConfigId)) throw new Error("请选择当前可用的图片处理模型；不会自动回退到其他模型。");
    const prompt = draft.prompt.trim();
    if (!prompt || prompt.length > 4000) throw new Error("处理提示词须为 1–4000 个字符。");
    let parameters: unknown;
    try { parameters = JSON.parse(draft.parametersJson); } catch { throw new Error("高级参数必须是有效的 JSON 对象。"); }
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new Error("高级参数必须是 JSON 对象，不能是数组或空值。");
    if (JSON.stringify(parameters).length > 4000) throw new Error("高级参数压缩后不能超过 4000 个字符。");
    return { modelConfigId: draft.modelConfigId, prompt, parameters: parameters as Record<string, unknown> };
}

/** Only the recovery receipt is stored, never configuration, prompts, images or diagnostics. */
export function readQuickImageTestReceipt(owner: string, action: QuickImageAction): TestRun | null {
    try {
        const requestId = sessionStorage.getItem(receiptKey(owner, action));
        return requestId && /^[A-Za-z0-9_-]{1,128}$/.test(requestId) ? { requestId, notice: "发现原测试请求，请查询原任务；不会自动再次提交。" } : null;
    } catch { return null; }
}

function delay(signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
        const timer = window.setTimeout(finish, 2000);
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
    });
}

export function QuickImageConfigurationPanel({ isAdmin }: { isAdmin: boolean }) {
    useUiLocale();
    const user = useUserStore(state => state.user);
    const status = useUserStore(state => state.status);
    if (!isAdmin || status !== "authenticated" || user?.role !== "super_admin" || user.status !== "active") return <Alert type="warning" showIcon title={staticUiText("仅超级管理员可配置快捷图片处理")} />;
    return <QuickImageConfigurationSession key={user.id} owner={user.id} />;
}

function QuickImageConfigurationSession({ owner }: { owner: string }) {
    const displayUi = useDisplayUiValue();
    useUiLocale();
    const [catalog, setCatalog] = useState<AdminQuickImageCatalog | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const lifetime = useRef(new AbortController());
    const loadLock = useRef(false);
    const confirmUnsaved = useConfirmUnsavedChanges();
    const load = async () => {
        if (loadLock.current) return;
        const controller = lifetime.current;
        loadLock.current = true; setLoading(true); setError("");
        try {
            const next = await getAdminQuickImageConfigurations({ expectedOwnerId: owner, signal: controller.signal });
            if (!controller.signal.aborted) setCatalog(next);
        } catch (reason) { if (!controller.signal.aborted) setError(messageOf(reason)); }
        finally { if (!controller.signal.aborted) { loadLock.current = false; setLoading(false); } }
    };
    useEffect(() => {
        lifetime.current = new AbortController(); loadLock.current = false;
        void load();
        return () => { lifetime.current.abort(); };
    }, [owner]);
    return <section aria-label={staticUiText("快捷图片处理配置")} className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h3 className="text-base font-semibold">{staticUiText("快捷图片处理")}</h3><p className="mt-1 text-sm text-[var(--muted-foreground)]">{staticUiText("统一配置一键去背景、高清放大与提取产品图；普通使用页面只保留操作入口。")}</p></div>
            <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={async () => { if (await confirmUnsaved()) void load(); }}>{staticUiText("重新加载")}</Button>
        </div>
        <Alert type="info" showIcon title={staticUiText("保存与试运行相互独立")} description={staticUiText("保存后影响此操作的后续请求；试运行使用当前未保存草稿，只创建 1 个真实任务，不会修改线上配置。离开页面只停止本地查询，不取消任务。")} />
        {error ? <Alert type="error" showIcon title={staticUiText("配置加载失败")} description={displayUi(error)} /> : null}
        {loading && !catalog ? <p role="status">{staticUiText("正在加载快捷图片配置…")}</p> : null}
        {catalog ? <div className="grid min-w-0 gap-4 xl:grid-cols-2">{catalog.configurations.map(configuration => <QuickImageConfigurationEditor key={configuration.action} owner={owner} configuration={configuration} models={catalog.models} locked={loading || Boolean(error)} />)}</div> : null}
    </section>;
}

export function QuickImageConfigurationEditor({ owner, configuration, models, locked }: { owner: string; configuration: AdminQuickImageConfiguration; models: QuickImageEligibleModel[]; locked: boolean }) {
    const displayUi = useDisplayUiValue();
    const displayConfig = useDisplayConfig();
    useUiLocale();
    const action = configuration.action;
    const title = quickImageTitle(action);
    const [saved, setSaved] = useState(configuration);
    const [draft, setDraft] = useState<Draft>(() => draftOf(configuration));
    const [source, setSource] = useState<SourceImage | null>(null);
    const sourceRef = useRef<SourceImage | null>(null);
    const [run, setRun] = useState<TestRun | null>(() => readQuickImageTestReceipt(owner, action));
    const runRef = useRef(run);
    const lifetime = useRef(new AbortController());
    const operation = useRef<AbortController | null>(null);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    useEffect(() => { setSaved(configuration); setDraft(draftOf(configuration)); setError(""); setNotice(""); }, [configuration]);
    useEffect(() => {
        lifetime.current = new AbortController();
        return () => { lifetime.current.abort(); operation.current?.abort(); if (sourceRef.current) URL.revokeObjectURL(sourceRef.current.preview); };
    }, [owner, action]);
    const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(saved));
    useUnsavedGuard(dirty, staticUiText("{p0}配置尚未保存，离开后将丢失本次修改。", { p0: `${title}` }));
    const unavailable = !models.some(model => model.id === draft.modelConfigId);
    const disabled = locked || Boolean(busy);
    const patchRun = (next: TestRun) => { runRef.current = next; setRun(next); };
    const start = async (kind: string, work: (signal: AbortSignal) => Promise<void>) => {
        if (operation.current || locked) return;
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, lifetime.current.signal]);
        operation.current = controller; setBusy(kind); setError(""); setNotice("");
        try { requirePromptAdmin(owner); signal.throwIfAborted(); await work(signal); }
        catch (reason) { if (!signal.aborted) setError(messageOf(reason)); }
        finally { if (operation.current === controller) { operation.current = null; if (!lifetime.current.signal.aborted) setBusy(""); } }
    };
    const observe = async (requestId: string, signal: AbortSignal, initial?: QueuedTask) => {
        let task = initial;
        for (let attempt = 0; attempt < 150; attempt++) {
            signal.throwIfAborted(); requirePromptAdmin(owner);
            if (!task) task = (await findAdminQuickImageTest(requestId, { expectedOwnerId: owner, signal })) ?? undefined;
            signal.throwIfAborted();
            if (!task) { patchRun({ requestId, notice: "尚未查到原任务，不代表未提交；请稍后查询，不要重复试运行。" }); return; }
            patchRun({ requestId, task });
            if (["success", "failed", "cancelled", "paused"].includes(task.status)) return;
            await delay(signal); task = undefined;
        }
        patchRun({ ...runRef.current!, notice: "自动查询已暂停，可继续查询原任务；不会重新生成。" });
    };
    const save = () => start("save", async signal => {
        const input = parseQuickImageDraft(draft, models);
        const result = await saveAdminQuickImageConfiguration(action, { ...input, expectedVersion: saved.configurationVersion }, { expectedOwnerId: owner, signal });
        signal.throwIfAborted(); setSaved(result.configuration); setDraft(draftOf(result.configuration)); setNotice("已保存，仅影响此操作之后的新请求；未创建测试任务。");
    });
    const test = () => start("test", async signal => {
        if (runRef.current && !terminal(runRef.current)) throw new Error("原测试状态仍待核查，请查询原任务，不要再次提交。");
        const input = parseQuickImageDraft(draft, models);
        const reference = sourceRef.current;
        if (!reference) throw new Error("请先选择 1 张测试原图。");
        const options = { expectedOwnerId: owner, signal };
        if (!reference.sourceUrl) {
            const assetId = await uploadServerAsset(reference.file, { title: reference.file.name, source: "admin-quick-image-test" }, options);
            signal.throwIfAborted(); requirePromptAdmin(owner);
            reference.sourceUrl = `/api/assets/${encodeURIComponent(assetId)}/content`;
        }
        const requestId = createClientId();
        // Must survive a refresh before any paid POST. Storage denial blocks that POST.
        try { sessionStorage.setItem(receiptKey(owner, action), requestId); }
        catch { throw new Error("无法保存测试查询编号，请允许本站会话存储后再试；尚未提交测试任务。"); }
        patchRun({ requestId, notice: "正在提交一次测试；结果不确定时只查询原请求。" });
        try {
            const result = await testAdminQuickImageConfiguration(action, { requestId, sourceUrl: reference.sourceUrl, configuration: input }, options);
            await observe(requestId, signal, result.task);
        } catch (reason) {
            if (!signal.aborted) {
                const rejected = reason instanceof AdminQuickImageRequestError && reason.definitive;
                if (rejected) {
                    try { if (sessionStorage.getItem(receiptKey(owner, action)) === requestId) sessionStorage.removeItem(receiptKey(owner, action)); } catch { /* The in-memory rejection remains explicit. */ }
                }
                patchRun({ requestId, rejected, notice: messageOf(reason) });
            }
        }
    });
    const query = (resume = false) => start("query", async signal => {
        if (!runRef.current) return;
        try {
            if (resume && runRef.current.task && classifyTaskRecovery(runRef.current.task) === "resume") await recoverAdminQuickImageTest(runRef.current.task, { expectedOwnerId: owner, signal });
            await observe(runRef.current.requestId, signal);
        }
        catch (reason) { if (!signal.aborted) patchRun({ ...runRef.current, notice: messageOf(reason) }); }
    });
    const selectSource = (file?: File) => {
        if (disabled || !file) return;
        const invalid = quickImageReferenceFileError(file);
        if (invalid || !file.type) { setError(invalid || "请使用 PNG、JPEG 或 WebP 原图。"); return; }
        if (sourceRef.current) URL.revokeObjectURL(sourceRef.current.preview);
        const next = { file, preview: URL.createObjectURL(file) };
        sourceRef.current = next; setSource(next); setError("");
    };
    return <section aria-label={staticUiText("{p0}配置", { p0: `${title}` })} className="wb-surface min-w-0 space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold">{displayUi(title)}</h4><span><Tag>{saved.isDefault ? staticUiText("系统初始配置") : staticUiText("配置 v{p0}", { p0: `${saved.configurationVersion}` })}</Tag>{dirty ? <Tag color="warning">{staticUiText("未保存")}</Tag> : null}</span></div>
        <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">{action === "remove-background" ? staticUiText("模型直接生成全彩透明 PNG，原图与结果分别保留。主体颜色、细节与边缘需检查，不保证逐像素一致。") : action === "item-extract" ? staticUiText("生成白底平放的完整产品图，属于 AI 重构而非透明抠图；只补足必要遮挡，不把推测当成真实隐藏结构。模型、提示词和出图参数仅在此处管理。") : staticUiText("输出尺寸与清晰度由所选模型及参数决定，不固定承诺 4K。")}</p>
        {error ? <Alert type="error" showIcon title={displayUi(error)} /> : null}
        {notice ? <Alert type="success" showIcon title={notice} /> : null}
        {unavailable ? <Alert type="warning" showIcon title={staticUiText("当前模型未配置、已停用或不可用")} description={staticUiText("已保存：{p0}。请明确选择可用模型；不会自动替换。", { p0: `${saved.modelName || saved.modelId || saved.modelConfigId || staticUiText("无可用绑定")}` })} /> : null}
        <Form layout="vertical" disabled={disabled}>
            <Form.Item label={staticUiText("处理模型")} extra={staticUiText("只显示服务端提供的可用图片处理模型。")}>
                <Select aria-label={staticUiText("{p0}处理模型", { p0: `${title}` })} value={draft.modelConfigId || undefined} placeholder={staticUiText("请选择处理模型")} showSearch={{ optionFilterProp: "label" }} options={displayConfig([
                    ...(draft.modelConfigId && unavailable ? [{ value: draft.modelConfigId, label: staticUiText("{p0}（不可用）", { p0: `${saved.modelName || saved.modelId || draft.modelConfigId}` }), disabled: true }] : []),
                    ...models.map(model => ({ value: model.id, label: `${model.name} · ${model.providerName} · ${model.modelId}` })),
                ], "options")} onChange={modelConfigId => setDraft(current => ({ ...current, modelConfigId }))} />
            </Form.Item>
            <Form.Item label={staticUiText("处理提示词")} extra={action === "remove-background" ? staticUiText("说明要保留的主体、颜色与细节，并要求直接输出全彩透明 PNG；背景应真实透明，不含底色或棋盘格。1–4000 个字符，仅管理员可见。") : staticUiText("1–4000 个字符，仅管理员可见。")}><Input.TextArea aria-label={staticUiText("{p0}处理提示词", { p0: `${title}` })} className="mb-6" rows={5} maxLength={4000} showCount value={draft.prompt} onChange={event => setDraft(current => ({ ...current, prompt: event.target.value }))} /></Form.Item>
            <details className="mb-5 rounded-lg border border-[var(--border)] p-3"><summary className="cursor-pointer text-sm font-medium">{staticUiText("高级参数（JSON）")}</summary><p className="my-2 text-xs text-[var(--muted-foreground)]">{staticUiText("按所选模型填写，例如尺寸、质量；必须为 JSON 对象，压缩后不超过 4000 字符。服务端会验证不支持或受保护的参数。")}{action === "remove-background" ? staticUiText("去背景使用 GPT Image 2.5／2.6 时，服务端固定 background=transparent、output_format=png；其他模型仅通过提示词要求透明输出，不追加不支持的参数。") : ""}</p><Input.TextArea aria-label={staticUiText("{p0}高级参数 JSON", { p0: `${title}` })} className="!font-mono" rows={5} value={draft.parametersJson} onChange={event => setDraft(current => ({ ...current, parametersJson: event.target.value }))} /></details>
            <Button type="primary" loading={busy === "save"} disabled={disabled || !dirty || unavailable} onClick={() => void save()}>{staticUiText("保存")}{displayUi(title)}{staticUiText("配置")}</Button>
        </Form>
        <div className="space-y-3 border-t border-[var(--border)] pt-4">
            <h5 className="text-sm font-semibold">{staticUiText("用当前草稿试运行")}</h5>
            <p className="text-xs text-[var(--muted-foreground)]">{staticUiText("只上传 1 张自己的原图。点击下方按钮将提交 1 个正式图片任务；不会保存草稿或自动重试。")}</p>
            <input type="file" aria-label={staticUiText("{p0}测试原图", { p0: `${title}` })} accept="image/png,image/jpeg,image/webp" disabled={disabled} className="block w-full min-w-0 text-sm" onChange={event => { selectSource(event.target.files?.[0]); event.target.value = ""; }} />
            {source ? <div className="flex min-w-0 items-center gap-3"><img src={source.preview} alt={staticUiText("{p0}测试原图", { p0: `${title}` })} className="size-20 rounded-lg border border-[var(--border)] object-contain" /><span className="min-w-0 break-all text-xs">{displayUi(source.file.name)}</span></div> : null}
            <div className="flex flex-wrap gap-2"><Button loading={busy === "test"} disabled={disabled || unavailable || !source || Boolean(run && !terminal(run))} onClick={() => void test()}>{staticUiText("试运行 1 张")}</Button>{run ? <Button loading={busy === "query"} disabled={disabled} onClick={() => void query()}>{staticUiText("查询原测试任务")}</Button> : null}{classifyTaskRecovery(run?.task) === "resume" ? <Button disabled={disabled} onClick={() => void query(true)}>{staticUiText("恢复原任务查询")}</Button> : null}{busy === "test" || busy === "query" ? <Button onClick={() => { operation.current?.abort(); if (runRef.current) patchRun({ ...runRef.current, notice: "本地查询已停止，服务端任务未取消。请查询原任务，不要重复试运行。" }); }}>{staticUiText("停止本地等待")}</Button> : null}</div>
            {classifyTaskRecovery(run?.task) === "investigate" ? <Alert type="warning" showIcon title={submissionInvestigationMessage} /> : null}
            {run ? <div role="status" className="min-w-0 space-y-3"><p className="break-all text-xs text-[var(--muted-foreground)]">{staticUiText("请求编号：")}{run.requestId}</p><Tag color={run.task?.status === "success" ? "success" : run.task?.status === "failed" || run.rejected ? "error" : "processing"}>{run.rejected ? staticUiText("提交已拒绝") : run.task ? staticUiText(statusText[run.task.status]) || run.task.status : staticUiText("状态待核查")}</Tag>{run.notice ? <Alert type="warning" showIcon title={run.notice} /> : null}{run.task?.failureReason ? <Alert type="error" showIcon title={displayUi(run.task.failureReason)} /> : null}<Image.PreviewGroup><div className="space-y-3">{run.task?.resultUrls.filter(url => /^https?:\/\//.test(url) || url.startsWith("/api/assets/")).map((url, index) => <Image key={url} src={url} alt={staticUiText("{p0}测试结果 {p1}", { p0: `${title}`, p1: `${index + 1}` })} className="!max-h-96 !object-contain" />)}</div></Image.PreviewGroup></div> : null}
        </div>
    </section>;
}
