import { useState } from "react";
import { Button } from "antd";
import { Copy, GitBranch, RotateCcw } from "lucide-react";
import { useCopyText } from "@/hooks/use-copy-text";
import { canvasGenerationPrompt, hasIncompleteCanvasGenerationReferences } from "@/lib/canvas/canvas-generation-record";
import { useUiText } from "@/lib/i18n";
import type { CanvasNodeData } from "@/types/canvas";

export type CanvasGenerationRecordDetailsProps = {
    node: CanvasNodeData;
    draftPrompt: string;
    derivatives?: readonly CanvasNodeData[];
    disabled?: boolean;
    onRestorePrompt?: () => void;
    onContinue?: () => void;
    onRegenerate?: () => void;
    onRestoreGeneration?: () => void;
    onLocate?: (nodeId: string) => void;
};

/** Shared by the creation rail and a node panel; no write goes to the archive. */
export function CanvasGenerationRecordDetails({ node, draftPrompt, derivatives = [], disabled, onRestorePrompt, onContinue, onRegenerate, onRestoreGeneration, onLocate }: CanvasGenerationRecordDetailsProps) {
    const t = useUiText();
    const copyText = useCopyText();
    const [expanded, setExpanded] = useState(false);
    const record = node.metadata?.generationRecord;
    const prompt = canvasGenerationPrompt(node);
    const originalInput = record?.inputPrompt ?? node.metadata?.prompt ?? "";
    const modified = draftPrompt !== originalInput;
    return <section data-testid="canvas-generation-record" className="mb-3 min-w-0 space-y-2 text-xs" aria-label={t("图片生成档案")}>
        {hasIncompleteCanvasGenerationReferences(node) ? <div role="status" className="space-y-1 opacity-80"><p>{t("旧版记录参考信息不完整，可恢复历史输入")}</p>{node.metadata?.sourceTaskId && onRestoreGeneration ? <button type="button" className="hover:underline disabled:opacity-40" disabled={disabled} onClick={onRestoreGeneration}>{t("恢复历史输入")}</button> : null}</div> : null}
        {record || prompt ? <>
            <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{t("生成时提示词")}</span>
                <span className="opacity-60">{t("只读 · 点击复制")}</span>
            </div>
            {prompt ? <button type="button" className={`block w-full whitespace-pre-wrap break-words text-left leading-5 opacity-80 hover:opacity-100 ${expanded ? "max-h-48 overflow-y-auto" : "line-clamp-3"}`} aria-label={t("复制生成时提示词")} title={t("点击复制生成时提示词")} onClick={() => copyText(prompt, t("提示词已复制"))}>
                <Copy className="mr-1 inline size-3 align-text-bottom" aria-hidden />{prompt}
            </button> : <p className="opacity-60">{t("本次生成未使用提示词")}</p>}
            {prompt.length > 160 ? <button type="button" className="hover:underline" onClick={() => setExpanded(value => !value)}>{t(expanded ? "收起原提示词" : "展开原提示词")}</button> : null}
            {modified ? <div className="flex items-center justify-between gap-2" role="status"><span>{t("草稿已修改")}</span>{onRestorePrompt ? <button type="button" className="hover:underline disabled:opacity-40" disabled={disabled} onClick={onRestorePrompt}>{t("恢复原提示词")}</button> : null}</div> : null}
        </> : null}
        {onContinue || (record && onRegenerate) ? <div className="flex flex-wrap items-center gap-1">
            {record && onRegenerate ? <Button size="small" type="text" icon={<RotateCcw className="size-3.5" />} disabled={disabled} onClick={onRegenerate} title={t("使用原提示词、原参考图和原参数，新增结果，不覆盖当前图")}>{t("再来一张")}</Button> : null}
            {onContinue && (node.metadata?.content || node.metadata?.storageKey) ? <Button size="small" type="text" icon={<GitBranch className="size-3.5" />} disabled={disabled} onClick={onContinue} title={t("将当前图设为参考，清空草稿，原生成档案不变")}>{t("基于此图继续")}</Button> : null}
        </div> : null}
        {derivatives.length ? <details className="min-w-0" data-testid="canvas-generation-derivatives"><summary className="cursor-pointer py-1">{t("衍生（{count}）", { count: derivatives.length })}</summary>
            <div className="mt-1 max-h-40 space-y-1 overflow-y-auto">{derivatives.map(child => <button key={child.id} type="button" className="block w-full rounded px-1 py-1 text-left hover:bg-current/5" disabled={!onLocate} onClick={() => onLocate?.(child.id)} title={canvasGenerationPrompt(child)} aria-label={t("定位衍生图：{name}", { name: child.title })}><span className="block truncate font-medium">{child.title}</span><span className="line-clamp-2 whitespace-pre-wrap break-words leading-4 opacity-60">{canvasGenerationPrompt(child) || t("未使用提示词")}</span></button>)}</div>
        </details> : null}
    </section>;
}
