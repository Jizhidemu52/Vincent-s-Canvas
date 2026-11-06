import { afterEach, expect, test } from "bun:test";
import { identifyProductCandidates, getProductCandidates, ProductCandidatesRejectedError } from "@/services/api/product-candidates";
import { useUserStore } from "@/stores/use-user-store";
import { deploymentFeatures } from "@/lib/deployment-features";

const originalFetch = globalThis.fetch;
const originalFeatures = { ...deploymentFeatures };
const originalSession = { user: useUserStore.getState().user, status: useUserStore.getState().status };
const requestId = "product-candidates:style-to-sketch:source:0";
const sourceAssetId = "00000000-0000-4000-8000-000000000001";
const base = { profile: "product-candidates", requestId, sourceAssetId, status: "success", candidates: [{ id: "candidate-1", name: "衬衫", brief: "左侧蓝色", evidence: "可见纽扣" }], createdAt: "2026-11-06T00:00:00Z", updatedAt: "2026-11-06T00:00:00Z" };

function setup(response: unknown, status = 200) {
    deploymentFeatures.authenticationEnabled = true;
    useUserStore.setState({ user: { id: "owner", role: "designer" } as never, status: "authenticated" });
    const calls: Array<{ path: string; body: unknown; owner: string | null; method: string }> = [];
    globalThis.fetch = (async (path, init) => { calls.push({ path: String(path), body: init?.body ? JSON.parse(String(init.body)) : null, owner: new Headers(init?.headers).get("X-Canvas-Owner-Id"), method: init?.method || "GET" }); return Response.json(response, { status }); }) as typeof fetch;
    return calls;
}

afterEach(() => { globalThis.fetch = originalFetch; Object.assign(deploymentFeatures, originalFeatures); useUserStore.setState(originalSession); });

test("recognition sends only one exact owner-bound source asset and empty freeform inputs", async () => {
    const calls = setup(base);
    expect((await identifyProductCandidates(requestId, sourceAssetId, "owner")).candidates).toHaveLength(1);
    expect(calls).toEqual([{ path: "/api/chat/responses", owner: "owner", method: "POST", body: { requestId, toolKey: "gpt-chat", profile: "product-candidates", profileContext: { sourceAssetId }, input: [], tools: [] } }]);
});

test("GET 404 is not treated as permission to retry and no POST or extra lookup occurs", async () => {
    const calls = setup({ message: "missing" }, 404);
    await expect(getProductCandidates(requestId, "owner")).rejects.toThrow("不代表未提交");
    expect(calls).toHaveLength(1); expect(calls[0]?.method).toBe("GET"); expect(calls[0]?.path).toContain("?profile=product-candidates");
});

test("network failure is surfaced once with no automatic recovery or paid retry", async () => {
    setup(base); let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error("network"); }) as typeof fetch;
    await expect(identifyProductCandidates(requestId, sourceAssetId, "owner")).rejects.toThrow("network");
    expect(calls).toBe(1);
});

test("only exact POST pre-claim code/status pairs are local rejections; query and Redis outages stay uncertain", async () => {
    setup({ error: "PROVIDER_NOT_CONFIGURED", message: "未配置" }, 503);
    await expect(identifyProductCandidates(requestId, sourceAssetId, "owner")).rejects.toBeInstanceOf(ProductCandidatesRejectedError);
    const queryError = await getProductCandidates(requestId, "owner").then(() => null, error => error);
    expect(queryError).toBeInstanceOf(Error); expect(queryError).not.toBeInstanceOf(ProductCandidatesRejectedError);
    for (const [error, status] of [["PRODUCT_CANDIDATES_RECEIPT_UNAVAILABLE", 503], ["PRODUCT_CANDIDATES_REQUEST_CHANGED", 409], ["MODEL_DISABLED", 503], ["GENERIC", 400]] as const) {
        setup({ error, message: "未发送识别请求" }, status);
        const caught = await identifyProductCandidates(requestId, sourceAssetId, "owner").then(() => null, rejected => rejected);
        expect(caught).toBeInstanceOf(Error); expect(caught).not.toBeInstanceOf(ProductCandidatesRejectedError);
    }
});

test.each([
    { ...base, requestId: "wrong" },
    { ...base, candidates: Array(9).fill(base.candidates[0]) },
    { ...base, candidates: [base.candidates[0], base.candidates[0]] },
    { ...base, candidates: [{ ...base.candidates[0], bounds: [0, 0, 1, 1] }] },
    { ...base, candidates: undefined },
])("invalid or duplicate candidates and mismatched receipts cannot enter the UI", async response => {
    const calls = setup(response);
    await expect(getProductCandidates(requestId, "owner")).rejects.toThrow();
    expect(calls).toHaveLength(1);
});

test("valid zero candidates is a completed result, not a retry trigger", async () => {
    setup({ ...base, candidates: [] });
    expect((await getProductCandidates(requestId, "owner")).candidates).toEqual([]);
});

test("a changed displayed employee prevents all outgoing recognition calls", async () => {
    const calls = setup(base);
    await expect(identifyProductCandidates(requestId, sourceAssetId, "other")).rejects.toThrow("员工会话已变化");
    expect(calls).toEqual([]);
});
