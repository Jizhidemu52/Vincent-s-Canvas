import { describe, expect, test } from "bun:test";
import { carryoverRequirementsSchema, designBriefFromFields } from "../../shared/design-brief";
import { productCandidatesContextSchema, productCandidatesResultSchema } from "../../shared/product-candidates";
import { createDesignHandoff, designDraftScope, designHandoffToken } from "../src/lib/design-handoff";

const source = { id: "original", name: "款式.png", type: "image/png", dataUrl: "blob:original", storageKey: "original-key", width: 577, height: 591, bytes: 412 };
const brief = { version: 1 as const, sourceScene: "style-to-sketch", requirements: ["领型不变", "保留六颗纽扣"] };
function fixture() {
    const items = new Map<string, unknown>(), uploads: unknown[] = [], resolves: unknown[] = [];
    let current = true, readable = true;
    const deps = {
        ownerId: "owner-a", assertCurrent() { if (!current) throw new Error("identity changed"); },
        storage: { async getItem<T>(key: string) { return (items.get(key) ?? null) as T | null; }, async setItem<T>(key: string, value: T) { items.set(key, structuredClone(value)); return value; } },
        upload: async (input: Blob | string) => { uploads.push(input); return { storageKey: "new-key", url: "blob:new", width: 577, height: 591, bytes: 412, mimeType: "image/png" }; },
        resolve: async (key?: string) => { resolves.push(key); return readable ? `blob:${key}` : ""; },
        id: () => "handoff-id", now: () => 123,
    };
    return { items, uploads, resolves, deps, access: createDesignHandoff(deps), stop() { current = false; }, unavailable() { readable = false; }, restore() { readable = true; } };
}

describe("design carryover", () => {
    test("keeps target, explicit details, material and specified colors; drops the old action and model prompt", () => {
        const fields = { targetProduct: "左侧衬衫", keepDetails: "保持纽扣数量", preserve: "人物不变", fabric: "牛仔", category: "按描述判断", colorMode: "specific", colors: ["#aabbcc"], description: "变成黑白线稿", change: "上一操作", prompt: "Do not carry this prompt", carryoverRequirements: ["目标产品：旧的包", "旧有材质说明"] };
        const snapshot = structuredClone(fields);
        const result = designBriefFromFields("style-to-sketch", fields);
        expect(result.requirements).toContain("目标产品：左侧衬衫");
        expect(result.requirements).not.toContain("目标产品：旧的包");
        expect(result.requirements).toContain("面料：牛仔");
        expect(result.requirements.join("\n")).toContain("#aabbcc");
        expect(result.requirements.join("\n")).not.toContain("黑白线稿");
        expect(result.requirements.join("\n")).not.toContain("Do not carry");
        expect(fields).toEqual(snapshot);
        expect(designBriefFromFields("garment-colorway", { colorMode: "smart", colors: ["#123456"] }).requirements).toEqual([]);
    });
    test("keeps long explicit requirements completely within bounded lines", () => {
        const text = "细节".repeat(1000);
        const result = designBriefFromFields("local-restyle", { keepDetails: text });
        expect(result.requirements.every(line => line.length <= 800)).toBe(true);
        expect(result.requirements.map(line => line.slice("关键特征：".length)).join("")).toBe(text);
    });
    test("rejects invalid or excessive user data instead of silently dropping it", () => {
        for (const invalid of ["not an array", [{ command: "run" }], [""], ["a".repeat(801)], Array(13).fill("a"), Array(8).fill("a".repeat(800))]) expect(carryoverRequirementsSchema.safeParse(invalid).success).toBe(false);
        expect(() => designBriefFromFields("image-edit", { carryoverRequirements: [null] })).toThrow();
    });
});

describe("design handoff", () => {
    test("reuses stored original bytes, freezes requirements, and places no prompt or media in the URL", async () => {
        const fx = fixture(), sourceCopy = structuredClone(source), inputBrief = structuredClone(brief);
        const href = await fx.access.prepare("creative-garment-colorway", sourceCopy, inputBrief);
        expect(href).toBe("/creative/garment-colorway?designToken=handoff-id");
        expect(fx.uploads).toEqual([]);
        expect(sourceCopy).toEqual(source);
        inputBrief.requirements[0] = "新修改";
        const payload = fx.items.get("handoff-id") as any;
        expect(payload.source).toMatchObject({ storageKey: source.storageKey, dataUrl: "", width: 577, height: 591 });
        expect(payload.brief).toEqual(brief);
    });
    test("hydrates read-only and leaves immutable handoff for receiving-page replay guards", async () => {
        const fx = fixture();
        await fx.access.prepare("image-edit", source, brief);
        const before = structuredClone([...fx.items]);
        const payload = await fx.access.consume("handoff-id", "image-edit");
        expect(payload.source.dataUrl).toBe("blob:original-key");
        expect(payload.brief).toEqual(brief);
        expect([...fx.items]).toEqual(before);
        expect(fx.uploads).toHaveLength(0);
        expect(designDraftScope("handoff-id", "image-edit")).toBe("image-edit:design:handoff-id");
    });
    test("missing media stays retryable without writing or re-uploading", async () => {
        const fx = fixture();
        await fx.access.prepare("image-edit", source, brief);
        fx.unavailable();
        await expect(fx.access.consume("handoff-id", "image-edit")).rejects.toThrow("不会自动生成或扣费");
        expect(fx.items.size).toBe(1);
        fx.restore();
        expect((await fx.access.consume("handoff-id", "image-edit")).source.width).toBe(577);
        expect(fx.uploads).toEqual([]);
    });
    test("owner and destination mismatch are refused before resolving the image", async () => {
        const fx = fixture();
        await fx.access.prepare("image-edit", source, brief);
        const readCount = fx.resolves.length;
        await expect(fx.access.consume("handoff-id", "creative-back-design")).rejects.toThrow("不属于当前账号或当前板块");
        (fx.items.get("handoff-id") as any).ownerId = "owner-b";
        await expect(fx.access.consume("handoff-id", "image-edit")).rejects.toThrow("不属于当前账号或当前板块");
        expect(fx.resolves).toHaveLength(readCount);
        fx.stop();
        await expect(fx.access.prepare("image-edit", source, brief)).rejects.toThrow("identity changed");
    });
    test("newly stored sources preserve input and invalid or disabled destinations cannot start", async () => {
        const fx = fixture();
        const temporary = { ...source, storageKey: undefined };
        expect(await fx.access.prepare("image-edit", temporary, brief)).toBe("/image?tool=image-edit&designToken=handoff-id");
        expect(fx.uploads).toEqual([source.dataUrl]);
        expect(temporary.storageKey).toBeUndefined();
        await expect(fx.access.prepare("virtual-try-on", source, brief)).rejects.toThrow("不支持此设计交接目标");
        expect(designHandoffToken(new URLSearchParams("designToken=abc"), "remove-background")).toBeNull();
        expect(designHandoffToken(new URLSearchParams("designToken=../bad"), "image-edit")).toBeNull();
        expect(designHandoffToken(new URLSearchParams("designToken=abc"), "image-edit")).toBe("abc");
    });
});

test("product candidates accept at most eight unique semantic descriptions and a real asset id", () => {
    const candidate = { id: "candidate-1", name: "上衣", brief: "左侧蓝色上衣", evidence: "可见纽扣与短袖" };
    expect(productCandidatesResultSchema.parse({ candidates: [] })).toEqual({ candidates: [] });
    expect(productCandidatesResultSchema.safeParse({ candidates: [candidate] }).success).toBe(true);
    expect(productCandidatesResultSchema.safeParse({ candidates: [candidate, candidate] }).success).toBe(false);
    expect(productCandidatesResultSchema.safeParse({ candidates: [{ ...candidate, mask: "fake" }] }).success).toBe(false);
    expect(productCandidatesResultSchema.safeParse({ candidates: [{ ...candidate, id: "candidate-9" }] }).success).toBe(false);
    expect(productCandidatesContextSchema.safeParse({ sourceAssetId: "../foreign" }).success).toBe(false);
});
