import { uiText, useUiLocale } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import { App, Button, Modal } from "antd";
import { Sparkles } from "lucide-react";
import { createClientId } from "@/lib/client-id";
import { optimizeImagePrompt } from "@/services/api/image";
import { completedPromptCompilation, getPromptCompilation, PromptCompilationUncertainError, type PublicPromptCompilation, type PromptInputData } from "@/services/api/prompt-compilations";
import type { AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";
import type { PromptScene } from "../../../shared/prompt-contracts";
import { imageReferenceRoles, imageReferencesMatch } from "@/lib/image-reference-prompt";
import { readImageOptions } from "@/lib/image-advanced-settings";

type OptimizationContext = { ownerId?: string; scopeKey: string; configKey: string; operationType: string; scene: PromptScene; toolKey?: string; prompt: string; fieldsKey: string; references: ReferenceImage[] };
type OptimizationPreview = { result: PublicPromptCompilation & { prompt: string }; input: PromptInputData; context: OptimizationContext; revision: number };
function sameContext(left: OptimizationContext, right: OptimizationContext) {
    return left.ownerId === right.ownerId && left.scopeKey === right.scopeKey && left.configKey === right.configKey && left.operationType === right.operationType && left.scene === right.scene && left.toolKey === right.toolKey && left.prompt === right.prompt && left.fieldsKey === right.fieldsKey && imageReferencesMatch(left.references, right.references);
}

/** A bounded exact-text comparison: shared edges stay plain, changed spans are highlighted. */
export function promptTextDifference(original: string, rewritten: string) {
    let start = 0, end = 0;
    while (start < original.length && start < rewritten.length && original[start] === rewritten[start]) start++;
    while (end < original.length - start && end < rewritten.length - start && original[original.length - 1 - end] === rewritten[rewritten.length - 1 - end]) end++;
    return { before: original.slice(0, start), removed: original.slice(start, original.length - end), added: rewritten.slice(start, rewritten.length - end), after: end ? original.slice(-end) : "" };
}

/** Optional manual action. A completed optimization is a preview until explicitly applied. */
export function PromptOptimizeButton({ config, prompt, references = [], operationType, scene = "free-optimize", fields = {}, toolKey, scopeKey = "", disabled, onApply, onBusyChange }: {
    config: AiConfig; prompt: string; references?: ReferenceImage[]; operationType: "image_generation" | "inpaint" | "upscale" | "batch_image"; scene?: PromptScene; toolKey?: string; scopeKey?: string; disabled?: boolean;
    fields?: PromptInputData["fields"];
    onApply: (prompt: string, compilation: PublicPromptCompilation, input: PromptInputData) => void; onBusyChange?: (busy: boolean) => void;
}) {
    useUiLocale();
    const { message } = App.useApp();
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState<string>();
    const [preview, setPreview] = useState<OptimizationPreview>();
    const previewRef = useRef<OptimizationPreview | undefined>(undefined);
    const ownerId = useUserStore(state => state.user?.id);
    const lock = useRef(false);
    const mounted = useRef(true);
    const busyChange = useRef(onBusyChange);
    busyChange.current = onBusyChange;
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; if (lock.current) busyChange.current?.(false); };
    }, []);
    const pendingInput = useRef<PromptInputData | undefined>(undefined);
    const supported = operationType !== "upscale";
    const fieldsKey = JSON.stringify(fields);
    const pendingContext = useRef<{ context: OptimizationContext; revision: number } | undefined>(undefined);
    const latestContext = { ownerId, scopeKey, configKey: JSON.stringify(config), operationType, scene, toolKey, prompt, fieldsKey, references };
    const current = useRef(latestContext);
    const revision = useRef(0);
    if (!sameContext(current.current, latestContext)) revision.current += 1;
    current.current = { ...latestContext, references: references.map(image => ({ ...image })) };
    const isCurrent = (value: OptimizationPreview | NonNullable<typeof pendingContext.current>) => value.revision === revision.current && sameContext(value.context, current.current) && value.context.ownerId === useUserStore.getState().user?.id;
    const closePreview = () => { previewRef.current = undefined; setPreview(undefined); };
    const applyPreview = () => {
        const value = previewRef.current;
        if (!value || disabled || !isCurrent(value) || value.result.questions?.length) return;
        closePreview();
        onApply(value.result.prompt, value.result, { ...value.input, compilationId: value.result.id });
        message.success(uiText("已应用优化结果，可继续编辑后生成"));
    };
    const run = async () => {
        if (!mounted.current || lock.current || previewRef.current || disabled || (!pending && (!supported || !prompt.trim()))) return;
        if (pendingContext.current && pendingContext.current.context.ownerId !== useUserStore.getState().user?.id) { message.warning(uiText("账号已变化，不能查询或应用其他账号的优化请求。")); return; }
        lock.current = true; setBusy(true); onBusyChange?.(true);
        const requestId = pending || createClientId();
        const input: PromptInputData = pendingInput.current || { scene, userText: prompt, fields: JSON.parse(fieldsKey), mode: operationType === "image_generation" ? "generate" : "edit", referenceRoles: imageReferenceRoles(references) };
        pendingInput.current = input;
        const context = pendingContext.current || { context: current.current, revision: revision.current };
        pendingContext.current = context;
        try {
            const result = pending
                ? completedPromptCompilation(await getPromptCompilation(requestId).catch(error => { throw new PromptCompilationUncertainError(requestId, undefined, error); }), requestId)
                : await optimizeImagePrompt(config, input, references, { requestId, operationType, toolKey });
            if (!mounted.current) return;
            setPending(undefined);
            pendingInput.current = undefined;
            pendingContext.current = undefined;
            if (context.context.ownerId !== useUserStore.getState().user?.id) return;
            if (!isCurrent(context)) {
                message.warning(uiText("原优化请求已完成，但输入或参考图已变化，未覆盖当前内容。"));
                return;
            }
            const next = { result, input, ...context };
            previewRef.current = next;
            setPreview(next);
        } catch (error) {
            if (!mounted.current) return;
            if (error instanceof PromptCompilationUncertainError) setPending(requestId);
            else { setPending(undefined); pendingInput.current = undefined; pendingContext.current = undefined; }
            message.error(error instanceof Error ? error.message : uiText("提示词优化失败"));
        } finally { lock.current = false; if (mounted.current) { setBusy(false); onBusyChange?.(false); } }
    };
    const difference = preview ? promptTextDifference(preview.context.prompt, preview.result.prompt) : undefined;
    const stale = Boolean(preview && !isCurrent(preview));
    let negativePrompt = "";
    try { negativePrompt = readImageOptions(preview ? JSON.parse(preview.context.configKey).imageOptions : config.imageOptions).negative_prompt || ""; } catch { /* Invalid settings remain blocked by generation validation. */ }
    return <>
        <Button size="small" type="text" icon={<Sparkles size={14} />} loading={busy} title={!supported ? uiText("此操作暂不支持提示词优化，可直接填写要求后生成。") : undefined} disabled={disabled || Boolean(preview) || !config.model || (!pending && (!supported || !prompt.trim()))} onClick={() => void run()}>{pending ? uiText("查询原优化请求") : !supported ? uiText("此操作不支持一键优化") : busy ? uiText("正在优化提示词…") : uiText("一键优化提示词")}</Button>
        <Modal open={Boolean(preview)} title={uiText("核对提示词优化")} width={900} onCancel={closePreview} footer={<><Button onClick={closePreview}>{uiText("取消，保留原文")}</Button><Button type="primary" disabled={disabled || stale || Boolean(preview?.result.questions?.length)} onClick={applyPreview}>{uiText("确认应用")}</Button></>}>
            <p className="text-sm text-muted-foreground">{uiText("删除部分划线，新增部分高亮。确认只替换提示词，不会自动生成图片。")}</p>
            {stale ? <p role="alert" className="text-destructive">{uiText("输入、参考图、账号或模型设置已变化，此预览已失效。请关闭后重新优化。")}</p> : null}
            {preview?.result.summaryZh ? <p className="text-sm">{preview.result.summaryZh}</p> : null}
            {preview?.result.method === "template" ? <p className="text-xs text-muted-foreground">{uiText("固定模板 · 未调用语言模型改写")}</p> : null}
            {preview?.result.questions?.length ? <section role="alert" className="my-3 rounded-md border border-border p-3"><strong>{uiText("请先补充以下问题，再重新优化")}</strong><ul className="mt-2 list-disc pl-5">{preview.result.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></section> : null}
            {difference ? <div className="grid gap-4 md:grid-cols-2">
                <section><h3 className="mb-2 font-medium">{uiText("原文")}</h3><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-sans text-sm">{difference.before}<del>{difference.removed}</del>{difference.after}</pre></section>
                <section><h3 className="mb-2 font-medium">{uiText(negativePrompt.trim() ? "优化后 · 主提示词" : "优化后 · 实际发送文本")}</h3><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-sans text-sm">{difference.before}<mark className="bg-primary/15 text-foreground">{difference.added}</mark>{difference.after}</pre></section>
            </div> : null}
            {negativePrompt.trim() ? <section className="mt-3"><strong>{uiText("排除要求")}</strong><p className="my-1 text-xs text-muted-foreground">{uiText("由服务端按模型规则加入正文或原生排除参数；上方仅为主提示词。")}</p><pre className="whitespace-pre-wrap break-words font-sans text-sm">{negativePrompt}</pre></section> : null}
            {preview?.context.references.length ? <ol className="mt-3 space-y-1 text-sm">{preview.context.references.map((image, index) => <li key={`${index}:${image.id}`}>{uiText("图片{count}", { count: index + 1 })} · {image.name} · {image.role || uiText("用途未指定")}</li>)}</ol> : null}
        </Modal>
    </>;
}
