import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import { createAssetThumbnailBytes } from "../src/asset-thumbnails";
import { DemoDesignLibraryStore, handleDemoDesignLibrary } from "../src/demo-design-library";
import { DesignLibraryService, inspectDesignLibraryImage, type DesignLibraryActor, type DesignLibraryEntry } from "../src/design-library";
import { png, publishInput } from "./design-library-fixtures";

function fixture() {
    const store = new DemoDesignLibraryStore(":memory:");
    const author: DesignLibraryActor = { id: randomUUID(), name: "作者", departmentId: null, departmentName: null, role: "designer", kind: "employee" };
    const reader = { ...author, id: randomUUID(), name: "读者" }, assetId = randomUUID();
    const db = (store as unknown as { db: Database }).db;
    db.query("INSERT INTO demo_assets(id,fields_json,bytes) VALUES(?,?,?)").run(assetId, JSON.stringify({ ownerUserId: author.id, filename: "原件.png", mimeType: "image/png", byteSize: png.length }), png);
    let depth = 0, failEncoder = false;
    const writes: string[] = [], reads: string[] = [];
    const transaction = store.transaction.bind(store), write = store.write.bind(store), read = store.read.bind(store);
    store.transaction = work => transaction(async repository => { depth++; try { return await work(repository); } finally { depth--; } });
    store.write = async (...args) => { expect(depth).toBe(1); writes.push(args[0]); await write(...args); };
    store.read = async key => { reads.push(key); return read(key); };
    const service = new DesignLibraryService(store, store, { createThumbnail: async bytes => {
        expect(depth).toBe(0); if (failEncoder) throw new Error("Fixture encoder failure");
        return (await createAssetThumbnailBytes(bytes, [256]))[256];
    } });
    const request = async (path: string, actor: DesignLibraryActor = reader, options: RequestInit = {}) => {
        const response = await handleDemoDesignLibrary(new Request(`http://fixture.test${path}`, { ...options, headers: { "x-canvas-owner-id": actor.id, ...options.headers } }), service, actor);
        expect(response).not.toBeNull(); return response!;
    };
    const publish = async () => {
        const response = await request("/api/design-library", author, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(publishInput([assetId], randomUUID())) });
        expect(response.status).toBe(201);
        const entry = (await response.json() as { data: { entry: DesignLibraryEntry } }).data.entry;
        const image = entry.images[0]!, record = (await store.getPublication(entry.id))!.images[0]!;
        return { entry, image, record, key: `${record.objectKey}.library-thumb-256-v1.webp` };
    };
    return { store, author, reader, assetId, service, request, publish, writes, reads, failEncoder: (value: boolean) => { failEncoder = value; } };
}

test("Demo thumbnail BLOBs stay atomic, legacy previews regenerate outside transactions and 304 does not read a BLOB", async () => {
    const h = fixture();
    try {
        const published = await h.publish();
        expect(h.writes).toEqual([published.record.objectKey, published.key]);
        expect(await h.store.read(published.record.objectKey)).toEqual(png);
        const response = await h.request(published.image.thumbnailUrl!);
        expect(response.status).toBe(200); const bytes = await response.bytes();
        expect((await fileTypeFromBuffer(bytes))?.mime).toBe("image/webp");
        expect(inspectDesignLibraryImage(bytes, "image/webp")).toMatchObject({ width: 1, height: 1 });
        const etag = response.headers.get("etag")!; h.reads.length = 0;
        expect((await h.request(published.image.thumbnailUrl!, h.reader, { headers: { "if-none-match": etag } })).status).toBe(304);
        expect(h.reads).toEqual([]);
        await h.store.remove(published.key);
        expect((await h.request(published.image.thumbnailUrl!)).status).toBe(200);
        expect(await h.store.stat(published.key)).toMatchObject({ mimeType: "image/webp", etag });
        await h.service.withdraw(h.author, published.entry.id); h.reads.length = 0;
        expect((await h.request(published.image.thumbnailUrl!, h.reader, { headers: { "if-none-match": etag } })).status).toBe(404);
        expect(h.reads).toEqual([]);
        expect((await h.request(published.image.thumbnailUrl!, h.author, { headers: { "if-none-match": etag } })).status).toBe(304);
        expect(await h.store.read(published.record.objectKey)).toEqual(png);
    } finally { h.store.close(); }
});

test("Demo publication rollback removes original and derived BLOBs together without deleting the private source", async () => {
    const h = fixture();
    try {
        h.store.insertPublication = async () => { throw new Error("Fixture publication rejection"); };
        await expect(h.service.publish(h.author, publishInput([h.assetId], randomUUID()))).rejects.toThrow("Fixture publication rejection");
        expect(h.writes).toHaveLength(2);
        for (const key of h.writes) expect(await h.store.stat(key)).toBeNull();
        expect(await h.store.read(`demo-assets/${h.assetId}`)).toEqual(png);
    } finally { h.store.close(); }
});

test("Demo preview failure preserves original publication and serves a fallback-safe error", async () => {
    const h = fixture();
    try {
        h.failEncoder(true);
        const published = await h.publish();
        expect(h.writes).toEqual([published.record.objectKey]);
        expect((await h.request(published.image.thumbnailUrl!)).status).toBe(503);
        const original = await h.request(published.image.contentUrl);
        expect(original.status).toBe(200); expect(await original.bytes()).toEqual(png);
        h.failEncoder(false);
        expect((await h.request(published.image.thumbnailUrl!)).status).toBe(200);
    } finally { h.store.close(); }
});
