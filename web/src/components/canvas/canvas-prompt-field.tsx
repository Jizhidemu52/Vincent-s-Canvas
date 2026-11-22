import type { ComponentProps } from "react";

export function CanvasPromptField({ canGenerate, onGenerate, onKeyDown, className, ...props }: ComponentProps<"textarea"> & {
    canGenerate: boolean; onGenerate: () => void;
}) {
    return <textarea {...props} className={className ? `cw-prompt ${className}` : "cw-prompt"} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        onKeyDown?.(event);
        if (event.defaultPrevented || event.key !== "Enter" || event.shiftKey) return;
        event.preventDefault();
        if (canGenerate && !event.repeat) onGenerate();
    }} />;
}
