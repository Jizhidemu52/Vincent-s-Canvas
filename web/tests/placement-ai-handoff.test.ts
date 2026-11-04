import { describe, expect, test } from "bun:test";
import { createPlacementHandoff, placementAiPrompt, placementDraftScope, placementHandoffToken } from "../src/pages/design-workbench/local/placement/ai-handoff";

const project = () => ({
    base: { src: "data:image/png;base64,b3JpZ2luYWw=", width: 1000, height: 800, name: "原服装" },
    layers: [{ src: "data:image/png;base64,YXJ0", name: "胸前花朵", x: 600, y: 320, width: 200, aspect: 2, rotation: -6, opacity: 0.95, visible: true }],
});
function memory() {
    const items = new Map<string, unknown>();
    return { items, async getItem<T>(key: string) { return (items.get(key) ?? null) as T | null; }, async setItem<T>(key: string, value: T) { items.set(key, structuredClone(value)); return value; }, async removeItem(key: string) { items.delete(key); } };
}
function fixture() {
    const handoffs = memory(), drafts = memory(), uploads: unknown[] = [];
    let seq = 0, current = true, readable = true;
    const deps = {
        ownerId: "designer-a", assertCurrent() { if (!current) throw new Error("identity changed"); }, handoffs, drafts,
        id: () => `id-${++seq}`,
        upload: async (source: string | Blob) => { uploads.push(source); return { storageKey: `image:${uploads.length}`, url: `blob:local-${uploads.length}`, bytes: 300, width: 1000, height: 800, mimeType: "image/png" }; },
        resolve: async (key?: string) => readable ? `blob:restored-${key}` : "",
    };
    return { deps, handoffs, drafts, uploads, access: createPlacementHandoff(deps), stop() { current = false; }, unavailable() { readable = false; }, restore() { readable = true; } };
}
const composite = new Blob(["actual-composite"], { type: "image/png" });
const artwork = new Blob(["artwork-sheet"], { type: "image/png" });

describe("placement AI handoff", () => {
    test("keeps original source bytes, composite first, references named and no data in URL", async () => {
        const fx = fixture(), source = project();
        const before = structuredClone(source);
        const path = await fx.access.prepare(source, composite, artwork);
        expect(fx.uploads).toEqual([composite, source.base.src, artwork]);
        expect(path).toBe("/image?tool=image-edit&placementToken=id-1");
        expect(source).toEqual(before);
        const saved = fx.handoffs.items.get("id-1") as any;
        expect(saved.ownerId).toBe("designer-a");
        expect(saved.references.map((item: any) => item.name)).toEqual(["图1-定位合成图.png", "图2-服装原图", "图3-图案原稿对照.png"]);
        expect(saved.references.every((item: any) => item.storageKey && item.dataUrl === "")).toBe(true);
    });
    test("prompt locks exact relative center, dimensions, rotation, motif shape and excludes hidden art", () => {
        const source = project();
        source.layers.push({ ...source.layers[0]!, name: "隐藏图案", visible: false });
        const prompt = placementAiPrompt(source);
        expect(prompt).toContain("X 60%，Y 40%，宽 20%，高 12.5%，旋转 -6°");
        expect(prompt).toContain("不得重新排版、移动、放大、裁切、增删或重绘图案");
        expect(prompt).not.toContain("隐藏图案");
    });
    test("consumes once into separate durable draft; reload preserves new edits and ordinary draft", async () => {
        const fx = fixture();
        fx.drafts.items.set("image-edit:prompt", "原有草稿");
        fx.drafts.items.set("image-edit:references", [{ id: "old-ref" }]);
        fx.drafts.items.set("image-edit:settings", { imageModel: "saved-model", size: "1536x1024" });
        await fx.access.prepare(project(), composite, artwork);
        const loaded = await fx.access.consume("id-1");
        expect(loaded.references).toHaveLength(3);
        expect(loaded.references[0]!.dataUrl).toBe("blob:restored-image:1");
        expect(loaded.settings).toEqual({ imageModel: "saved-model", size: "1536x1024" });
        expect(fx.handoffs.items.has("id-1")).toBe(false);
        expect(fx.drafts.items.get("image-edit:prompt")).toBe("原有草稿");
        expect(fx.drafts.items.get("image-edit:references")).toEqual([{ id: "old-ref" }]);
        fx.drafts.items.set(`${placementDraftScope("id-1")}:prompt`, "定位草稿后续修改");
        fx.drafts.items.set(`${placementDraftScope("id-1")}:settings`, { imageModel: "new-model", size: "auto" });
        expect((await fx.access.consume("id-1")).prompt).toBe("定位草稿后续修改");
        expect((await fx.access.consume("id-1")).settings).toEqual({ imageModel: "new-model", size: "auto" });
        expect(fx.drafts.items.get("image-edit:settings")).toEqual({ imageModel: "saved-model", size: "1536x1024" });
        expect(fx.uploads).toHaveLength(3);
    });
    test("missing image leaves source token and all reference identities for retry", async () => {
        const fx = fixture();
        await fx.access.prepare(project(), composite, artwork);
        fx.unavailable();
        await expect(fx.access.consume("id-1")).rejects.toThrow("暂时无法读取");
        expect(fx.handoffs.items.has("id-1")).toBe(true);
        expect(fx.drafts.items.size).toBe(0);
        fx.restore();
        expect((await fx.access.consume("id-1")).references).toHaveLength(3);
    });
    test("draft write failure never consumes source token", async () => {
        const fx = fixture();
        await fx.access.prepare(project(), composite, artwork);
        fx.deps.drafts.setItem = async () => { throw new Error("storage full"); };
        await expect(fx.access.consume("id-1")).rejects.toThrow("storage full");
        expect(fx.handoffs.items.has("id-1")).toBe(true);
    });
    test("identity change and wrong-owner payload cannot expose references", async () => {
        const fx = fixture();
        await fx.access.prepare(project(), composite, artwork);
        const payload = fx.handoffs.items.get("id-1") as any;
        payload.ownerId = "designer-b";
        await expect(fx.access.consume("id-1")).rejects.toThrow("不属于当前员工");
        expect(fx.drafts.items.size).toBe(0);
        fx.stop();
        await expect(fx.access.prepare(project(), composite, artwork)).rejects.toThrow("identity changed");
        await expect(fx.access.consume("id-1")).rejects.toThrow("identity changed");
    });
    test("no visible artwork and unrelated or malformed route tokens cannot start a handoff", async () => {
        const fx = fixture(), source = project();
        source.layers[0]!.visible = false;
        await expect(fx.access.prepare(source, composite, artwork)).rejects.toThrow("至少一个图案");
        expect(fx.uploads).toEqual([]);
        expect(placementHandoffToken(new URLSearchParams("placementToken=token"), "image-generation")).toBeNull();
        expect(placementHandoffToken(new URLSearchParams("placementToken=../../"), "image-edit")).toBeNull();
        expect(placementHandoffToken(new URLSearchParams("placementToken=token"), "image-edit")).toBe("token");
    });
});
