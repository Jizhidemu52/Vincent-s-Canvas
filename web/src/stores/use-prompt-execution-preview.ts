import { create } from "zustand";

export type PromptExecutionPreview = {
    requestId: string;
    ownerId: string;
    modelName: string;
    prompt: string;
    summaryZh?: string;
    nativeNegativePrompt?: string;
    references: Array<{ url: string; name: string; label: string }>;
    batchCount?: number;
};
export class PromptPreviewCancelledError extends Error {
    constructor(message = "已取消生成前确认，未提交图片任务。") { super(message); this.name = "PromptPreviewCancelledError"; }
}
type Pending = PromptExecutionPreview & { finish: (accepted: boolean) => void };
export const usePromptExecutionPreview = create<{ pending: Pending | null }>(() => ({ pending: null }));

/** Transient dialog state only: never persisted and only one confirmation may own the screen. */
export function confirmPromptExecution(preview: PromptExecutionPreview, options: { signal?: AbortSignal; assertCurrent: () => void }) {
    options.signal?.throwIfAborted();
    options.assertCurrent();
    if (usePromptExecutionPreview.getState().pending) throw new PromptPreviewCancelledError("请先处理当前生成前确认，未重复提交图片任务。");
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const abort = () => finish(false);
        const finish = (accepted: boolean) => {
            if (settled) return;
            settled = true;
            options.signal?.removeEventListener("abort", abort);
            if (usePromptExecutionPreview.getState().pending?.requestId === preview.requestId) usePromptExecutionPreview.setState({ pending: null });
            if (!accepted) { reject(new PromptPreviewCancelledError()); return; }
            try { options.signal?.throwIfAborted(); options.assertCurrent(); resolve(); } catch (error) { reject(error); }
        };
        usePromptExecutionPreview.setState({ pending: { ...preview, finish } });
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) finish(false);
    });
}

export function cancelPromptExecutionPreview() { usePromptExecutionPreview.getState().pending?.finish(false); }

let contextRevision = 0;
export function promptExecutionContextRevision() { return contextRevision; }
export function invalidatePromptExecutionContext() { contextRevision++; cancelPromptExecutionPreview(); }
