import { useRef, useState } from "react";
import { Check } from "lucide-react";
import { useUiText } from "@/lib/i18n";
import { useToolConfig, useToolEnabled } from "@/hooks/use-tool-config";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasImageMaskEditPayload } from "./canvas-node-mask-edit-dialog";
import { CanvasPromptField } from "./canvas-prompt-field";

export type PreparedCanvasMask = { node: CanvasNodeData; selection: Omit<CanvasImageMaskEditPayload, "prompt"> };

export function CanvasMaskComposer({ draft, current, config, onDiscard, onSubmit }: {
    draft: PreparedCanvasMask; current?: CanvasNodeData; config: AiConfig; onDiscard: () => void;
    onSubmit: (node: CanvasNodeData, payload: CanvasImageMaskEditPayload) => Promise<void>;
}) {
    const t = useUiText();
    const [prompt, setPrompt] = useState("");
    const [running, setRunning] = useState(false);
    const submitting = useRef(false);
    const enabled = useToolEnabled("canvas-mask-edit");
    const model = useToolConfig({ ...config, model: draft.selection.model }, "canvas-mask-edit").model;
    const drawn = draft.node.metadata, actual = current?.metadata;
    const stale = !current || current.id !== draft.node.id || actual?.content !== drawn?.content ||
        actual?.storageKey !== drawn?.storageKey || actual?.serverAssetId !== drawn?.serverAssetId;
    const unavailable = !enabled || !model || model !== draft.selection.model;
    const disabled = stale || unavailable || running || !prompt.trim();
    const submit = async () => {
        if (disabled || submitting.current) return;
        submitting.current = true;
        setRunning(true);
        try { await onSubmit(draft.node, { ...draft.selection, prompt: prompt.trim() }); }
        finally { submitting.current = false; setRunning(false); }
    };
    return <>
        <div className="cw-generator-body">
            <div className="cw-media-kind"><Check size={16} /><span>{t("已附加局部蒙版")}</span></div>
            <p className="my-2 break-words text-xs">{draft.node.title}</p>
            <CanvasPromptField autoFocus value={prompt} maxLength={2000} disabled={running || stale || unavailable} aria-label={t("描述图像")}
                placeholder={t("例如：把选中区域改成金属材质，保持原图光影")} onChange={event => setPrompt(event.target.value)}
                canGenerate={!disabled} onGenerate={() => void submit()} />
            <button type="button" className="mt-2 text-xs underline" disabled={running} onClick={onDiscard}>{t("移除蒙版")}</button>
        </div>
        <div className="cw-generator-footer">
            <div className={`cw-generate-action ${disabled ? "is-disabled" : ""}`}>
                <button type="button" className="cw-generate-button" disabled={disabled} onClick={() => void submit()}>
                    {running ? t("生成中…") : t("生成局部修改图")} <span className="cw-generate-count">×1</span>
                </button>
            </div>
            <p role="status" className="mt-2 text-xs">{stale ? t("原图已变化，请移除蒙版并重新涂抹。") : unavailable ? t("局部编辑模型已变化，请重新打开涂抹工具。") : t("只提交这张原图与蒙版，生成 1 张。")}</p>
        </div>
    </>;
}
