import { expect, test } from "bun:test";

import { createImageReferenceItem, dedupeImageReferences, moveImageReference, validateImageReferences } from "../src/lib/image-reference-policy";

const ref = (id: string, origin: "upload" | "canvas" | "asset" = "upload") => ({
    id,
    name: `${id}.png`,
    type: "image/png",
    dataUrl: `https://images.test/${id}.png`,
    referenceKey: `${origin}:${id}`,
    origin,
    originLabel: origin === "upload" ? "上传" : origin === "canvas" ? "画布" : "素材库",
});

test("keeps the first visual occurrence of a duplicate image", () => {
    expect(dedupeImageReferences([ref("same", "upload"), ref("same", "canvas"), ref("next")]).map((item) => item.referenceKey)).toEqual(["upload:same", "upload:next"]);
});

test("moves one reference without disturbing the other visual positions", () => {
    expect(moveImageReference([ref("a"), ref("b"), ref("c")], 2, 0).map((item) => item.id)).toEqual(["c", "a", "b"]);
});

test("preserves a mixed-source order after a reorder", () => {
    const ordered = dedupeImageReferences([ref("upload", "upload"), ref("asset", "asset"), ref("upload", "upload")]);
    expect(moveImageReference(ordered, 1, 0).map((item) => item.referenceKey)).toEqual(["asset:asset", "upload:upload"]);
});

test("labels and keys an asset reference independently from an upload", () => {
    const asset = createImageReferenceItem({ id: "asset-1", name: "look.png", type: "image/png", dataUrl: "https://images.test/look.png", storageKey: "image:look" }, "asset");
    expect(asset).toMatchObject({ referenceKey: "asset:asset-1", origin: "asset", originLabel: "素材库" });
});

test("enforces documented GPT, Gemini and Midjourney reference limits", () => {
    expect(validateImageReferences("gpt-image-2", Array.from({ length: 17 }, (_, index) => ref(String(index)))).message).toContain("16");
    expect(validateImageReferences("gemini-3.1-flash-image-preview", Array.from({ length: 15 }, (_, index) => ref(String(index)))).message).toContain("14");
    expect(validateImageReferences("midjourney-blend", [ref("one")]).message).toContain("2 至 4");
    expect(validateImageReferences("midjourney", [ref("one")]).valid).toBe(false);
});
