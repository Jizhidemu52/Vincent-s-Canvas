import { useUiText } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import { App } from "antd";
import { useNavigate } from "react-router-dom";
import { PromptCanvasDialog } from "./prompt-canvas-dialog";
import { createPromptActionGuard, promptActionIdentity, resolveCompletePrompt } from "@/lib/prompt-template-reuse";
import { promptDestination, type PromptTemplate } from "@/services/api/prompts";
import { useUserStore } from "@/stores/use-user-store";

/** The library and personal library share the same no-copy/paste actions. */
export function usePromptTemplateActions() {
    const t = useUiText();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const identity = useUserStore(promptActionIdentity);
    const alive = useRef(true);
    const [selected, setSelected] = useState<{ id: string; title: string; identity: string } | null>(null);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    useEffect(() => { setSelected(null); }, [identity]);
    const reuse = async (item: PromptTemplate, mode: "fill" | "fill_and_generate") => {
        const guard = createPromptActionGuard(identity, () => alive.current);
        try {
            const result = await resolveCompletePrompt(item.id, mode, guard.assert);
            if (result.pricing.modelChanged) message.warning(result.pricing.selectedModel ? t("模型已变更，当前使用 {p0}", { p0: String(result.pricing.selectedModel.name) }) : t("模型已变更，请在目标页选择替代模型"));
            navigate(promptDestination(result.template.targetTool, result.reuseToken));
        } catch (error) {
            if (guard.current()) message.error(error instanceof Error ? error.message : t("复用失败"));
        } finally { guard.dispose(); }
    };
    return {
        reuse,
        insertToCanvas: (item: PromptTemplate) => setSelected({ id: item.id, title: item.title, identity }),
        canvasDialog: selected && selected.identity === identity ? <PromptCanvasDialog key={selected.id} templateId={selected.id} title={selected.title} identity={identity} onClose={() => setSelected(null)} /> : null,
    };
}
