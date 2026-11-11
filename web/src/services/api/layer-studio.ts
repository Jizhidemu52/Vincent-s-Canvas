import type { LayerStudioOptions } from "../../../../shared/layer-studio-options";
import type { QueuedTask } from "./generation-tasks";
import { workspaceOwnerHeaders } from "./workspace-owner";
import { useUserStore } from "@/stores/use-user-store";

export type LayerStudioEstimate = { currency: "CNY"; estimatedPrecharge: number; maximumOutputs: number; sourceCount: number; priceVersion: number; employeeCredits: number; providerCharge: "unverified" };
export type LayerStudioSubmission = { requestId: string; projectId: string; operationType: "image_generation"; toolKey: "layer-studio"; prompt: string; parameters: LayerStudioOptions; sourceUrls: string[]; priority: "normal" };

export class LayerStudioApiError extends Error {
    constructor(readonly status: number, readonly code: string) {
        // A front-office page must not expose provider identities, including to admins.
        super(code === "PRICE_NOT_CONFIGURED" ? "费用尚未配置，暂不能创建新任务；已有结果仍可编辑和下载。"
            : status === 401 ? "登录已失效，请重新登录；原任务记录保留。"
                : status === 403 ? "当前功能未开放或没有访问权限；已有结果记录保留。"
                    : status === 400 || status === 422 ? "输入未通过检查，请核对图片、参数和费用配置。"
                        : "服务暂不可用；已提交的任务请只查询原记录，不要重复生成。");
        this.name = "LayerStudioApiError";
    }
    get rejected() { return [400, 401, 403, 422].includes(this.status) || ["PRICE_NOT_CONFIGURED", "TOOL_DISABLED", "TOOL_NOT_CONFIGURED"].includes(this.code); }
}

async function request<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(path, { method: "POST", credentials: "include", signal,
        headers: { "content-type": "application/json", ...workspaceOwnerHeaders() }, body: JSON.stringify(body) });
    if (!response.ok) {
        if (response.status === 401) useUserStore.getState().expireSession();
        const payload = await response.json().catch(() => ({})) as { error?: string; code?: string };
        throw new LayerStudioApiError(response.status, payload.error || payload.code || "REQUEST_FAILED");
    }
    return response.json() as Promise<T>;
}

/** Quote only. This endpoint never reserves funds or creates a generation. */
export async function estimateLayerStudio(parameters: LayerStudioOptions, sourceCount: number, signal?: AbortSignal) {
    const { estimate } = await request<{ estimate: LayerStudioEstimate }>("/api/layer-studio/estimate", { parameters, sourceCount }, signal);
    if (estimate.currency !== "CNY" || !Number.isFinite(estimate.estimatedPrecharge) || estimate.estimatedPrecharge < 0
        || !Number.isInteger(estimate.maximumOutputs) || estimate.maximumOutputs < 1) throw new Error("费用结果无效，未开放提交。");
    return estimate;
}

/** Intentionally one POST, no retry and no fallback model selection. */
export async function createLayerStudioTask(input: LayerStudioSubmission) {
    const { task } = await request<{ task: QueuedTask }>("/api/tasks", input);
    if (!task?.id || task.requestId !== input.requestId) throw new Error("提交结果待核查，请查询原任务。");
    return task;
}
