import { expect, test } from "bun:test";
import { assetMetadataSchema } from "../src/asset-metadata";

const input = { title: " Edited asset ", tags: [" product "], source: "Manual", note: "Updated" };
test("asset edits accept bounded descriptive fields and trim input", () => {
    expect(assetMetadataSchema.parse(input)).toEqual({ ...input, title: "Edited asset", tags: ["product"] });
    expect(assetMetadataSchema.safeParse({ ...input, title: " " }).success).toBe(false);
    expect(assetMetadataSchema.safeParse({ ...input, tags: Array(21).fill("tag") }).success).toBe(false);
    expect(assetMetadataSchema.safeParse({ ...input, note: "x".repeat(2001) }).success).toBe(false);
});
test("asset edits reject content, ownership and provenance injection", () => {
    for (const key of ["content", "prompt", "model", "taskId", "ownerUserId", "object_key", "visibilityScope"]) {
        expect(assetMetadataSchema.safeParse({ ...input, [key]: "overwrite" }).success).toBe(false);
    }
});
