import { expect, test } from "bun:test";
import express from "express";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { startAssetThumbnailMaintenance } from "../../src/asset-thumbnails";
import { createAssetsRouter } from "../../src/routes/assets";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
import type { ObjectStorage } from "../../src/object-storage";
import type { AuthenticatedRequest } from "../../src/types";

const integration = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

integration("opt-in image preview waits for a derivative, protects owners and leaves original download bytes untouched", async () => {
    const original = await new Promise<Buffer>((resolve, reject) => execFile(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=2048x1536", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"],
        { windowsHide: true, encoding: "buffer", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    const fixture = await createIsolatedPostgres();
    const owner = randomUUID(), other = randomUUID(), id = randomUUID(), key = `image/${id}.png`;
    const objects = new Map([[key, original]]), reads: string[] = [], writes: string[] = [];
    const storage = {
        configured: true,
        head: async (objectKey: string) => ({ ContentLength: objects.get(objectKey)!.length, ETag: `"${hash(objects.get(objectKey)!)}"` }),
        get: async (objectKey: string) => { reads.push(objectKey); const bytes = objects.get(objectKey)!; return { Body: Readable.from([bytes]), ContentLength: bytes.length, ETag: `"${hash(bytes)}"` }; },
        put: async (objectKey: string, bytes: Buffer) => { writes.push(objectKey); objects.set(objectKey, Buffer.from(bytes)); },
    } as unknown as ObjectStorage;
    await fixture.db.query("INSERT INTO users(id,username,display_name,role) VALUES($1,'preview-owner','Owner','designer'),($2,'preview-other','Other','designer')", [owner, other]);
    await fixture.db.query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind,status,metadata) VALUES($1,$2,$3,'image.png','image/png',$4,'image','ready',$5)", [id, owner, key, original.length, JSON.stringify({ customField: "preserved" })]);
    const app = express();
    app.use((request, _response, next) => { (request as AuthenticatedRequest).auth = { id: request.header("x-test-owner") || owner, role: "designer", departmentId: null } as AuthenticatedRequest["auth"]; next(); });
    app.use("/api/assets", createAssetsRouter(fixture.db, storage));
    const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/assets/${id}`;
    const get = (suffix: string, actor = owner) => fetch(base + suffix, { headers: { "x-test-owner": actor } });
    let service: ReturnType<typeof startAssetThumbnailMaintenance> | undefined;
    try {
        const pending = await get("/thumb?w=256&pending=1");
        expect(pending.status).toBe(202); expect(pending.headers.get("Retry-After")).toBe("3");
        expect(pending.headers.get("Cache-Control")).toBe("no-store"); expect((await pending.arrayBuffer()).byteLength).toBe(0); expect(reads).toEqual([]);
        expect((await get("/thumb?w=256&pending=1", other)).status).toBe(404); expect(reads).toEqual([]);
        // Existing direct-image consumers explicitly retain their old behavior.
        expect(hash(new Uint8Array(await (await get("/thumb?w=256")).arrayBuffer()))).toBe(hash(original));
        service = startAssetThumbnailMaintenance(fixture.db, storage, { pollIntervalMs: 10 });
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            const row = (await fixture.db.query("SELECT thumbnail_256_key,thumbnail_1024_key,thumbnail_lease_token FROM assets WHERE id=$1", [id])).rows[0];
            if (row?.thumbnail_256_key && row.thumbnail_1024_key && !row.thumbnail_lease_token) break;
            await Bun.sleep(20);
        }
        expect(writes).toEqual([`${key}.thumb-256.webp`, `${key}.thumb-1024.webp`]);
        for (const width of [256, 1024]) {
            const ready = await get(`/thumb?w=${width}&pending=1`);
            expect(ready.status).toBe(200); expect(ready.headers.get("Content-Type")).toBe("image/webp");
            expect(hash(new Uint8Array(await ready.arrayBuffer()))).toBe(hash(objects.get(`${key}.thumb-${width}.webp`)!));
        }
        const readsBeforeDenied = reads.length;
        expect((await get("/thumb?w=256&pending=1", other)).status).toBe(404); expect(reads).toHaveLength(readsBeforeDenied);
        expect(hash(objects.get(key)!)).toBe(hash(original));
        expect(hash(new Uint8Array(await (await get("/content")).arrayBuffer()))).toBe(hash(original));
        await service.stop(); service = undefined;
        await fixture.db.query("UPDATE assets SET thumbnail_256_key=NULL,thumbnail_1024_key=NULL,thumbnail_attempts=4 WHERE id=$1", [id]);
        await fixture.db.query("UPDATE assets SET thumbnail_lease_token=$2 WHERE id=$1", [id, randomUUID()]);
        expect((await get("/thumb?w=256&pending=1")).status).toBe(202);
        await fixture.db.query("UPDATE assets SET thumbnail_lease_token=NULL WHERE id=$1", [id]);
        const readsBeforeExhausted = reads.length;
        const exhausted = await get("/thumb?w=256&pending=1");
        expect(exhausted.status).toBe(422); expect((await exhausted.arrayBuffer()).byteLength).toBe(0);
        expect(reads).toHaveLength(readsBeforeExhausted);
        expect(hash(new Uint8Array(await (await get("/content")).arrayBuffer()))).toBe(hash(original));
        expect((await fixture.db.query("SELECT metadata FROM assets WHERE id=$1", [id])).rows[0].metadata).toEqual({ customField: "preserved" });
    } finally {
        await service?.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fixture.close();
    }
}, 30_000);
