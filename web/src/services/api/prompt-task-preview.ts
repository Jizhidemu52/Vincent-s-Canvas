import type { PromptInputData } from "../../../../shared/prompt-contracts";
import { useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { confirmPromptExecution, promptExecutionContextRevision, usePromptExecutionPreview, type PromptExecutionPreview, PromptPreviewCancelledError } from "@/stores/use-prompt-execution-preview";
import { workspaceOwnerHeaders } from "./workspace-owner";
import { PromptCompilationUncertainError } from "./prompt-compilations";

type PreviewTask = {
    requestId: string; modelConfigId?: string; prompt?: string; promptInput?: PromptInputData;
    operationType: string; parameters: Record<string, unknown>; sourceUrls: string[];
};
type PreparedPreview = { prompt: string; promptInput: PromptInputData; summaryZh?: string; nativeNegativePrompt?: string };
const settingsIdentity = () => {
    const { promptPreview: _preview, ...config } = useConfigStore.getState().config;
    return JSON.stringify(config);
};
const pageIdentity = () => typeof window === "undefined" ? "" : `${window.location.pathname}${window.location.search}`;

export function promptPreviewReferences(sourceUrls: readonly string[], input: PromptInputData, names: readonly string[], maskIndex?: number, markupIndex?: number): PromptExecutionPreview["references"] {
    let imageIndex = 0;
    return sourceUrls.map((url, index) => {
        const auxiliary = index === maskIndex ? "编辑蒙版（不参与图片编号）" : index === markupIndex ? "圈选标注（不参与图片编号）" : undefined;
        const roleIndex = input.referenceRoles?.length === sourceUrls.length ? index : imageIndex;
        return { url, name: names[index] || "", label: auxiliary || `图片${++imageIndex}：${input.referenceRoles?.[roleIndex] || (imageIndex === 1 ? "要处理的原图" : "仅参考明确指定的内容")}` };
    });
}

/** Compile exactly once, then submit the same immutable input with the returned compilationId. */
export async function confirmImageTaskPreview<T extends PreviewTask>(task: T, options: {
    modelName: string; references: PromptExecutionPreview["references"]; signal?: AbortSignal; batchCount?: number;
}): Promise<T> {
    if (!task.promptInput || useConfigStore.getState().config.promptPreview !== true) return task;
    const ownerId = useUserStore.getState().user?.id;
    const configIdentity = settingsIdentity(), routeIdentity = pageIdentity();
    const navigationRevision = promptExecutionContextRevision();
    const fingerprint = JSON.stringify(task);
    let invalidated = false;
    const assertCurrent = () => {
        options.signal?.throwIfAborted();
        const session = useUserStore.getState();
        if (invalidated || !ownerId || session.user?.id !== ownerId || session.status !== "authenticated" || session.user.status !== "active"
            || settingsIdentity() !== configIdentity || pageIdentity() !== routeIdentity || promptExecutionContextRevision() !== navigationRevision || JSON.stringify(task) !== fingerprint) {
            throw new PromptPreviewCancelledError("输入、页面、模型设置或员工会话已变化，旧预览已失效；未提交图片任务。");
        }
    };
    const check = () => {
        try { assertCurrent(); } catch {
            invalidated = true;
            const pending = usePromptExecutionPreview.getState().pending;
            if (pending?.requestId === task.requestId) pending.finish(false);
        }
    };
    assertCurrent();
    const stopUser = useUserStore.subscribe(check), stopConfig = useConfigStore.subscribe(check);
    try {
        let response: Response;
        try {
            response = await fetch("/api/tasks/preview", { method: "POST", credentials: "include", headers: { "content-type": "application/json", ...workspaceOwnerHeaders() }, body: fingerprint, signal: options.signal });
        } catch (error) {
            assertCurrent();
            // No task has been admitted. Never repeat a possibly paid planner request automatically.
            throw new PromptCompilationUncertainError(task.requestId, undefined, error);
        }
        const body = await response.json() as { preview?: PreparedPreview; message?: string; msg?: string };
        assertCurrent();
        if (!response.ok) throw new Error(body.message || body.msg || "无法准备生成预览，未提交图片任务。");
        const preview = body.preview;
        if (!preview?.prompt?.trim() || typeof preview.promptInput?.compilationId !== "string") throw new PromptCompilationUncertainError(task.requestId);
        await confirmPromptExecution({ requestId: task.requestId, ownerId: ownerId!, modelName: options.modelName,
            prompt: preview.prompt, summaryZh: preview.summaryZh, nativeNegativePrompt: preview.nativeNegativePrompt,
            references: options.references, batchCount: options.batchCount }, { signal: options.signal, assertCurrent });
        assertCurrent();
        return { ...task, promptInput: preview.promptInput };
    } finally { stopUser(); stopConfig(); }
}
