import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import express from "express";
import cookieParser from "cookie-parser";
import { fileTypeFromBuffer } from "file-type";
import type { AppConfig } from "../../src/config";
import type { Cache, Database } from "../../src/db";
import { DesignLibraryService, inspectDesignLibraryImage, type DesignLibraryActor, type DesignLibraryEntry } from "../../src/design-library";
import { PostgresDesignLibraryRepository, designLibraryObjectStorage } from "../../src/design-library-postgres";
import { createDesignLibraryRouter, designLibraryBoundary } from "../../src/routes/design-library";
import { createAssetThumbnailBytes } from "../../src/asset-thumbnails";
import { requireAccountReady, sessionMiddleware } from "../../src/session";
import { hashToken } from "../../src/security";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
import { createDesignLibraryObjectStorageFixture, type StorageRequest, type StorageRequestFailure } from "../helpers/design-library-object-storage";
import { publishInput } from "../design-library-fixtures";

const integration = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function command(tool: string, args: string[], input?: Uint8Array): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const child = execFile(tool, args, { windowsHide: true, encoding: "buffer", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
            (error, stdout) => error ? reject(error) : resolve(stdout));
        if (input) child.stdin!.end(input);
    });
}

integration("design library previews through actual OA sessions, PostgreSQL, S3 and FFmpeg", () => {
    let pg: Awaited<ReturnType<typeof createIsolatedPostgres>>, s3: Awaited<ReturnType<typeof createDesignLibraryObjectStorageFixture>>;
    let db: Database, repository: PostgresDesignLibraryRepository, service: DesignLibraryService;
    let server: ReturnType<express.Express["listen"]>, origin: string, original: Uint8Array;
    let depth = 0, generations = 0;
    let failure = "";
    let generationHook: (() => Promise<void>) | undefined;
    let ioHook: ((request: StorageRequest) => Promise<void | StorageRequestFailure>) | undefined;
    beforeAll(async () => {
        pg = await createIsolatedPostgres(); s3 = await createDesignLibraryObjectStorageFixture();
        original = await command(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=1600x900", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"]);
        db = { query: pg.db.query, connect: async () => {
            const client = await pg.db.connect();
            return { query: async (sql: string, values: unknown[]) => {
                const result = await client.query(sql, values);
                if (sql === "BEGIN") depth++;
                if (sql === "COMMIT" || sql === "ROLLBACK") depth--;
                return result;
            }, release: () => client.release() };
        } } as unknown as Database;
        repository = new PostgresDesignLibraryRepository(db);
        service = new DesignLibraryService(repository, designLibraryObjectStorage(s3.storage), { createThumbnail: async bytes => {
            expect(depth).toBe(0);
            expect((await db.query("SELECT 1 AS available")).rows[0].available).toBe(1);
            generations++;
            await generationHook?.();
            if (failure === "encoder") throw new Error("Fixture encoder failure");
            if (failure === "format") return original;
            return (await createAssetThumbnailBytes(bytes, [256]))[256];
        } });
        s3.beforeRequest(async request => {
            expect(depth).toBe(0);
            expect((await db.query("SELECT 1 AS available")).rows[0].available).toBe(1);
            if (failure === "upload" && request.method === "PUT" && !request.source) return { status: 403, code: "FixtureThumbnailDenied" };
            return ioHook?.(request);
        });
        const cache = { get: async () => null, set: async () => "OK", del: async () => 1 } as unknown as Cache;
        const config = { OA_LOGIN_ENABLED: "true", AUTH_ENABLED: "true", CREDITS_ENABLED: "false", SESSION_COOKIE_NAME: "session", SESSION_TTL_SECONDS: 28800, NODE_ENV: "test" } as AppConfig;
        const app = express();
        app.use(["/api/design-library", "/api/admin/design-library"], designLibraryBoundary(true), express.json({ limit: "128kb" }));
        app.use(cookieParser());
        app.use("/api/design-library", sessionMiddleware(db, cache, config), requireAccountReady, createDesignLibraryRouter(service));
        app.use("/api/admin/design-library", sessionMiddleware(db, cache, config, { allowGuest: false }), requireAccountReady, createDesignLibraryRouter(service, { admin: true }));
        server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }, 40_000);
    beforeEach(() => { failure = ""; ioHook = undefined; generationHook = undefined; s3.requests.length = 0; expect(depth).toBe(0); });
    afterAll(async () => {
        server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve()));
        await s3?.close(); await pg?.close();
    });
    const actor = async (admin = false): Promise<DesignLibraryActor & { token: string }> => {
        const id = randomUUID(), token = randomUUID();
        await db.query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,$2,'Preview fixture',$3,false)", [id, `preview-${id}`, admin ? "super_admin" : "designer"]);
        await db.query("INSERT INTO sessions(id,user_id,token_hash,auth_provider,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [randomUUID(), id, hashToken(token), admin ? "local" : "oa"]);
        return { id, token, name: "Preview fixture", role: admin ? "super_admin" : "designer", kind: admin ? "admin" : "employee", departmentId: null, departmentName: null };
    };
    const request = (path: string, who: Awaited<ReturnType<typeof actor>> | null, options: RequestInit = {}) => fetch(origin + path, {
        ...options, signal: AbortSignal.timeout(10_000), headers: { ...(who ? { cookie: `session=${who.token}`, "x-canvas-owner-id": who.id } : {}), ...options.headers },
    });
    const publish = async () => {
        const author = await actor(), reader = await actor(), assetId = randomUUID(), sourceKey = `source/${assetId}.png`;
        s3.seed(sourceKey, original);
        await db.query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind,source,status) VALUES($1,$2,$3,'原始设计.png','image/png',$4,'image','upload','ready')", [assetId, author.id, sourceKey, original.length]);
        const response = await request("/api/design-library", author, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(publishInput([assetId], randomUUID())) });
        expect(response.status).toBe(200);
        const entry = (await response.json() as { data: { entry: DesignLibraryEntry } }).data.entry;
        const image = entry.images[0]!, snapshot = (await repository.getPublication(entry.id))!.images[0]!;
        return { author, reader, entry, image, snapshot, sourceKey, thumbnailKey: `${snapshot.objectKey}.library-thumb-256-v1.webp` };
    };

    test("list offers an independently decoded 256px WebP while original preview, download and reuse retain every byte", async () => {
        const h = await publish();
        const listing = await request("/api/design-library", h.reader).then(response => response.json()) as any;
        expect(listing.data.items.find((item: DesignLibraryEntry) => item.id === h.entry.id).images[0].thumbnailUrl).toBe(h.image.thumbnailUrl);
        expect(JSON.stringify(listing)).not.toContain(h.snapshot.objectKey);
        const preview = await request(h.image.thumbnailUrl!, h.reader);
        expect(preview.status).toBe(200); expect(preview.headers.get("content-type")).toStartWith("image/webp");
        const bytes = await preview.bytes();
        expect((await fileTypeFromBuffer(bytes))?.mime).toBe("image/webp");
        expect(inspectDesignLibraryImage(bytes, "image/webp")).toMatchObject({ width: 256, height: 144 });
        const decoded = JSON.parse((await command(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", "pipe:0"], bytes)).toString());
        expect(decoded.streams[0]).toMatchObject({ width: 256, height: 144 });
        await command(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-i", "pipe:0", "-frames:v", "1", "-f", "null", "-"], bytes);
        expect(bytes.length).toBeLessThan(original.length);
        expect(hash(s3.objects.get(h.sourceKey)!.bytes)).toBe(hash(original));
        expect(hash(s3.objects.get(h.snapshot.objectKey)!.bytes)).toBe(hash(original));
        expect(await request(h.image.contentUrl, h.reader).then(response => response.bytes())).toEqual(new Uint8Array(original));
        const operation = { requestId: randomUUID() };
        const download = await request(h.image.contentUrl.replace(/content$/, "download"), h.reader, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(operation) });
        expect(download.headers.get("cache-control")).toBe("private, no-store"); expect(await download.bytes()).toEqual(new Uint8Array(original));
        const reused = await service.reuse(h.reader, h.entry.id, h.image.id, { requestId: randomUUID() });
        expect(s3.objects.get((await repository.getSourceAsset(reused.assetId, h.reader.id))!.objectKey)!.bytes).toEqual(original);
    }, 15_000);

    test("conditional GET and HEAD use metadata only after real OA session validation", async () => {
        const h = await publish();
        for (const path of [h.image.thumbnailUrl!, h.image.contentUrl]) {
            const first = await request(path, h.reader), etag = first.headers.get("etag")!; await first.bytes();
            expect(etag).toStartWith('"');
            expect(first.headers.get("cache-control")).toBe("private, no-cache, must-revalidate");
            expect(first.headers.get("vary")).toContain("Cookie");
            s3.requests.length = 0;
            const hit = await request(path, h.reader, { headers: { "if-none-match": `"other", W/${etag}` } });
            expect(hit.status).toBe(304); expect((await hit.bytes()).length).toBe(0);
            expect(s3.requests.map(item => item.method)).toEqual(["HEAD"]);
            s3.requests.length = 0;
            const head = await request(path, h.reader, { method: "HEAD" });
            expect(head.status).toBe(200); expect(head.headers.get("etag")).toBe(etag); expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0);
            expect((await head.bytes()).length).toBe(0); expect(s3.requests.map(item => item.method)).toEqual(["HEAD"]);
            s3.requests.length = 0;
            const denied = await request(path, null, { headers: { "if-none-match": etag } });
            expect(denied.status).toBe(401); expect(denied.headers.get("cache-control")).toBe("private, no-store"); expect(s3.requests).toEqual([]);
        }
    });

    test("withdrawal and revoked sessions reject old ETags; authorized author/admin previews still revalidate", async () => {
        const h = await publish(), admin = await actor(true);
        const first = await request(h.image.thumbnailUrl!, h.reader), etag = first.headers.get("etag")!; await first.bytes();
        await service.withdraw(h.author, h.entry.id); s3.requests.length = 0;
        expect((await request(h.image.thumbnailUrl!, h.reader, { headers: { "if-none-match": etag } })).status).toBe(404);
        expect(s3.requests).toEqual([]);
        expect((await request(h.image.thumbnailUrl!, h.author, { headers: { "if-none-match": etag } })).status).toBe(304);
        const adminUrl = h.image.thumbnailUrl!.replace("/api/design-library/", "/api/admin/design-library/");
        expect((await request(adminUrl, admin, { headers: { "if-none-match": etag } })).status).toBe(304);
        await service.moderate(admin, h.entry.id, { reason: "Fixture takedown" });
        expect((await request(h.image.thumbnailUrl!, h.reader, { headers: { "if-none-match": "*" } })).status).toBe(404);
        await db.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1", [h.author.id]); s3.requests.length = 0;
        expect((await request(h.image.thumbnailUrl!, h.author, { headers: { "if-none-match": etag } })).status).toBe(401);
        expect(s3.requests).toEqual([]);
    });

    test("withdrawal during S3 HEAD is rechecked before a matching 304 can be emitted", async () => {
        const h = await publish(), etag = s3.objects.get(h.thumbnailKey)!.etag;
        s3.requests.length = 0;
        ioHook = async item => { if (item.method === "HEAD" && item.key === h.thumbnailKey) await service.withdraw(h.author, h.entry.id); };
        const response = await request(h.image.thumbnailUrl!, h.reader, { headers: { "if-none-match": etag } });
        expect(response.status).toBe(404); expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(s3.requests.map(item => item.method)).toEqual(["HEAD"]);
    });

    test("legacy snapshots derive a thumbnail on first read without migration or a long SQL transaction", async () => {
        const h = await publish(), before = generations;
        s3.objects.delete(h.thumbnailKey); s3.requests.length = 0;
        const response = await request(h.image.thumbnailUrl!, h.reader);
        expect(response.status).toBe(200);
        expect(inspectDesignLibraryImage(await response.bytes(), "image/webp")).toMatchObject({ width: 256, height: 144 });
        expect(generations).toBe(before + 1);
        expect(s3.requests.map(item => item.method)).toEqual(["HEAD", "GET", "PUT", "HEAD", "GET"]);
        expect((await repository.getPublication(h.entry.id))!.images[0]).toEqual(h.snapshot);
        const etag = response.headers.get("etag")!; s3.requests.length = 0;
        expect((await request(h.image.thumbnailUrl!, h.reader, { headers: { "if-none-match": etag } })).status).toBe(304);
        expect(generations).toBe(before + 1); expect(s3.requests.map(item => item.method)).toEqual(["HEAD"]);
    });

    test.each(["encoder", "format", "upload"])("preview %s failure never blocks publishing, original access or reuse", async kind => {
        failure = kind;
        const h = await publish();
        expect(s3.objects.has(h.thumbnailKey)).toBe(false);
        const preview = await request(h.image.thumbnailUrl!, h.reader);
        expect(preview.status).toBe(503); expect(await preview.json()).toMatchObject({ error: "THUMBNAIL_UNAVAILABLE" });
        expect(preview.headers.get("cache-control")).toBe("private, no-store");
        expect(await request(h.image.contentUrl, h.reader).then(response => response.bytes())).toEqual(new Uint8Array(original));
        const reused = await service.reuse(h.reader, h.entry.id, h.image.id, { requestId: randomUUID() });
        expect(s3.objects.get((await repository.getSourceAsset(reused.assetId, h.reader.id))!.objectKey)!.bytes).toEqual(original);
        if (kind === "upload") expect(s3.requests.filter(item => item.method === "DELETE").map(item => item.key)).toEqual([h.thumbnailKey]);
        failure = "";
        const recovered = await request(h.image.thumbnailUrl!, h.reader);
        expect(recovered.status).toBe(200); expect((await fileTypeFromBuffer(await recovered.bytes()))?.mime).toBe("image/webp");
    });

    test("lazy previews share same-key work, cap original reads/encoders at two and reject overload without queuing", async () => {
        const entries = [await publish(), await publish(), await publish()];
        for (const entry of entries) s3.objects.delete(entry.thumbnailKey);
        let entered = 0, release!: () => void, ready!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { ready = resolve; });
        const before = generations;
        generationHook = async () => { if (++entered === 2) ready(); await gate; };
        s3.requests.length = 0;
        const pending = entries.slice(0, 2).map(entry => request(entry.image.thumbnailUrl!, entry.reader));
        let shared: Promise<Response> | undefined;
        try {
            await started;
            const overloaded = await request(entries[2]!.image.thumbnailUrl!, entries[2]!.reader);
            expect(overloaded.status).toBe(503); expect(generations).toBe(before + 2);
            expect(s3.requests.filter(item => item.method === "GET" && entries.some(entry => entry.snapshot.objectKey === item.key))).toHaveLength(2);
            shared = request(entries[0]!.image.thumbnailUrl!, entries[0]!.reader);
            // Publication retains its original even when no preview slot is available.
            const busyPublication = await publish();
            expect(s3.objects.has(busyPublication.thumbnailKey)).toBe(false);
            expect(s3.objects.get(busyPublication.snapshot.objectKey)!.bytes).toEqual(original);
            expect(generations).toBe(before + 2);
            release();
            const responses = await Promise.all([...pending, shared]);
            for (const response of responses) { expect(response.status).toBe(200); expect((await fileTypeFromBuffer(await response.bytes()))?.mime).toBe("image/webp"); }
            expect(generations).toBe(before + 2);
            for (const entry of entries.slice(0, 2)) expect(s3.requests.filter(item => item.method === "GET" && item.key === entry.snapshot.objectKey)).toHaveLength(1);
            expect(s3.requests.filter(item => item.method === "PUT" && item.key === entries[0]!.thumbnailKey)).toHaveLength(1);
            expect(s3.objects.has(entries[2]!.thumbnailKey)).toBe(false);
            generationHook = undefined;
            const retry = await request(entries[2]!.image.thumbnailUrl!, entries[2]!.reader);
            expect(retry.status).toBe(200); await retry.bytes(); expect(generations).toBe(before + 3);
        } finally { release(); generationHook = undefined; await Promise.allSettled([...pending, ...(shared ? [shared] : [])]); }
    }, 15_000);

    test("a changed object between HEAD and GET cannot be sent under the old ETag", async () => {
        const h = await publish(); s3.requests.length = 0;
        ioHook = async item => { if (item.method === "GET" && item.key === h.snapshot.objectKey) s3.seed(h.snapshot.objectKey, new Uint8Array(original.length).fill(4)); };
        const response = await request(h.image.contentUrl, h.reader);
        expect(response.status).toBe(500);
        const get = s3.requests.find(item => item.method === "GET")!;
        expect(get.ifMatch).toBe(`"${hash(original)}"`);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
    });
});
