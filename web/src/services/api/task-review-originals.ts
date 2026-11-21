import { reissueReceipt, reviewOriginalReceipt, type ReviewOriginal } from "../../../../shared/task-review-originals";
export type { ReviewOriginal } from "../../../../shared/task-review-originals";
import { workspaceOwnerHeaders } from "./workspace-owner";
import { useUserStore } from "@/stores/use-user-store";

function assertOwner(owner: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (useUserStore.getState().user?.id !== owner) throw new Error("账号已切换，已停止读取原件");
}

async function get(path: string, owner: string, signal: AbortSignal) {
    assertOwner(owner, signal);
    return fetch(path, {
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        headers: workspaceOwnerHeaders(),
        signal,
    });
}

export async function listReviewOriginals(taskId: string, owner: string, signal: AbortSignal) {
    const response = await get(`/api/tasks/${encodeURIComponent(taskId)}/review-originals`, owner, signal);
    if (!response.ok) throw new Error("暂时无法核对原件，请刷新原件列表。");
    const result = reviewOriginalReceipt.parse(await response.json());
    assertOwner(owner, signal);
    if (result.taskId !== taskId) throw new Error("任务不匹配，已停止读取原件");
    return result;
}

export class ReissueNotSubmitted extends Error {}

export async function originalSizeReissue(taskId: string, owner: string, signal: AbortSignal, confirmation?: string) {
    assertOwner(owner, signal);
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/original-size-reissue`, {
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        signal,
        method: confirmation ? "POST" : "GET",
        headers: { ...workspaceOwnerHeaders(), ...(confirmation ? { "content-type": "application/json" } : {}) },
        body: confirmation ? JSON.stringify({ confirmation }) : undefined,
    });
    const body = await response.json();
    assertOwner(owner, signal);
    if (!response.ok) {
        const message = typeof body.message === "string" ? body.message : "暂时无法查询重出任务。";
        if (
            [404, 409].includes(response.status) &&
            ["ORIGINAL_SIZE_UNAVAILABLE", "REISSUE_QUOTE_CHANGED", "NOT_FOUND"].includes(body.error)
        )
            throw new ReissueNotSubmitted(message);
        throw new Error(message);
    }
    const result = reissueReceipt.parse(body);
    if ("quote" in result && result.quote.taskId !== taskId) throw new Error("原任务不匹配，未继续操作。");
    return result;
}

export async function readReviewOriginal(original: ReviewOriginal, owner: string, signal: AbortSignal) {
    const response = await get(`/api/assets/${original.assetId}/content`, owner, signal);
    if (response.status !== 200) throw new Error("暂时无法下载原件，请稍后重试。");
    const blob = await response.blob();
    assertOwner(owner, signal);
    if (blob.type !== original.mimeType || blob.size !== original.bytes)
        throw new Error("下载内容与原件记录不一致，未保存文件。");
    return blob;
}
