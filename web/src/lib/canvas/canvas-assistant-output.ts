import type { CanvasAssistantMessage } from "@/types/canvas";

/** Display-only filtering. Never use the returned text as generation/history input. */
export function canvasAssistantDisplayText(text: string, hiddenPrompt?: string): string {
    let visible = text
        .replace(/<(think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/giu, "")
        .replace(/```(?:json)?[ \t]*\n([\s\S]*?)```/giu, (block, content: string) => /"(?:tool_calls|function|arguments|ops)"/u.test(content) ? "" : block);
    if (hiddenPrompt?.trim()) visible = visible.split(hiddenPrompt.trim()).join("");
    return visible
        .split("\n")
        .filter(line => !/^\s*(?:\[?tool(?:_call| result)?\]?\s*:|canvas_[a-z_]+\b)/iu.test(line))
        .join("\n")
        .replace(/\n{3,}/gu, "\n\n")
        .trim();
}

/** Strip internals from a render copy, retaining the original message and assets. */
const displayCache = new WeakMap<CanvasAssistantMessage, CanvasAssistantMessage | null>();
export function canvasAssistantDisplayMessage(message: CanvasAssistantMessage): CanvasAssistantMessage | null {
    if (displayCache.has(message)) return displayCache.get(message)!;
    const display = displayMessage(message);
    displayCache.set(message, display);
    return display;
}

function displayMessage(message: CanvasAssistantMessage): CanvasAssistantMessage | null {
    if (message.role === "user") return message;
    if (message.role === "system" || message.detail?.kind === "agent_tool_progress") return null;
    const detail = message.detail;
    if (message.role === "tool") {
        if (detail?.status === "pending" || detail?.status === "running") {
            return { ...message, title: "待确认操作", text: canvasAssistantDisplayText(message.text) || "请确认是否执行本次画布操作。", meta: undefined, detail: { status: detail.status, ...(detail.preview ? { preview: detail.preview } : {}) } };
        }
        const results = Array.isArray(detail?.results) ? detail.results : [];
        if (detail?.status === "completed" && !detail.mediaWorkflow && results.length && results.every(result => result && typeof result === "object" && "name" in result && ["edit_image", "generate_video"].includes(String(result.name)))) return null;
        // Keep an actionable workflow, but never its tool payload or execution log.
        return { ...message, role: detail?.status === "failed" ? "error" : "assistant", title: undefined, text: canvasAssistantDisplayText(message.text), meta: undefined, detail: { status: detail?.status, ...(detail?.turnId ? { turnId: detail.turnId } : {}), ...(detail?.mediaWorkflow ? { mediaWorkflow: detail.mediaWorkflow } : {}) } };
    }
    let text = canvasAssistantDisplayText(message.text);
    if (Array.isArray(detail?.hiddenPrompts)) {
        for (const hidden of detail.hiddenPrompts) if (typeof hidden === "string" && hidden.trim()) text = text.split(hidden.trim()).join("").trim();
    }
    if (detail?.kind === "agent_generation") {
        const video = message.attachments?.some(item => item.mediaType === "video") || (detail.settings && typeof detail.settings === "object" && "mode" in detail.settings && detail.settings.mode === "video");
        if (detail.status === "running") text = video ? "正在生成视频…" : "正在生成图片…";
        if (!text && detail.status === "completed") text = video ? "视频已生成。" : `已生成 ${message.attachments?.length || 1} 张图片。`;
    }
    if (!text && !message.attachments?.length && !detail?.mediaWorkflow) return null;
    return { ...message, text, detail: detail?.mediaWorkflow ? { mediaWorkflow: detail.mediaWorkflow } : undefined };
}

export {
    instructionsWithoutArtworkLiterals, transformImagePromptInstructions, isEnglishImagePrompt,
    CanvasImagePromptLanguageError, imagePromptInvariantNumbers, assertImagePromptInvariantCoverage, ensureEnglishImagePrompt,
} from "../../../../shared/image-prompt-invariants";
