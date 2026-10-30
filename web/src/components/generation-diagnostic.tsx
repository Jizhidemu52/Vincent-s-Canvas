import { Button } from "antd";
import { useCopyText } from "@/hooks/use-copy-text";
import { uiText, useUiText } from "@/lib/i18n";
import { generationErrorMessage } from "@/lib/generation-feedback";

export function GenerationDiagnostic({ error, details }: { error: string; details?: string }) {
    useUiText();
    const copyText = useCopyText();
    return <div className="min-w-0 text-xs leading-5">
        <p role="alert" className="line-clamp-4 break-words">{uiText(generationErrorMessage(error))}</p>
        <Button size="small" type="link" onClick={() => void copyText([error, details].filter(Boolean).join("\n"), uiText("诊断信息已复制"))}>{uiText("复制诊断信息")}</Button>
    </div>;
}
