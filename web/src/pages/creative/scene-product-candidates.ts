import type { ProductCandidatesReceipt } from "../../../../shared/product-candidates";
import { ProductCandidatesRejectedError } from "@/services/api/product-candidates";

export type SceneProductCandidateRecord = {
    version: 1;
    ownerId: string;
    sceneId: string;
    sourceId: string;
    sourceAssetId: string;
    requestId: string;
    attempt: number;
    previousReceipts?: ProductCandidatesReceipt[];
    rejection?: { code: string; message: string };
    previousRejections?: Array<{ code: string; message: string }>;
    receipt?: ProductCandidatesReceipt;
    error?: string;
};

type Storage = {
    getItem<T>(key: string): Promise<T | null>;
    setItem<T>(key: string, value: T): Promise<T>;
};

type Dependencies = {
    storage: Storage;
    assertCurrent: () => void;
    upload: (requestId: string, signal?: AbortSignal) => Promise<string>;
    submit: (requestId: string, sourceAssetId: string, signal?: AbortSignal) => Promise<ProductCandidatesReceipt>;
    query: (requestId: string, signal?: AbortSignal) => Promise<ProductCandidatesReceipt>;
};

/** One source has one paid request identity. Refresh, double-click and GET 404 cannot mint a new one. */
export function createSceneProductCandidates(ownerId: string, sceneId: string, sourceId: string, deps: Dependencies) {
    const key = [ownerId, sceneId, sourceId].map(encodeURIComponent).join(":");
    const requestBase = `product-candidates:${sceneId}:${sourceId}`;
    let busy = false;
    const read = async () => {
        deps.assertCurrent();
        const record = await deps.storage.getItem<SceneProductCandidateRecord>(key);
        deps.assertCurrent();
        if (record && (record.version !== 1 || record.ownerId !== ownerId || record.sceneId !== sceneId || record.sourceId !== sourceId || !Number.isSafeInteger(record.attempt) || record.attempt < 0 || record.requestId !== `${requestBase}:${record.attempt}`)) {
            throw new Error("产品识别记录不属于当前素材，请保留记录并联系管理员核查。");
        }
        return record;
    };
    const write = async (record: SceneProductCandidateRecord) => {
        deps.assertCurrent();
        await deps.storage.setItem(key, record);
        deps.assertCurrent();
        return record;
    };
    const finish = async (record: SceneProductCandidateRecord, response: () => Promise<ProductCandidatesReceipt>) => {
        try {
            const receipt = await response();
            deps.assertCurrent();
            if (receipt.requestId !== record.requestId || receipt.sourceAssetId !== record.sourceAssetId) throw new Error("识别回执与原请求不一致，不能使用这个结果。");
            const current = await read();
            if (current && current.requestId !== record.requestId) return current;
            return await write({ ...record, receipt, error: undefined, rejection: undefined });
        } catch (error) {
            const current = await read();
            if (current && current.requestId !== record.requestId) return current;
            return write({ ...record, ...(error instanceof ProductCandidatesRejectedError ? { rejection: { code: error.code, message: error.message } } : {}), error: error instanceof Error ? error.message : "识别状态暂时未知，请查询原请求。" });
        }
    };
    return {
        read,
        async identify(signal?: AbortSignal, retryFailed = false) {
            if (busy) return null;
            busy = true;
            try {
                const existing = await read();
                if (existing && (!retryFailed || (existing.receipt?.status !== "failed" && !existing.rejection))) return existing;
                // A pre-claim rejection reuses the ID: another tab could already
                // have claimed it. Only a real terminal failed receipt advances.
                const attempt = existing ? existing.attempt + (existing.receipt?.status === "failed" ? 1 : 0) : 0;
                const requestId = `${requestBase}:${attempt}`;
                signal?.throwIfAborted();
                const sourceAssetId = existing?.sourceAssetId || await deps.upload(requestId, signal);
                deps.assertCurrent();
                signal?.throwIfAborted();
                const record = await write({ version: 1, ownerId, sceneId, sourceId, sourceAssetId, requestId, attempt,
                    ...(existing ? { previousReceipts: [...(existing.previousReceipts || []), ...(existing.receipt ? [existing.receipt] : [])],
                        previousRejections: [...(existing.previousRejections || []), ...(existing.rejection ? [existing.rejection] : [])] } : {}),
                });
                // The durable tracking record must exist before the potentially paid POST.
                deps.assertCurrent();
                signal?.throwIfAborted();
                return await finish(record, () => deps.submit(requestId, sourceAssetId, signal));
            } finally { busy = false; }
        },
        async query(signal?: AbortSignal) {
            if (busy) return null;
            busy = true;
            try {
                const record = await read();
                if (!record) throw new Error("没有可查询的原识别请求。");
                signal?.throwIfAborted();
                return await finish(record, () => deps.query(record.requestId, signal));
            } finally { busy = false; }
        },
    };
}
