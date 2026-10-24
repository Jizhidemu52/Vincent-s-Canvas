import type { PromptInputData, PublicPromptCompilation } from "../../../../shared/prompt-contracts";
import { workspaceOwnerHeaders } from "./workspace-owner";

export type { PromptInputData, PublicPromptCompilation };
export class PromptCompilationUncertainError extends Error {
    constructor(readonly requestId: string, readonly compilation?: PublicPromptCompilation | null) {
        super(compilation?.message || "提示词优化状态待核查，请查询原请求，不要重复提交。");
        this.name = "PromptCompilationUncertainError";
    }
}

export async function getPromptCompilation(requestId: string, signal?: AbortSignal): Promise<PublicPromptCompilation | null> {
    const response = await fetch(`/api/prompt-compilations/by-request/${encodeURIComponent(requestId)}`, { credentials: "include", headers: workspaceOwnerHeaders(), signal, cache: "no-store" });
    if (response.status === 404) return null;
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || body.msg || "无法查询提示词优化状态");
    return (body.data || body).compilation;
}

export function completedPromptCompilation(compilation: PublicPromptCompilation | null, requestId: string): PublicPromptCompilation & { prompt: string } {
    if (compilation?.status === "failed") throw new Error(compilation.message || "提示词优化失败，未提交图片生成");
    if (compilation?.status !== "success" || !compilation.prompt?.trim()) throw new PromptCompilationUncertainError(requestId, compilation);
    return compilation as PublicPromptCompilation & { prompt: string };
}

/** One POST only. A lost response is reconciled by the same request ID, never replayed. */
export async function createPromptCompilation(input: { requestId: string; modelConfigId: string; toolKey?: string; promptInput: PromptInputData; sourceUrls: string[] }, signal?: AbortSignal) {
    let compilation: PublicPromptCompilation | null;
    try {
        const response = await fetch("/api/prompt-compilations", { method: "POST", credentials: "include", headers: { "content-type": "application/json", ...workspaceOwnerHeaders() }, body: JSON.stringify(input), signal });
        const body = await response.json();
        if (!response.ok) {
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && !["PROMPT_OPTIMIZING", "PROMPT_SUBMISSION_UNCERTAIN"].includes(body.error || body.code)) throw Object.assign(new Error(body.message || body.msg || "提示词优化请求被拒绝"), { definitive: true });
            throw new Error(body.message || body.msg || "提示词优化响应异常");
        }
        compilation = (body.data || body).compilation;
    } catch (error) {
        if ((error as { definitive?: boolean })?.definitive) throw error;
        compilation = await getPromptCompilation(input.requestId).catch(() => null);
    }
    return completedPromptCompilation(compilation, input.requestId);
}
