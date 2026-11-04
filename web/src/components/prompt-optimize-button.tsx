import { uiText, useUiLocale } from "@/lib/i18n";
import { useRef, useState } from "react";
import { App, Button } from "antd";
import { Sparkles } from "lucide-react";
import { createClientId } from "@/lib/client-id";
import { optimizeImagePrompt } from "@/services/api/image";
import { completedPromptCompilation, getPromptCompilation, PromptCompilationUncertainError, type PublicPromptCompilation, type PromptInputData } from "@/services/api/prompt-compilations";
import type { AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";
import type { PromptScene } from "../../../shared/prompt-contracts";

/** Optional manual action. Never changes a prompt unless the user presses this button. */
export function PromptOptimizeButton({ config, prompt, references = [], operationType, scene = "free-optimize", toolKey, scopeKey = "", disabled, onApply, onBusyChange }: {
    config: AiConfig; prompt: string; references?: ReferenceImage[]; operationType: "image_generation" | "inpaint" | "upscale" | "batch_image"; scene?: PromptScene; toolKey?: string; scopeKey?: string; disabled?: boolean;
    onApply: (prompt: string, compilation: PublicPromptCompilation, input: PromptInputData) => void; onBusyChange?: (busy: boolean) => void;
}) {
    useUiLocale();
    const { message } = App.useApp();
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState<string>();
    const lock = useRef(false);
    const pendingInput = useRef<PromptInputData | undefined>(undefined);
    const supported = operationType !== "upscale";
    const pendingContext = useRef<{ ownerId?: string; scopeKey: string; model: string; operationType: string; scene: PromptScene; toolKey?: string; prompt: string; references: ReferenceImage[] } | undefined>(undefined);
    const current = useRef({ scopeKey, model: config.model, operationType, scene, toolKey, prompt, references });
    current.current = { scopeKey, model: config.model, operationType, scene, toolKey, prompt, references };
    const run = async () => {
        if (lock.current || (!pending && !supported)) return;
        lock.current = true; setBusy(true); onBusyChange?.(true);
        const requestId = pending || createClientId();
        const input: PromptInputData = pendingInput.current || { scene, userText: prompt, fields: {}, mode: operationType === "image_generation" ? "generate" : "edit", referenceRoles: references.map((image, index) => image.name || `图片${index + 1}`) };
        pendingInput.current = input;
        const context = pendingContext.current || { ownerId: useUserStore.getState().user?.id, scopeKey, model: config.model, operationType, scene, toolKey, prompt, references: references.map(image => ({ ...image })) };
        pendingContext.current = context;
        try {
            const result = pending
                ? completedPromptCompilation(await getPromptCompilation(requestId), requestId)
                : await optimizeImagePrompt(config, input, references, { requestId, operationType, toolKey });
            setPending(undefined);
            pendingInput.current = undefined;
            pendingContext.current = undefined;
            const latest = current.current;
            if (context.ownerId !== useUserStore.getState().user?.id) return;
            if (context.scopeKey !== latest.scopeKey || context.model !== latest.model || context.operationType !== latest.operationType || context.scene !== latest.scene || context.toolKey !== latest.toolKey || context.prompt !== latest.prompt || context.references.length !== latest.references.length || context.references.some((image, index) => {
                const other = latest.references[index];
                return !other || image.id !== other.id || image.name !== other.name || image.dataUrl !== other.dataUrl || image.storageKey !== other.storageKey || image.sourceAssetId !== other.sourceAssetId;
            })) {
                message.warning(uiText("原优化请求已完成，但输入或参考图已变化，未覆盖当前内容。"));
                return;
            }
            onApply(result.prompt, result, { ...input, compilationId: result.id });
            message.success(result.summaryZh || (result.optimized ? uiText("提示词已优化，可继续编辑后生成") : uiText("已使用明确配置的回退提示词")));
        } catch (error) {
            if (error instanceof PromptCompilationUncertainError) setPending(requestId);
            else { setPending(undefined); pendingInput.current = undefined; pendingContext.current = undefined; }
            message.error(error instanceof Error ? error.message : uiText("提示词优化失败"));
        } finally { lock.current = false; setBusy(false); onBusyChange?.(false); }
    };
    return <Button size="small" type="text" icon={<Sparkles size={14} />} loading={busy} title={!supported ? uiText("此操作暂不支持提示词优化，可直接填写要求后生成。") : undefined} disabled={disabled || !config.model || (!pending && (!supported || !prompt.trim()))} onClick={() => void run()}>{pending ? uiText("查询原优化请求") : !supported ? uiText("此操作不支持一键优化") : busy ? uiText("正在优化提示词…") : uiText("一键优化提示词")}</Button>;
}
