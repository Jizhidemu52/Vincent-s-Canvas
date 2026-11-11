import { describe, expect, test } from "bun:test";
import { applyLayerStudioSnapshot, initialLayerStudioForm, layerStudioParameters, layerStudioSubmission, newLayerStudioWorkspace, readLayerStudioWorkspace, unresolvedLayerStudioJob, validateLayerStudioForm, type LayerStudioJob } from "../src/pages/layer-studio/page-state";
import { submitLayerStudioOnce } from "../src/pages/layer-studio/page-request";
import { LayerStudioApiError } from "../src/services/api/layer-studio";
import { layerStudioReferenceFile } from "../src/pages/layer-studio/page-reference";
import { validateLayerStudioOptions } from "../../shared/layer-studio-options";

function job(): LayerStudioJob {
    const workspace = newLayerStudioWorkspace("owner-a", "workspace-a");
    workspace.form = { ...workspace.form, mode: "generate", prompt: "可用的设计描述" };
    return { ownerId: workspace.ownerId, workspaceId: workspace.workspaceId, requestId: "request-12345678", createdAt: 1, phase: "submitting", submission: layerStudioSubmission(workspace, "request-12345678") };
}
const accepted = () => ({ id: "task-one", requestId: "request-12345678", userId: "owner-a", status: "processing", resultUrls: [], failureReason: null });

describe("layer studio page contract", () => {
    test("decomposition default 30 includes base; no background and n is always 1", () => {
        const parameters = layerStudioParameters({ ...initialLayerStudioForm(), background: "transparent", format: "jpeg" });
        expect(parameters).toEqual({ n: 1, size: "auto", layer_decomposition: true, layer_decomposition_options: { max_images: 30, text_recognition: false }, output_format: "jpeg", watermark: false, nsfw_check: true, optimize_prompt_options: { mode: "standard" } });
        expect(() => validateLayerStudioOptions(parameters, "", 1)).not.toThrow();
        expect(() => validateLayerStudioOptions(parameters, "", 0)).toThrow();
    });
    test("transparent output forces PNG and ratio / exact modes are exclusive", () => {
        const form = { ...initialLayerStudioForm(), mode: "generate" as const, background: "transparent" as const, format: "jpeg" as const, sizeMode: "ratio" as const, ratio: "21:9", tier: "1.5K" as const };
        expect(layerStudioParameters(form)).toMatchObject({ size: "21:9", resolution: "1.5K", output_format: "png" });
        const exact = layerStudioParameters({ ...form, sizeMode: "exact", width: 2048, height: 1152 });
        expect(exact.size).toBe("2048x1152"); expect(exact).not.toHaveProperty("resolution"); expect(exact).not.toHaveProperty("layer_decomposition_options");
        expect(() => validateLayerStudioOptions(exact, "有效", 10)).not.toThrow();
        expect(() => validateLayerStudioOptions(exact, "有效", 11)).toThrow();
    });
    test("invalid exact pixel count, ratio and output cap fail before submission", () => {
        for (const [width, height] of [[1, 1], [5000, 5000], [16384, 64], [1.5, 1000000]]) {
            expect(() => validateLayerStudioForm({ ...initialLayerStudioForm(), mode: "generate", prompt: "有效", sizeMode: "exact", width, height }, 0)).toThrow();
        }
        for (const maxImages of [1, 101, 2.5]) expect(() => validateLayerStudioOptions(layerStudioParameters({ ...initialLayerStudioForm(), maxImages }), "", 1)).toThrow();
    });
    test("request is provider neutral and preserves reference order", () => {
        const workspace = newLayerStudioWorkspace("owner-a", "workspace-a");
        workspace.form = { ...workspace.form, mode: "generate", prompt: "合并两张图" };
        workspace.references = ["b", "a"].map(id => ({ id, name: id, mimeType: "image/png", bytes: 12, sha256: "abc", previewable: true }));
        const result = layerStudioSubmission(workspace, "request-12345678");
        expect(result.sourceUrls).toEqual(["/api/assets/b/content", "/api/assets/a/content"]);
        expect(result).not.toHaveProperty("modelConfigId"); expect(result).not.toHaveProperty("model");
    });
    test("foreign owners and malformed persisted identity are refused", () => {
        expect(() => readLayerStudioWorkspace(newLayerStudioWorkspace("other", "workspace-a"), "owner-a", "workspace-a")).toThrow();
        expect(() => applyLayerStudioSnapshot(job(), { ...accepted(), userId: "other" })).toThrow();
        expect(() => applyLayerStudioSnapshot(job(), { ...accepted(), requestId: "other-request" })).toThrow();
    });
    test("partial original persistence remains pending, and final document retains every group/index", () => {
        const document = { version: 1 as const, taskId: "task-one", mode: "decompose" as const, status: "partial" as const, expectedOutputCount: 3,
            items: [{ index: 2, groupIndex: 1, urlIndex: 0, role: "base" as const, state: "saved" as const }] };
        const partial = applyLayerStudioSnapshot(job(), { ...accepted(), status: "success", resultDocument: document, failureReason: "SECRET_PROVIDER" });
        expect(unresolvedLayerStudioJob(partial)).toBe(true); expect(partial.document).toEqual(document);
        expect(JSON.stringify(partial)).not.toContain("SECRET_PROVIDER");
        const complete = applyLayerStudioSnapshot(partial, { ...accepted(), status: "success", resultDocument: { ...document, status: "ready" } });
        expect(complete.phase).toBe("complete");
    });
    test("MIME metadata assignment preserves original bytes; unsupported types rejected", async () => {
        const bytes = new Uint8Array([11, 22, 33]);
        const file = layerStudioReferenceFile(new File([bytes], "original.HEIC"));
        expect(file.type).toBe("image/heic"); expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
        expect(() => layerStudioReferenceFile(new File([bytes], "unsupported.avif", { type: "image/avif" }))).toThrow();
        expect(() => layerStudioReferenceFile(new File([bytes], "fake.png", { type: "image/avif" }))).toThrow();
        expect(() => layerStudioReferenceFile(new File([], "empty.png", { type: "image/png" }))).toThrow();
    });
});

describe("durable one-shot generation boundary", () => {
    test("awaits durable identity before the sole POST and awaits accepted ID persistence", async () => {
        const events: string[] = [];
        let release!: () => void;
        const latch = new Promise<void>(resolve => { release = resolve; });
        const promise = submitLayerStudioOnce(job(), { assertCurrent() {},
            async persist(value) { events.push(`save:${value.phase}`); if (value.phase === "submitting") await latch; },
            async create() { events.push("POST"); return accepted(); } });
        await Promise.resolve(); expect(events).toEqual(["save:submitting"]);
        release(); await promise; expect(events).toEqual(["save:submitting", "POST", "save:pending"]);
    });
    test("failed durable storage means no POST", async () => {
        let calls = 0;
        await expect(submitLayerStudioOnce(job(), { assertCurrent() {}, async persist() { throw new Error("disk unavailable"); }, async create() { calls++; return accepted(); } })).rejects.toThrow();
        expect(calls).toBe(0);
    });
    test("owner change during durable write means no POST", async () => {
        let calls = 0, sameOwner = true;
        await expect(submitLayerStudioOnce(job(), { assertCurrent() { if (!sameOwner) throw new Error("changed"); }, async persist() { sameOwner = false; }, async create() { calls++; return accepted(); } })).rejects.toThrow();
        expect(calls).toBe(0);
    });
    test("network ambiguity stays unresolved and never retries", async () => {
        let calls = 0;
        const saved: LayerStudioJob[] = [];
        const result = await submitLayerStudioOnce(job(), { assertCurrent() {}, async persist(value) { saved.push(value); }, async create() { calls++; throw new Error("unknown"); } });
        expect(calls).toBe(1); expect(saved).toHaveLength(2); expect(result.phase).toBe("uncertain"); expect(result.requestId).toBe(job().requestId);
    });
    test("definite rejection ends locally without disclosing upstream names", async () => {
        const result = await submitLayerStudioOnce(job(), { assertCurrent() {}, async persist() {}, async create() { throw new LayerStudioApiError(503, "PRICE_NOT_CONFIGURED"); } });
        expect(result.phase).toBe("failed"); expect(result.notice).toContain("费用尚未配置");
    });
    test("accepted ID persistence failure cannot issue a second POST", async () => {
        let calls = 0;
        await expect(submitLayerStudioOnce(job(), { assertCurrent() {}, async persist(value) { if (value.taskId) throw new Error("disk"); }, async create() { calls++; return accepted(); } })).rejects.toThrow();
        expect(calls).toBe(1);
    });
});
