import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Database } from "../../src/db";
import { DesignLibraryService, type DesignLibraryActor, type DesignLibraryRepository } from "../../src/design-library";
import { designLibraryObjectStorage, PostgresDesignLibraryRepository } from "../../src/design-library-postgres";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
import { createDesignLibraryObjectStorageFixture, type StorageRequest } from "../helpers/design-library-object-storage";
import { png, publishInput } from "../design-library-fixtures";

const integration = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
integration("design library external I/O with real PostgreSQL and production S3 transport", () => {
    let pg: Awaited<ReturnType<typeof createIsolatedPostgres>>;
    let s3: Awaited<ReturnType<typeof createDesignLibraryObjectStorageFixture>>;
    let db: Database, repository: DesignLibraryRepository, service: DesignLibraryService;
    let transactionDepth = 0;
    let ioHook: ((request: StorageRequest) => Promise<void>) | undefined;
    let failInsert = "";
    beforeAll(async () => {
        pg = await createIsolatedPostgres();
        s3 = await createDesignLibraryObjectStorageFixture();
        db = { query: pg.db.query, connect: async () => {
            const client = await pg.db.connect();
            return { query: async (sql: string, values: unknown[]) => {
                if (failInsert && sql.startsWith(failInsert)) throw new Error("Fixture persistence failure");
                const result = await client.query(sql, values);
                if (sql === "BEGIN") transactionDepth++;
                if (sql === "COMMIT" || sql === "ROLLBACK") transactionDepth--;
                return result;
            }, release: () => client.release() };
        } } as unknown as Database;
        repository = new PostgresDesignLibraryRepository(db);
        service = new DesignLibraryService(repository, designLibraryObjectStorage(s3.storage));
        s3.beforeRequest(async request => {
            expect(transactionDepth).toBe(0);
            // The single PostgreSQL connection must remain usable during every external I/O.
            expect((await db.query("SELECT 1 AS available")).rows[0].available).toBe(1);
            await ioHook?.(request);
        });
    }, 30_000);
    beforeEach(() => { s3.requests.length = 0; ioHook = undefined; failInsert = ""; expect(transactionDepth).toBe(0); });
    afterAll(async () => { await s3?.close(); await pg?.close(); });
    const row = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows[0];
    const actor = async (admin = false): Promise<DesignLibraryActor> => {
        const id = randomUUID();
        await db.query("INSERT INTO users(id,username,display_name,role) VALUES($1,$2,'Library fixture',$3)", [id, `library-${id}`, admin ? "super_admin" : "designer"]);
        return { id, name: "Library fixture", departmentId: null, departmentName: null, role: admin ? "super_admin" : "designer", kind: admin ? "admin" : "employee" };
    };
    const source = async (owner: DesignLibraryActor) => {
        const id = randomUUID(), key = `private/${owner.id}/${id}/设计 +?#%.png`;
        s3.seed(key, png);
        await db.query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind,source,status,metadata) VALUES($1,$2,$3,'原图.png','image/png',$4,'image','upload','ready',$5::jsonb)",
            [id, owner.id, key, png.length, JSON.stringify({ privateCanvasId: "never-copy", privatePrompt: "never-copy" })]);
        return { id, key };
    };
    const publication = async () => {
        const author = await actor(), original = await source(author);
        const entry = await service.publish(author, publishInput([original.id], randomUUID()));
        return { author, original, entry, image: entry.images[0]! };
    };
    const twoCopies = () => {
        let count = 0, release!: () => void;
        const ready = new Promise<void>(resolve => { release = resolve; });
        return async (request: StorageRequest) => {
            if (request.method !== "PUT" || !request.source) return;
            if (++count === 2) release();
            await ready;
        };
    };

    test("publish/reuse/download preserve original bytes without holding SQL transactions or reading reused bytes through the app", async () => {
        const { author, original, entry, image } = await publication();
        const reader = await actor();
        const snapshot = (await repository.getPublication(entry.id))!.images[0]!;
        expect(s3.requests.map(request => request.method)).toEqual(["GET", "PUT", "PUT"]);
        expect(s3.requests.filter(request => request.method === "PUT" && request.source)).toHaveLength(1);
        expect(s3.objects.has(`${snapshot.objectKey}.library-thumb-256-v1.webp`)).toBe(true);
        expect(s3.objects.get(snapshot.objectKey)!.bytes).toEqual(png);
        await db.query("DELETE FROM assets WHERE id=$1", [original.id]); s3.objects.delete(original.key);
        s3.requests.length = 0;
        const reused = await service.reuse(reader, entry.id, image.id, { requestId: randomUUID() });
        expect(s3.requests.map(request => request.method)).toEqual(["HEAD", "PUT"]);
        const asset = await row("SELECT owner_user_id,visibility_scope,metadata,object_key FROM assets WHERE id=$1", [reused.assetId]);
        expect(asset.owner_user_id).toBe(reader.id); expect(asset.visibility_scope).toBe("private");
        expect(asset.metadata).toEqual({ designLibrarySource: reused.source, width: 1, height: 1 });
        expect(s3.objects.get(asset.object_key)!.bytes).toEqual(png);
        const download = await service.download(reader, entry.id, image.id, { requestId: randomUUID() });
        expect(download.bytes).toEqual(png);
        expect((await service.stats(author, entry.id, {})).totals.download.count).toBe(0);
        expect(transactionDepth).toBe(0);
    });

    test("concurrent identical publication and reuse commit one record and clean only their losing staged copy", async () => {
        const author = await actor(), original = await source(author), input = publishInput([original.id], randomUUID());
        ioHook = twoCopies();
        const entries = await Promise.all([service.publish(author, input), service.publish(author, input)]);
        expect(entries[0]!.id).toBe(entries[1]!.id);
        const entry = entries[0]!, snapshot = (await repository.getPublication(entry.id))!.images[0]!;
        expect(s3.requests.filter(request => request.method === "PUT" && request.source)).toHaveLength(2);
        expect(s3.requests.filter(request => request.method === "PUT" && !request.source)).toHaveLength(2);
        expect(s3.requests.filter(request => request.method === "DELETE")).toHaveLength(2);
        expect(s3.objects.has(snapshot.objectKey)).toBe(true);
        expect(s3.objects.has(`${snapshot.objectKey}.library-thumb-256-v1.webp`)).toBe(true);
        expect((await row("SELECT count(*)::int AS count FROM design_library_publications WHERE author_id=$1", [author.id])).count).toBe(1);
        const reader = await actor(); s3.requests.length = 0; ioHook = twoCopies();
        const operation = { requestId: randomUUID() };
        const copies = await Promise.all([service.reuse(reader, entry.id, snapshot.id, operation), service.reuse(reader, entry.id, snapshot.id, operation)]);
        expect(copies[0]!.assetId).toBe(copies[1]!.assetId);
        expect(s3.requests.filter(request => request.method === "PUT")).toHaveLength(2);
        expect(s3.requests.filter(request => request.method === "DELETE")).toHaveLength(1);
        expect((await row("SELECT count(*)::int AS count FROM assets WHERE owner_user_id=$1", [reader.id])).count).toBe(1);
        for (const request of s3.requests.filter(request => request.method === "DELETE")) expect(s3.objects.has(request.key)).toBe(false);
        expect(s3.objects.has(original.key)).toBe(true); expect(s3.objects.has(snapshot.objectKey)).toBe(true);
    }, 15_000);

    test.each(["owner", "deleted", "status", "kind", "key", "size", "mime", "filename"])("publish rechecks changed source %s after copying and before committing", async field => {
        const author = await actor(), original = await source(author), other = await actor();
        const assignment: Record<string, { sql: string; value: unknown }> = {
            owner: { sql: "owner_user_id=$2", value: other.id }, deleted: { sql: "deleted_at=$2", value: new Date().toISOString() },
            status: { sql: "status=$2", value: "pending" }, kind: { sql: "kind=$2", value: "video" },
            key: { sql: "object_key=$2", value: `changed/${original.id}` }, size: { sql: "byte_size=$2", value: png.length + 1 },
            mime: { sql: "mime_type=$2", value: "image/jpeg" }, filename: { sql: "filename=$2", value: "changed.png" },
        };
        ioHook = async request => {
            if (request.method === "PUT" && request.source === original.key) {
                const change = assignment[field]!;
                await db.query(`UPDATE assets SET ${change.sql} WHERE id=$1`, [original.id, change.value]);
            }
        };
        await expect(service.publish(author, publishInput([original.id], randomUUID()))).rejects.toMatchObject({ code:
            ["owner", "deleted", "status", "kind"].includes(field) ? "SOURCE_ASSET_FORBIDDEN" : "SOURCE_ASSET_CHANGED" });
        expect((await row("SELECT count(*)::int AS count FROM design_library_publications WHERE author_id=$1", [author.id])).count).toBe(0);
        const copied = s3.requests.find(request => request.method === "PUT")!;
        expect(s3.objects.has(copied.key)).toBe(false); expect(s3.objects.has(original.key)).toBe(true);
    });

    test.each(["reuse-withdraw", "download-withdraw", "reuse-takedown", "download-takedown"])("state changes during I/O block %s and leave no delivery", async action => {
        const { author, entry, image } = await publication();
        const reader = await actor(), admin = await actor(true);
        s3.requests.length = 0;
        ioHook = async request => {
            if (request.method !== (action.startsWith("reuse") ? "PUT" : "GET")) return;
            if (action.endsWith("withdraw")) await service.withdraw(author, entry.id);
            else await service.moderate(admin, entry.id, { reason: "Fixture moderation" });
        };
        const operation = { requestId: randomUUID() };
        const result = action.startsWith("reuse") ? service.reuse(reader, entry.id, image.id, operation) : service.download(reader, entry.id, image.id, operation);
        await expect(result).rejects.toMatchObject({ code: "PUBLICATION_UNAVAILABLE" });
        expect((await row("SELECT count(*)::int AS count FROM design_library_deliveries WHERE entry_id=$1", [entry.id])).count).toBe(0);
        expect((await row("SELECT count(*)::int AS count FROM assets WHERE owner_user_id=$1", [reader.id])).count).toBe(0);
        if (action.startsWith("reuse")) expect(s3.objects.has(s3.requests.find(request => request.method === "PUT")!.key)).toBe(false);
    });

    test.each(["missing", "unavailable"])("unknown COMMIT acknowledgement never deletes media when recovery lookup is %s", async lookup => {
        const author = await actor(), original = await source(author), input = publishInput([original.id], randomUUID());
        const transaction = repository.transaction.bind(repository), find = repository.findPublication.bind(repository), delivery = repository.getDelivery.bind(repository);
        let uncertain = false;
        const lost = async <T>(work: Parameters<typeof repository.transaction<T>>[0]) => {
            await transaction(work); uncertain = true; throw new Error("Lost COMMIT acknowledgement");
        };
        const recovery = () => { if (lookup === "unavailable") throw new Error("Recovery temporarily unavailable"); return null; };
        try {
            repository.transaction = lost;
            repository.findPublication = async (...args) => uncertain ? recovery() : find(...args);
            await expect(service.publish(author, input)).rejects.toThrow("Lost COMMIT acknowledgement");
            expect(s3.requests.filter(request => request.method === "DELETE")).toHaveLength(0);
            repository.transaction = transaction; repository.findPublication = find;
            const entry = await service.publish(author, input), reader = await actor(), operation = { requestId: randomUUID() };
            expect(s3.objects.has((await repository.getPublication(entry.id))!.images[0]!.objectKey)).toBe(true);
            uncertain = false; repository.transaction = lost;
            repository.getDelivery = async (...args) => uncertain ? recovery() : delivery(...args);
            await expect(service.reuse(reader, entry.id, entry.images[0]!.id, operation)).rejects.toThrow("Lost COMMIT acknowledgement");
            expect(s3.requests.filter(request => request.method === "DELETE")).toHaveLength(0);
            repository.transaction = transaction; repository.getDelivery = delivery;
            const reused = await service.reuse(reader, entry.id, entry.images[0]!.id, operation);
            expect(s3.objects.get((await repository.getSourceAsset(reused.assetId, reader.id))!.objectKey)!.bytes).toEqual(png);
            expect(s3.requests.filter(request => request.method === "PUT" && request.source)).toHaveLength(2);
            expect(s3.requests.filter(request => request.method === "PUT" && !request.source)).toHaveLength(1);
        } finally { repository.transaction = transaction; repository.findPublication = find; repository.getDelivery = delivery; }
    });

    test.each(["withdrawn", "private-asset-deleted"])("a concurrent existing delivery cannot bypass %s during recovery", async state => {
        const { author, entry, image } = await publication(), reader = await actor(), operation = { requestId: randomUUID() };
        let winner = "", staged = "";
        ioHook = async request => {
            if (request.method !== "PUT" || !request.source || staged) return;
            staged = request.key;
            winner = (await service.reuse(reader, entry.id, image.id, operation)).assetId;
            if (state === "withdrawn") await service.withdraw(author, entry.id);
            else await db.query("UPDATE assets SET deleted_at=now() WHERE id=$1", [winner]);
        };
        await expect(service.reuse(reader, entry.id, image.id, operation)).rejects.toMatchObject({
            code: state === "withdrawn" ? "PUBLICATION_UNAVAILABLE" : "SOURCE_ASSET_FORBIDDEN",
        });
        expect(s3.objects.has(staged)).toBe(false);
        expect(s3.objects.has((await repository.getSourceAsset(winner, reader.id))!.objectKey)).toBe(true);
        expect((await row("SELECT count(*)::int AS count FROM assets WHERE owner_user_id=$1", [reader.id])).count).toBe(1);
    });

    test("definite SQL rollback cleans attempted publication and private copy without changing source objects", async () => {
        const author = await actor(), original = await source(author), input = publishInput([original.id], randomUUID());
        failInsert = "INSERT INTO design_library_publications";
        await expect(service.publish(author, input)).rejects.toThrow("Fixture persistence failure");
        expect(s3.objects.has(s3.requests.find(request => request.method === "PUT")!.key)).toBe(false);
        expect(s3.objects.has(original.key)).toBe(true);
        failInsert = "";
        const entry = await service.publish(author, input), reader = await actor(); s3.requests.length = 0;
        failInsert = "INSERT INTO assets";
        await expect(service.reuse(reader, entry.id, entry.images[0]!.id, { requestId: randomUUID() })).rejects.toThrow("Fixture persistence failure");
        expect(s3.objects.has(s3.requests.find(request => request.method === "PUT")!.key)).toBe(false);
        expect((await row("SELECT count(*)::int AS count FROM design_library_deliveries WHERE entry_id=$1", [entry.id])).count).toBe(0);
        expect(s3.objects.has((await repository.getPublication(entry.id))!.images[0]!.objectKey)).toBe(true);
    });
});
