import { useRef, useState } from "react";
import { App, Button } from "antd";
import { Sparkles } from "lucide-react";
import { createClientId } from "@/lib/client-id";
import { optimizeImagePrompt } from "@/services/api/image";
import { completedPromptCompilation, getPromptCompilation, PromptCompilationUncertainError, type PublicPromptCompilation, type PromptInputData } from "@/services/api/prompt-compilations";
import type { AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

/** Optional manual action. Never changes a prompt unless the user presses this button. */
export function PromptOptimizeButton({ config, prompt, references = [], toolKey, disabled, onApply, onBusyChange }: {
    config: AiConfig; prompt: string; references?: ReferenceImage[]; toolKey?: string; disabled?: boolean;
    onApply: (prompt: string, compilation: PublicPromptCompilation, input: PromptInputData) => void; onBusyChange?: (busy: boolean) => void;
}) {
    const { message } = App.useApp();
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState<string>();
    const lock = useRef(false);
    const pendingInput = useRef<PromptInputData | undefined>(undefined);
    const pendingContext = useRef<{ ownerId?: string; model: string; prompt: string; references: ReferenceImage[] } | undefined>(undefined);
    const current = useRef({ model: config.model, prompt, references });
    current.current = { model: config.model, prompt, references };
    const run = async () => {
        if (lock.current) return;
        lock.current = true; setBusy(true); onBusyChange?.(true);
        const requestId = pending || createClientId();
        const input: PromptInputData = pendingInput.current || { scene: "free-optimize", userText: prompt, fields: {}, mode: references.length ? "edit" : "generate", referenceRoles: references.map((image, index) => image.name || `图片${index + 1}`) };
        pendingInput.current = input;
        const context = pendingContext.current || { ownerId: useUserStore.getState().user?.id, model: config.model, prompt, references: references.map(image => ({ ...image })) };
        pendingContext.current = context;
        try {
            const result = pending
                ? completedPromptCompilation(await getPromptCompilation(requestId), requestId)
                : await optimizeImagePrompt(config, input, references, { requestId, toolKey });
            setPending(undefined);
            pendingInput.current = undefined;
            pendingContext.current = undefined;
            const latest = current.current;
            if (context.ownerId !== useUserStore.getState().user?.id) return;
            if (context.model !== latest.model || context.prompt !== latest.prompt || context.references.length !== latest.references.length || context.references.some((image, index) => {
                const other = latest.references[index];
                return !other || image.id !== other.id || image.name !== other.name || image.dataUrl !== other.dataUrl || image.storageKey !== other.storageKey || image.sourceAssetId !== other.sourceAssetId;
            })) {
                message.warning("原优化请求已完成，但输入或参考图已变化，未覆盖当前内容。");
                return;
            }
            onApply(result.prompt, result, { ...input, compilationId: result.id });
            message.success(result.summaryZh || (result.optimized ? "提示词已优化，可继续编辑后生成" : "已使用明确配置的回退提示词"));
        } catch (error) {
            if (error instanceof PromptCompilationUncertainError) setPending(requestId);
            else { setPending(undefined); pendingInput.current = undefined; pendingContext.current = undefined; }
            message.error(error instanceof Error ? error.message : "提示词优化失败");
        } finally { lock.current = false; setBusy(false); onBusyChange?.(false); }
    };
    return <Button size="small" type="text" icon={<Sparkles size={14} />} loading={busy} disabled={disabled || !config.model || (!pending && !prompt.trim())} onClick={() => void run()}>{pending ? "查询原优化请求" : busy ? "正在优化提示词…" : "一键优化提示词"}</Button>;
}
