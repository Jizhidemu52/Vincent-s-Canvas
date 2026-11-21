import { reviewOriginalReceipt, type ReviewOriginal } from "../../../../shared/task-review-originals";
export type { ReviewOriginal } from "../../../../shared/task-review-originals";
import { workspaceOwnerHeaders } from "./workspace-owner";
import { useUserStore } from "@/stores/use-user-store";


function assertOwner(owner: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (useUserStore.getState().user?.id !== owner) throw new Error("账号已切换，已停止读取原件");
}

async function get(path: string, owner: string, signal: AbortSignal) {
    assertOwner(owner, signal);
    return fetch(path, { credentials: "include", cache: "no-store", redirect: "error", headers: workspaceOwnerHeaders(), signal });
}

export async function listReviewOriginals(taskId: string, owner: string, signal: AbortSignal) {
    const response = await get(`/api/tasks/${encodeURIComponent(taskId)}/review-originals`, owner, signal);
    if (!response.ok) throw new Error("暂时无法核对原件，请刷新原件列表。");
    const result = reviewOriginalReceipt.parse(await response.json());
    assertOwner(owner, signal);
    if (result.taskId !== taskId) throw new Error("任务不匹配，已停止读取原件");
    return result.originals;
}

export async function readReviewOriginal(original: ReviewOriginal, owner: string, signal: AbortSignal) {
    const response = await get(`/api/assets/${original.assetId}/content`, owner, signal);
    if (response.status !== 200) throw new Error("暂时无法下载原件，请稍后重试。");
    const blob = await response.blob();
    assertOwner(owner, signal);
    if (blob.type !== original.mimeType || blob.size !== original.bytes) throw new Error("下载内容与原件记录不一致，未保存文件。");
    return blob;
}
