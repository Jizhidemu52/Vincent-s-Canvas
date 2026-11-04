import type { PromptInputData, PublicPromptCompilation } from "../../../../shared/prompt-contracts";
import { workspaceOwnerHeaders } from "./workspace-owner";
import { generationPreSubmissionMessage, generationSubmissionRejected } from "@/lib/generation-feedback";

export type { PromptInputData, PublicPromptCompilation };
export class PromptCompilationUncertainError extends Error {
    constructor(readonly requestId: string, readonly compilation?: PublicPromptCompilation | null, readonly cause?: unknown) {
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

export function completedPromptCompilation(compilation: PublicPromptCompilation | null, requestId: string, cause?: unknown): PublicPromptCompilation & { prompt: string } {
    if (compilation?.status === "failed") throw new Error(compilation.message || "提示词优化失败，未提交图片生成");
    if (compilation?.status !== "success" || !compilation.prompt?.trim()) throw new PromptCompilationUncertainError(requestId, compilation, cause);
    return compilation as PublicPromptCompilation & { prompt: string };
}

/** One POST only. A lost response is reconciled by the same request ID, never replayed. */
export async function createPromptCompilation(input: { requestId: string; modelConfigId: string; toolKey?: string; promptInput: PromptInputData; sourceUrls: string[] }, signal?: AbortSignal) {
    let compilation: PublicPromptCompilation | null;
    let originalError: unknown;
    try {
        const response = await fetch("/api/prompt-compilations", { method: "POST", credentials: "include", headers: { "content-type": "application/json", ...workspaceOwnerHeaders() }, body: JSON.stringify(input), signal });
        const body = await response.json();
        if (!response.ok) {
            const code = body.error || body.code;
            const diagnostic = body.message || body.msg || "提示词优化响应异常";
            throw Object.assign(new Error(generationPreSubmissionMessage(code) || diagnostic), { definitive: generationSubmissionRejected(response.status, code), status: response.status, code, diagnostic, requestId: input.requestId });
        }
        compilation = (body.data || body).compilation;
    } catch (error) {
        if ((error as { definitive?: boolean })?.definitive) throw error;
        originalError = error;
        compilation = await getPromptCompilation(input.requestId).catch(() => null);
    }
    return completedPromptCompilation(compilation, input.requestId, originalError);
}
