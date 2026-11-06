import { expect, test } from "bun:test";
import { createSceneProductCandidates, type SceneProductCandidateRecord } from "@/pages/creative/scene-product-candidates";
import type { ProductCandidatesReceipt } from "../../shared/product-candidates";
import { ProductCandidatesRejectedError } from "@/services/api/product-candidates";

const asset = "00000000-0000-4000-8000-000000000001";
const candidate = { id: "candidate-1", name: "蓝色衬衫", brief: "位于左侧", evidence: "可见蓝色领口与门襟" };
function harness() {
    const saved = new Map<string, SceneProductCandidateRecord>();
    const calls: string[] = [];
    let current = true;
    let status: ProductCandidatesReceipt["status"] = "success";
    let thrown: string | Error | null = null;
    let hold: (() => Promise<void>) | null = null;
    let failSave = false;
    const receipt = (requestId: string): ProductCandidatesReceipt => ({ profile: "product-candidates", requestId, sourceAssetId: asset, status, candidates: status === "success" ? [candidate] : undefined, createdAt: "2026-11-06T00:00:00Z", updatedAt: "2026-11-06T00:00:01Z" });
    const make = () => createSceneProductCandidates("owner", "style-to-sketch", "source", {
        storage: { getItem: async <T>(key: string) => structuredClone(saved.get(key) ?? null) as T | null,
            setItem: async <T>(key: string, value: T) => { if (failSave) throw new Error("storage full"); saved.set(key, structuredClone(value as SceneProductCandidateRecord)); return value; } },
        assertCurrent: () => { if (!current) throw new Error("owner changed"); },
        upload: async () => { calls.push("upload"); return asset; },
        submit: async requestId => {
            calls.push(`POST ${requestId}`);
            expect([...saved.values()][0]?.requestId).toBe(requestId);
            if (hold) await hold();
            if (thrown) throw typeof thrown === "string" ? new Error(thrown) : thrown;
            return receipt(requestId);
        },
        query: async requestId => { calls.push(`GET ${requestId}`); if (thrown) throw typeof thrown === "string" ? new Error(thrown) : thrown; return receipt(requestId); },
    });
    return { make, saved, calls, setStatus: (value: typeof status) => { status = value; }, setError: (value: string | Error | null) => { thrown = value; }, setHold: (value: typeof hold) => { hold = value; }, changeOwner: () => { current = false; }, failSaving: () => { failSave = true; } };
}

test("recognition is explicit, persisted before POST and never repeated after refresh", async () => {
    const app = harness(); const first = app.make();
    expect(await first.read()).toBeNull(); expect(app.calls).toEqual([]);
    const record = await first.identify();
    expect(record?.receipt?.candidates).toEqual([candidate]);
    expect(app.calls.filter(call => call.startsWith("POST"))).toHaveLength(1);
    const refreshed = app.make();
    expect(await refreshed.read()).toEqual(record);
    await refreshed.identify();
    expect(app.calls.filter(call => call.startsWith("POST"))).toHaveLength(1);
});

test("double clicking while a POST is pending cannot start another request", async () => {
    const app = harness(), gate = Promise.withResolvers<void>(); app.setHold(() => gate.promise);
    const controller = app.make();
    const pending = controller.identify();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await controller.identify()).toBeNull();
    gate.resolve(); await pending;
    expect(app.calls.filter(call => call.startsWith("POST"))).toHaveLength(1);
});

test.each(["processing", "uncertain"] as const)("%s receipts can only query their original ID", async status => {
    const app = harness(); app.setStatus(status);
    const controller = app.make(); const record = await controller.identify();
    await controller.identify(undefined, true); await controller.query();
    expect(app.calls.filter(call => call.startsWith("POST"))).toEqual([`POST ${record?.requestId}`]);
    expect(app.calls.at(-1)).toBe(`GET ${record?.requestId}`);
});

test("lost response and GET 404 keep the request and cannot generate a new attempt", async () => {
    const app = harness(); app.setError("lost response");
    const first = await app.make().identify();
    expect(first?.error).toBe("lost response");
    app.setError("404 not found");
    const refreshed = app.make(); await refreshed.query(); await refreshed.identify(undefined, true);
    const stored = [...app.saved.values()][0]!;
    expect(stored.requestId).toBe(first?.requestId); expect(stored.attempt).toBe(0);
    expect(app.calls.filter(call => call.startsWith("POST"))).toHaveLength(1);
});

test("only an explicit retry after terminal failed gets a new stable attempt and preserves the prior receipt", async () => {
    const app = harness(); app.setStatus("failed"); const controller = app.make();
    const first = await controller.identify();
    await controller.identify();
    expect(app.calls.filter(call => call.startsWith("POST"))).toHaveLength(1);
    app.setStatus("success"); const second = await controller.identify(undefined, true);
    expect(second?.attempt).toBe(1); expect(second?.requestId).toBe(`${first?.requestId.slice(0, -1)}1`);
    expect(second?.previousReceipts).toEqual([first?.receipt]);
    expect(app.calls.filter(call => call === "upload")).toHaveLength(1);
    expect(app.calls.filter(call => call.startsWith("POST"))).toHaveLength(2);
});

test("storage failure and an owner change stop before a paid request", async () => {
    const app = harness(); app.failSaving();
    await expect(app.make().identify()).rejects.toThrow("storage full");
    expect(app.calls.filter(call => call.startsWith("POST"))).toHaveLength(0);
    const changed = harness(); changed.changeOwner();
    await expect(changed.make().identify()).rejects.toThrow("owner changed");
    expect(changed.calls).toEqual([]);
});

test("a definitive pre-claim rejection only permits an explicit same-ID retry and preserves its code", async () => {
    const app = harness(); app.setError(new ProductCandidatesRejectedError("PROVIDER_NOT_CONFIGURED", "未配置"));
    const controller = app.make(); const first = await controller.identify();
    expect(first?.rejection?.code).toBe("PROVIDER_NOT_CONFIGURED");
    expect(first?.receipt).toBeUndefined();
    await controller.identify(); expect(app.calls.filter(call => call.startsWith("POST"))).toHaveLength(1);
    app.setError(null);
    const second = await controller.identify(undefined, true);
    expect(second?.attempt).toBe(0); expect(second?.requestId).toBe(first?.requestId);
    expect(second?.previousRejections).toEqual([first?.rejection]);
    expect(app.calls.filter(call => call.startsWith("POST"))).toEqual([`POST ${first?.requestId}`, `POST ${first?.requestId}`]);
});

test("a foreign source record is rejected without upload or request", async () => {
    const app = harness(); await app.make().identify();
    const [key, record] = [...app.saved.entries()][0]!; app.saved.set(key, { ...record, ownerId: "other" });
    const count = app.calls.length;
    await expect(app.make().read()).rejects.toThrow("不属于当前素材");
    expect(app.calls).toHaveLength(count);
});
