import type { ComponentProps } from "react";

export function CanvasPromptField({ canGenerate, onGenerate, onKeyDown, ...props }: ComponentProps<"textarea"> & {
    canGenerate: boolean; onGenerate: () => void;
}) {
    return <textarea className="cw-prompt" {...props} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        onKeyDown?.(event);
        if (event.defaultPrevented || event.key !== "Enter" || event.shiftKey) return;
        event.preventDefault();
        if (canGenerate && !event.repeat) onGenerate();
    }} />;
}
