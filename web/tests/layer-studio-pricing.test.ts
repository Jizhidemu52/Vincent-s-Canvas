import { afterEach, describe, expect, test } from "bun:test";
import { isLayerStudioPricingModel, LayerStudioPricingError, listLayerStudioPrices, saveLayerStudioPrice, validateLayerStudioPriceInput } from "../src/services/api/model-configuration";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const valid = { inputRmb: 0, lowOutputRmb: 0.1, highOutputRmb: 0.2, sourceNote: "隔离测试确认依据" };
const record = { ...valid, modelConfigId: "model-a", version: 2, updatedAt: "2026-11-11T00:00:00Z" };

describe("dedicated layer pricing", () => {
    test("eligible is exact provider protocol/model with no workflow", () => {
        const model = { modelId: "seedream-5-5", providerId: "p", workflowConfigId: null };
        expect(isLayerStudioPricingModel(model, [{ id: "p", protocol: "apimart" }])).toBe(true);
        expect(isLayerStudioPricingModel(model, [{ id: "p", protocol: "openai" }])).toBe(false);
        expect(isLayerStudioPricingModel({ ...model, modelId: "seedream-5" }, [{ id: "p", protocol: "apimart" }])).toBe(false);
        expect(isLayerStudioPricingModel({ ...model, workflowConfigId: "workflow" }, [{ id: "p", protocol: "apimart" }])).toBe(false);
        expect(isLayerStudioPricingModel(model, [])).toBe(false);
    });
    test("input is explicitly required; explicit zero is allowed without guessing", () => {
        expect(validateLayerStudioPriceInput(valid)).toEqual(valid);
        for (const inputRmb of [undefined, null, "", "0", -1, Infinity, 1001]) expect(() => validateLayerStudioPriceInput({ ...valid, inputRmb })).toThrow();
    });
    test("output prices positive, ordered, finite and limited to stored six decimal places", () => {
        for (const value of [0, -1, undefined, null, "1", Infinity, 1001, 0.0000001, 0.00000000000001, 0.10000000000001]) expect(() => validateLayerStudioPriceInput({ ...valid, lowOutputRmb: value })).toThrow();
        expect(() => validateLayerStudioPriceInput({ ...valid, highOutputRmb: 0.01 })).toThrow();
        expect(() => validateLayerStudioPriceInput({ ...valid, inputRmb: 0.0000001 })).toThrow();
        expect(() => validateLayerStudioPriceInput({ ...valid, inputRmb: 0.00000000000001 })).toThrow();
        expect(validateLayerStudioPriceInput({ ...valid, lowOutputRmb: 0.000001 })).toMatchObject({ lowOutputRmb: 0.000001 });
    });
    test("source note is required and trimmed, never substituted", () => {
        for (const sourceNote of [undefined, null, "", "   ", "a".repeat(501)]) expect(() => validateLayerStudioPriceInput({ ...valid, sourceNote })).toThrow();
        expect(validateLayerStudioPriceInput({ ...valid, sourceNote: "  明确依据  " }).sourceNote).toBe("明确依据");
    });
    test("GET uses actual mounted path and preserves all current rates", async () => {
        const calls: Array<[string, RequestInit | undefined]> = [];
        globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => { calls.push([String(url), init]); return Response.json({ prices: [record] }); }) as typeof fetch;
        expect((await listLayerStudioPrices()).prices).toEqual([record]);
        expect(calls[0][0]).toBe("/api/admin/model-configuration/layer-studio-pricing");
        expect(calls[0][1]).toMatchObject({ credentials: "include", cache: "no-store" });
    });
    test("valid save sends exactly one PUT with only explicit rates", async () => {
        const calls: Array<[string, RequestInit | undefined]> = [];
        globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => { calls.push([String(url), init]); return Response.json({ price: record }); }) as typeof fetch;
        expect((await saveLayerStudioPrice("model-a", valid)).price).toEqual(record);
        expect(calls).toHaveLength(1); expect(calls[0][0]).toBe("/api/admin/model-configuration/layer-studio-pricing/model-a");
        expect(calls[0][1]?.method).toBe("PUT"); expect(JSON.parse(calls[0][1]?.body as string)).toEqual(valid);
    });
    test("invalid input never fetches, and uncertain save does not retry", async () => {
        let calls = 0;
        globalThis.fetch = (async () => { calls++; throw new TypeError("network"); }) as typeof fetch;
        await expect(saveLayerStudioPrice("model-a", { ...valid, inputRmb: undefined as unknown as number })).rejects.toThrow();
        expect(calls).toBe(0);
        try { await saveLayerStudioPrice("model-a", valid); throw new Error("expected failure"); }
        catch (error) { expect(error).toBeInstanceOf(LayerStudioPricingError); expect((error as LayerStudioPricingError).uncertain).toBe(true); }
        expect(calls).toBe(1);
    });
    test("wrong-model success response is uncertain, not an accepted save", async () => {
        globalThis.fetch = (async () => Response.json({ price: { ...record, modelConfigId: "other" } })) as typeof fetch;
        try { await saveLayerStudioPrice("model-a", valid); throw new Error("expected failure"); }
        catch (error) { expect((error as LayerStudioPricingError).uncertain).toBe(true); }
    });
});
