import { expect, test } from "bun:test";
import { imageToDataUrl } from "../src/services/image-storage";

test("reference requests resolve persisted images before stale object URLs", async () => {
    const calls: unknown[][] = [];
    const result = await imageToDataUrl({ storageKey: "image:persisted", dataUrl: "blob:previous-page" }, async (...args) => {
        calls.push(args);
        return "data:image/png;base64,c3RvcmVk";
    });
    expect(calls).toEqual([["image:persisted", "blob:previous-page"]]);
    expect(result).toBe("data:image/png;base64,c3RvcmVk");
});

test("unpersisted reference data is kept as the resolver fallback", async () => {
    const original = "data:image/png;base64,b3JpZ2luYWw=";
    expect(await imageToDataUrl({ dataUrl: original }, async (_key, fallback = "") => fallback)).toBe(original);
});
