import { Button } from "antd";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { uiText, useUiText } from "@/lib/i18n";
import { generationErrorMessage, isImageResultProcessingFailure, mergeGenerationDiagnostics } from "@/lib/generation-feedback";

export function GenerationDiagnostic({ error, details }: { error: string; details?: string }) {
    useUiText();
    const clipboard = useCopyFeedback();
    return <div className="min-w-0 text-xs leading-5">
        <p role="alert" className="line-clamp-4 break-words">{uiText(generationErrorMessage(error))}</p>
        {isImageResultProcessingFailure(error) && <Button size="small" type="link" href="/assets">{uiText("查看素材库原件")}</Button>}
        <Button size="small" type="link" aria-label={uiText("复制诊断信息")} onClick={() => void clipboard.copy(mergeGenerationDiagnostics(error, details))}>{uiText(clipboard.copied ? "已复制 ✓" : "复制诊断信息")}</Button>
    </div>;
}
