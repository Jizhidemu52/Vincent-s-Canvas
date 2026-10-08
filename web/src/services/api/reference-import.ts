import type { ReferencePayload } from "@/pages/reference-import/protocol";

export type ReferenceScan = {
    scanId: string;
    pageUrl: string;
    pageTitle: string;
    candidates: { id: string; name: string; sourceImage: string }[];
    expiresAt: string;
    warnings: string[];
};

export class ReferenceRequestError extends Error {
    constructor(message: string, public readonly status: number) {
        super(message);
        this.name = "ReferenceRequestError";
    }
}

async function request<T>(path: string, body: object, ownerId: string, signal: AbortSignal): Promise<T> {
    if (!ownerId) throw new ReferenceRequestError("请先完成登录", 401);
    const response = await fetch(`/api/reference-import/${path}`, {
        method: "POST", credentials: "include", signal,
        headers: { "Content-Type": "application/json", "X-Canvas-Owner-Id": ownerId },
        body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => null) as { code: number; data: T; msg: string } | null;
    signal.throwIfAborted();
    if (!response.ok || !result || result.code !== 0 || !result.data) {
        throw new ReferenceRequestError(result?.msg || "网页采集请求失败，请稍后重试", response.ok ? (result?.code || 502) : response.status);
    }
    return result.data;
}

export const scanReferencePage = (url: string, ownerId: string, signal: AbortSignal) => request<ReferenceScan>("scan", { url }, ownerId, signal);
export const fetchReferenceImage = (scanId: string, imageId: string, ownerId: string, signal: AbortSignal) => request<ReferencePayload>("image", { scanId, imageId }, ownerId, signal);
