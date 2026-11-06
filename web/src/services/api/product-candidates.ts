import { productCandidatesResultSchema, type ProductCandidatesReceipt } from "../../../../shared/product-candidates";
import { workspaceOwnerHeaders } from "./workspace-owner";
import { useUserStore } from "@/stores/use-user-store";

const preSubmissionRejections: Record<string, number> = {
    PRODUCT_CANDIDATES_REQUEST_INVALID: 400,
    PRODUCT_CANDIDATES_SOURCE_FORBIDDEN: 403,
    PRODUCT_CANDIDATES_SOURCE_INVALID: 400,
    PRODUCT_CANDIDATES_SOURCE_CHANGED: 409,
    MODEL_DISABLED: 400,
    PROVIDER_NOT_CONFIGURED: 503,
    PROTOCOL_NOT_SUPPORTED: 400,
    PROMPT_REFERENCE_INVALID: 422,
};

export class ProductCandidatesRejectedError extends Error {
    readonly preSubmissionRejected = true;
    constructor(readonly code: string, message: string) { super(message); this.name = "ProductCandidatesRejectedError"; }
}

function validReceipt(value: unknown, requestId: string): ProductCandidatesReceipt {
    if (!value || typeof value !== "object") throw new Error("识别回执无效，请查询原请求，不要重复提交。");
    const receipt = value as ProductCandidatesReceipt;
    if (receipt.profile !== "product-candidates" || receipt.requestId !== requestId || typeof receipt.sourceAssetId !== "string"
        || !["processing", "success", "failed", "uncertain"].includes(receipt.status)
        || typeof receipt.createdAt !== "string" || typeof receipt.updatedAt !== "string") {
        throw new Error("识别回执与原请求不一致，请查询原请求。");
    }
    if (receipt.status === "success") {
        const parsed = productCandidatesResultSchema.safeParse({ candidates: receipt.candidates });
        if (!parsed.success) throw new Error("识别候选格式无效，请查询原请求或手动填写产品。");
        return { ...receipt, candidates: parsed.data.candidates };
    }
    return { ...receipt, candidates: undefined };
}

async function request(path: string, requestId: string, expectedOwnerId: string, init: RequestInit = {}) {
    if (useUserStore.getState().user?.id !== expectedOwnerId) throw new Error("员工会话已变化，未提交产品识别。");
    const response = await fetch(path, { ...init, credentials: "include", cache: "no-store", headers: { ...workspaceOwnerHeaders(), ...init.headers } });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
        if (response.status === 404) throw new Error("尚未查到原识别请求，不代表未提交；请继续查询或联系管理员，勿重复识别。");
        if (init.method === "POST" && typeof body?.error === "string" && preSubmissionRejections[body.error] === response.status) {
            throw new ProductCandidatesRejectedError(body.error, body.message || body.msg || "识别未提交，请检查素材或模型配置后再试。");
        }
        throw new Error(body?.message || body?.msg || "产品识别状态暂时未知，请查询原请求。");
    }
    return validReceipt(body, requestId);
}

/** Called only by the explicit paid recognition action; no implicit retries or polling. */
export function identifyProductCandidates(requestId: string, sourceAssetId: string, expectedOwnerId: string, signal?: AbortSignal) {
    return request("/api/chat/responses", requestId, expectedOwnerId, {
        method: "POST", signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, toolKey: "gpt-chat", profile: "product-candidates", profileContext: { sourceAssetId }, input: [], tools: [] }),
    });
}

export function getProductCandidates(requestId: string, expectedOwnerId: string, signal?: AbortSignal) {
    return request(`/api/chat/responses/${encodeURIComponent(requestId)}?profile=product-candidates`, requestId, expectedOwnerId, { signal });
}
