import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { designLibraryObjectStorage } from "../src/design-library-postgres";
import type { ObjectStorage } from "../src/object-storage";
import { inspectDesignLibraryImage } from "../src/design-library";
import { createDesignLibraryObjectStorageFixture } from "./helpers/design-library-object-storage";
import { png } from "./design-library-fixtures";

test("library publication validates original bytes then conditionally copies; reuse only HEADs and copies", async () => {
    const h = await createDesignLibraryObjectStorageFixture();
    try {
        h.seed("source.png", png);
        const media = designLibraryObjectStorage(h.storage);
        let validated = 0;
        await media.copy!("source.png", "published.png", { byteSize: png.length, validate: bytes => {
            expect(bytes).toEqual(png); expect(inspectDesignLibraryImage(bytes, "image/png").width).toBe(1); validated++;
        } });
        expect(validated).toBe(1);
        await media.copy!("published.png", "reused.png", { byteSize: png.length });
        expect(h.requests.map(item => item.method)).toEqual(["GET", "PUT", "HEAD", "PUT"]);
        expect(h.objects.get("reused.png")!.bytes).toEqual(png);
        expect(await media.read("published.png", png.length)).toEqual(png);
        h.beforeRequest(async request => {
            if (request.method === "PUT" && request.source === "source.png") h.seed("source.png", new Uint8Array(png.length).fill(1));
        });
        await expect(media.copy!("source.png", "raced.png", { byteSize: png.length, validate: () => {} })).rejects.toThrow("PreconditionFailed");
        expect(h.objects.has("raced.png")).toBe(false);
    } finally { await h.close(); }
});

test.each(["oversize-header", "wrong-header", "overflow", "truncated", "empty"])("library read bounds bytes and closes rejected source streams: %s", async kind => {
    let chunks = 0;
    const stream = Readable.from((async function* () {
        chunks++; if (kind !== "empty") yield png.subarray(0, kind === "truncated" ? png.length - 1 : png.length);
        if (kind === "overflow") { chunks++; yield new Uint8Array(1); }
    })());
    const storage = { configured: true, get: async () => ({ Body: stream,
        ...(kind === "oversize-header" ? { ContentLength: 21 * 1024 * 1024 } : kind === "wrong-header" ? { ContentLength: png.length + 1 } : {}) }) } as unknown as ObjectStorage;
    await expect(designLibraryObjectStorage(storage).read("test", png.length)).rejects.toMatchObject({ code: "SNAPSHOT_UNAVAILABLE" });
    expect(stream.destroyed).toBe(true);
    if (kind.endsWith("header")) expect(chunks).toBe(0);
});

test("library copy refuses missing ETags and invalid formats before issuing a copy", async () => {
    let copies = 0;
    const storage = { configured: true, head: async () => ({ ContentLength: png.length }),
        get: async () => ({ Body: Readable.from([png]), ETag: '"fixture"', ContentLength: png.length }),
        copy: async () => { copies++; } } as unknown as ObjectStorage;
    const media = designLibraryObjectStorage(storage);
    await expect(media.copy!("source", "target", { byteSize: png.length })).rejects.toThrow();
    await expect(media.copy!("source", "target", { byteSize: png.length, validate: bytes => { inspectDesignLibraryImage(bytes, "image/jpeg"); } })).rejects.toMatchObject({ code: "UNSUPPORTED_IMAGE" });
    expect(copies).toBe(0);
});
