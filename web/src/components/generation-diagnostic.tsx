import { Button } from "antd";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { uiText, useUiText } from "@/lib/i18n";
import { generationErrorMessage, isImageResultProcessingFailure, mergeGenerationDiagnostics } from "@/lib/generation-feedback";
import { DisplayText } from "@/hooks/use-display-text";

export function GenerationDiagnostic({ error, details, displayContext = "generation" }: { error: string; details?: string; displayContext?: "generation" | "chat" }) {
    useUiText();
    const clipboard = useCopyFeedback();
    return <div className="min-w-0 text-xs leading-5">
        <p role="alert" className={displayContext === "chat" ? "break-words" : "line-clamp-4 break-words"}><DisplayText text={displayContext === "chat" ? error : generationErrorMessage(error)} /></p>
        {isImageResultProcessingFailure(error) && <Button size="small" type="link" href="/assets">{uiText("查看素材库原件")}</Button>}
        <Button size="small" type="link" aria-label={uiText("复制诊断信息")} onClick={() => void clipboard.copy(mergeGenerationDiagnostics(error, details))}>{uiText(clipboard.copied ? "已复制 ✓" : "复制诊断信息")}</Button>
    </div>;
}
