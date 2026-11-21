import {useUiText} from "@/lib/i18n";
import {CanvasNodeType} from "@/types/canvas";
import {RefreshCw} from "lucide-react";
import type {ErrorContentProps} from "./canvas-node";
import { GenerationDiagnostic } from "@/components/generation-diagnostic";
import { imageResultProcessingFailureMessage, isImageResultProcessingFailure, mergeGenerationDiagnostics } from "@/lib/generation-feedback";

export default function NodeErrorDetails({node, theme, onRetry, onReload}: ErrorContentProps) {
    const t = useUiText();
    const videoRecovery = node.type === CanvasNodeType.Video && Boolean(node.metadata?.videoTaskId);
    const designExecution = !onReload && Boolean(node.metadata?.designTask);
    const rawError = node.metadata?.errorDetails || t("生成失败");
    const postprocess = !onReload && node.type === CanvasNodeType.Image
        && (node.metadata?.imageTask?.postprocessFailed || isImageResultProcessingFailure(rawError));
    const error = postprocess ? imageResultProcessingFailureMessage : rawError;
    const requestId = node.metadata?.imageTask?.requestId || node.metadata?.mediaTask?.requestId || node.metadata?.textRequestId;
    const details = mergeGenerationDiagnostics(error !== rawError ? rawError : undefined,
        requestId ? `requestId: ${requestId}` : undefined,
        ...[node.metadata?.imageTask?.taskId, node.metadata?.sourceTaskId, node.metadata?.mediaTask?.taskId, node.metadata?.videoTaskId]
            .filter(Boolean).map(taskId => `taskId: ${taskId}`));
    return (
        <div className="flex max-w-[260px] flex-col items-center gap-3 px-5 text-center">
            <div className="max-w-full text-xs leading-5" style={{ color: theme.node.muted }}>{onReload ? t("图片读取失败") : <GenerationDiagnostic error={error} details={details} />}</div>
            {designExecution && <p className="text-xs leading-5" style={{ color: theme.node.muted }}>{t("请在「创作任务」中查询或继续原请求。")}</p>}
            {!postprocess && !designExecution && <button
                type="button"
                aria-label={onReload ? t("重新加载图片") : undefined}
                disabled={videoRecovery && node.metadata?.videoTaskCanRecover === false}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition hover:scale-[1.02]"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                onClick={(event) => {
                    event.stopPropagation();
                    if (onReload) onReload();
                    else onRetry?.(node);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <RefreshCw className="size-3.5" />
                {onReload ? t("重新加载") : videoRecovery ? node.metadata?.videoTaskCanRecover === false ? t("提交状态待核查") : t("恢复查询") : node.metadata?.imageTask ? t("恢复查询") : t("重试")}
            </button>}
        </div>
    );
}
