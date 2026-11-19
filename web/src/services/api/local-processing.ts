import { v5 as uuidV5 } from "uuid";
import { localProcessingBoards, localProcessingInputSchema, type LocalProcessingBoard, type LocalProcessingInput, type LocalProcessingPage, type LocalProcessingRecord } from "../../../../shared/local-processing-contracts";
import { useUserStore } from "@/stores/use-user-store";
import { notifyAssetsChanged } from "@/services/asset-changes";
import { fingerprintImage } from "./generation-history";
import { assertHistoryOwner } from "./generation-task-history";
import { uploadServerAsset } from "./server-assets";

export type LocalProcessingArchive = Omit<LocalProcessingInput, "assetId">;

export function localProcessingBoard(board: string): LocalProcessingBoard | null {
    return localProcessingBoards.includes(board as LocalProcessingBoard) ? board as LocalProcessingBoard : null;
}

export function compositeOperationId(taskId: string, resultIdentity: string | number) {
    return uuidV5(`trucreate:selection-composite:v1:${taskId}:${resultIdentity}`, uuidV5.URL);
}

function assertOwner(ownerId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    assertHistoryOwner(ownerId);
    if (useUserStore.getState().user?.status !== "active") throw new Error("当前账号不可用，已停止保存最终成果");
}

function validRecord(value: LocalProcessingRecord, ownerId: string, board: LocalProcessingBoard) {
    if (!value || value.version !== 1 || value.ownerUserId !== ownerId || value.board !== board
        || value.id !== value.outputAssetId || value.contentUrl !== `/api/assets/${value.id}/content`
        || !value.mimeType?.startsWith("image/") || !Number.isSafeInteger(value.byteSize) || value.byteSize <= 0
        || !/^[a-f0-9]{64}$/.test(value.contentSha256) || !Number.isFinite(Date.parse(value.createdAt))) return false;
    return localProcessingInputSchema.safeParse({ clientOperationId: value.clientOperationId, assetId: value.sourceOutputAssetId,
        board: value.board, operation: value.operation, prompt: value.prompt, parameters: value.parameters,
        sourceAssetIds: value.sourceAssetIds, ...(value.sourceTaskId ? { sourceTaskId: value.sourceTaskId } : {}) }).success;
}

export async function listLocalProcessing(board: LocalProcessingBoard, ownerId: string, options: { cursor?: string; clientOperationId?: string; signal?: AbortSignal } = {}): Promise<LocalProcessingPage> {
    assertOwner(ownerId, options.signal);
    const query = new URLSearchParams({ board, limit: "30", ...(options.cursor ? { cursor: options.cursor } : {}), ...(options.clientOperationId ? { clientOperationId: options.clientOperationId } : {}) });
    const response = await fetch(`/api/assets/local-processing?${query}`, { credentials: "include", cache: "no-store", redirect: "error", headers: { "X-Canvas-Owner-Id": ownerId }, signal: options.signal });
    assertOwner(ownerId, options.signal);
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "会话已失效或无权查看本地处理记录" : "已保存的本地处理记录暂时无法读取，请重试");
    const page = await response.json() as LocalProcessingPage;
    assertOwner(ownerId, options.signal);
    if (!page || !Array.isArray(page.records) || page.records.some(record => !validRecord(record, ownerId, board)
        || options.clientOperationId && record.clientOperationId !== options.clientOperationId)
        || typeof page.hasMore !== "boolean" || page.nextCursor !== null && typeof page.nextCursor !== "string"
        || page.hasMore !== Boolean(page.nextCursor)) throw new Error("处理记录归属或分页信息异常，未显示任何跨账号数据");
    return page;
}

function stableJson(value: unknown): string {
    return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
}

function matchingArchive(record: LocalProcessingRecord, input: LocalProcessingArchive, hash: string) {
    return record.clientOperationId === input.clientOperationId && record.contentSha256 === hash
        && record.operation === input.operation && record.prompt === input.prompt && record.sourceTaskId === (input.sourceTaskId ?? null)
        && stableJson(record.parameters) === stableJson(input.parameters) && stableJson(record.sourceAssetIds) === stableJson(input.sourceAssetIds);
}

export async function archiveLocalProcessing(file: File, input: LocalProcessingArchive, ownerId: string, signal?: AbortSignal): Promise<LocalProcessingRecord> {
    assertOwner(ownerId, signal);
    const parsed = localProcessingInputSchema.safeParse({ ...input, assetId: "00000000-0000-4000-8000-000000000000" });
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || "最终成果归档参数不完整");
    if (!file.size || !file.type.startsWith("image/")) throw new Error("最终成果必须是有效图片");
    const { assetId: _placeholder, ...archive } = parsed.data;
    const contentSha256 = await fingerprintImage(file);
    assertOwner(ownerId, signal);
    const previous = await listLocalProcessing(archive.board, ownerId, { clientOperationId: archive.clientOperationId, signal });
    if (previous.records.length) {
        if (previous.records.length !== 1 || !matchingArchive(previous.records[0], archive, contentSha256)) throw new Error("此处理编号已保存其他内容，已停止覆盖原成果");
        return previous.records[0];
    }
    const assetId = await uploadServerAsset(file, { title: file.name, source: "本地处理最终成果", contentSha256 },
        { localProcessingOperationId: archive.clientOperationId, expectedOwnerId: ownerId, signal });
    assertOwner(ownerId, signal);
    const response = await fetch("/api/assets/local-processing", { method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "content-type": "application/json", "X-Canvas-Owner-Id": ownerId }, body: JSON.stringify({ ...archive, assetId }), signal });
    assertOwner(ownerId, signal);
    if (!response.ok) {
        const failure = await response.json().catch(() => ({})) as { message?: string; msg?: string };
        assertOwner(ownerId, signal);
        throw new Error(failure.message || failure.msg || "最终图片已上传，但处理记录尚未确认保存；可重试保存，不会重新生成");
    }
    const payload = await response.json() as { record: LocalProcessingRecord; reused: boolean };
    assertOwner(ownerId, signal);
    if (!validRecord(payload.record, ownerId, archive.board) || !matchingArchive(payload.record, archive, contentSha256)) throw new Error("最终成果保存回执不匹配，请重试核对；不会重新生成");
    notifyAssetsChanged(ownerId);
    return payload.record;
}
