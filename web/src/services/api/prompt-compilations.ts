import type { PromptInputData, PublicPromptCompilation } from "../../../../shared/prompt-contracts";
import { workspaceOwnerHeaders } from "./workspace-owner";
import { generationPreSubmissionMessage, generationSubmissionRejected } from "@/lib/generation-feedback";
import { observeTask, type observationDelay, TaskObservationStoppedError } from "./task-observation";

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

type PromptObservationTiming = { timeoutMs?: number; now?: () => number; delay?: typeof observationDelay };

export async function observePromptCompilation(requestId: string, options: PromptObservationTiming & { signal?: AbortSignal; compilation?: PublicPromptCompilation | null; cause?: unknown } = {}) {
    let compilation = options.compilation ?? null;
    let lookupError: unknown;
    try {
        const result = await observeTask({
            signal: options.signal, timeoutMs: options.timeoutMs ?? 210_000, intervalMs: 1_000, now: options.now, delay: options.delay,
            taskIds: [requestId],
            read: async signal => {
                try { compilation = await getPromptCompilation(requestId, signal); return compilation; }
                catch (error) { lookupError = error; throw error; }
            },
            done: value => value?.status !== "optimizing",
        });
        options.signal?.throwIfAborted();
        return completedPromptCompilation(result, requestId, options.cause);
    } catch (error) {
        if (error instanceof TaskObservationStoppedError || options.signal?.aborted) {
            throw new PromptCompilationUncertainError(requestId, compilation, options.cause ?? lookupError ?? error);
        }
        throw error;
    }
}

/** One POST only. A lost response is reconciled by the same request ID, never replayed. */
export async function createPromptCompilation(input: { requestId: string; modelConfigId: string; toolKey?: string; promptInput: PromptInputData; sourceUrls: string[] }, signal?: AbortSignal, timing: PromptObservationTiming = {}) {
    const now = timing.now ?? Date.now;
    const budget = timing.timeoutMs ?? 210_000;
    const deadline = now() + budget;
    const postTimeout = AbortSignal.timeout(Math.max(1, budget));
    const postSignal = signal ? AbortSignal.any([signal, postTimeout]) : postTimeout;
    let compilation: PublicPromptCompilation | null;
    let originalError: unknown;
    try {
        postSignal.throwIfAborted();
        const response = await fetch("/api/prompt-compilations", { method: "POST", credentials: "include", headers: { "content-type": "application/json", Prefer: "respond-async", ...workspaceOwnerHeaders() }, body: JSON.stringify(input), signal: postSignal });
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
        if (signal?.aborted) throw new PromptCompilationUncertainError(input.requestId, undefined, error);
        const remaining = deadline - now();
        const lookupTimeout = AbortSignal.timeout(remaining > 0 ? Math.min(20_000, remaining) : 5_000);
        const lookupSignal = signal ? AbortSignal.any([signal, lookupTimeout]) : lookupTimeout;
        compilation = await getPromptCompilation(input.requestId, lookupSignal).catch(() => null);
    }
    if (signal?.aborted) throw new PromptCompilationUncertainError(input.requestId, compilation, originalError ?? signal.reason);
    if (compilation?.status === "optimizing") return observePromptCompilation(input.requestId, { ...timing, signal, timeoutMs: Math.max(0, deadline - now()), compilation, cause: originalError });
    return completedPromptCompilation(compilation, input.requestId, originalError);
}
