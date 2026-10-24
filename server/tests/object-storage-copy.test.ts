import { expect, test } from "bun:test";
import { createDesignLibraryObjectStorageFixture } from "./helpers/design-library-object-storage";
import { png } from "./design-library-fixtures";

test("S3 conditional copy encodes private keys and preserves source bytes, content type and metadata", async () => {
    const h = await createDesignLibraryObjectStorageFixture();
    try {
        const source = "private/设计 +?#%/原图.png", target = "snapshot/独立副本.png";
        h.seed(source, png, "image/png", { fixture: "original-metadata" });
        await h.storage.copy(source, target, h.objects.get(source)!.etag);
        expect(h.objects.get(target)).toEqual(h.objects.get(source));
        expect(h.requests).toEqual([{ method: "PUT", key: target, source, ifMatch: h.objects.get(source)!.etag, metadataDirective: "COPY" }]);
        await expect(h.storage.copy(source, "bad-copy", '"outdated"')).rejects.toThrow("PreconditionFailed");
        expect(h.objects.has("bad-copy")).toBe(false);
        await expect(h.storage.copy(source, "unconditional", "")).rejects.toThrow("requires a source ETag");
    } finally { await h.close(); }
});

test("S3 put retains the three-argument contract and forwards an optional abort signal", async () => {
    const h = await createDesignLibraryObjectStorageFixture();
    try {
        await h.storage.put("default.png", png, "image/png");
        expect(h.objects.get("default.png")!.bytes).toEqual(png);
        const controller = new AbortController(); controller.abort();
        await expect(h.storage.put("aborted.png", png, "image/png", { abortSignal: controller.signal })).rejects.toThrow();
        expect(h.objects.has("aborted.png")).toBe(false);
        expect(h.requests.map(item => item.key)).toEqual(["default.png"]);
    } finally { await h.close(); }
});
