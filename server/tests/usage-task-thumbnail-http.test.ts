import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import express from "express";
import type { ObjectStorage } from "../src/object-storage";
import { createAssetsRouter } from "../src/routes/assets";
import type { AuthenticatedRequest, SessionUser } from "../src/types";
import { createIsolatedPostgres } from "./helpers/isolated-postgres";

const sqlSuite = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
const original = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=", "base64");
const derivative = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=", "base64");

sqlSuite("usage task thumbnail HTTP isolation", () => {
    let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
    let server: ReturnType<ReturnType<typeof express>["listen"]>;
    let base: string;
    const admin = randomUUID(), person = randomUUID(), other = randomUUID();
    const task = randomUUID(), anotherTask = randomUUID(), otherPersonTask = randomUUID();
    const good = randomUUID(), wrongOwner = randomUUID(), wrongTask = randomUUID(), inconsistentTaskOwner = randomUUID();
    const pending = randomUUID(), exhausted = randomUUID(), leased = randomUUID();
    const objects = new Map<string, Buffer>();
    const storageReads: Array<{ method: "head" | "get"; key: string }> = [];
    const objectBytes = (key: string) => {
        const bytes = objects.get(key);
        if (!bytes) throw new Error("Unexpected synthetic storage key");
        return bytes;
    };
    const boundQuery = (userId: string = person, taskId: string = task) => `usageUserId=${userId}&usageTaskId=${taskId}`;
    const get = (assetId: string = good, query = boundQuery(), init?: RequestInit) => fetch(`${base}/${assetId}/thumb?${query}`, init);

    beforeAll(async () => {
        fixture = await createIsolatedPostgres();
        for (const [id, name, role] of [[admin, "thumbnail-admin", "super_admin"], [person, "thumbnail-person", "designer"], [other, "thumbnail-other", "designer"]])
            await fixture.db.query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,$2::text,$2::text,$3,false)", [id, name, role]);
        for (const [id, userId] of [[task, person], [anotherTask, person], [otherPersonTask, other]])
            await fixture.db.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,prompt,parameters,status) VALUES($1,$1::uuid::text,$2,'private-project','image_generation','PRIVATE_PROMPT','{}','success')", [id, userId]);
        const assets = [
            { id: good, owner: person, taskId: task, ready: true },
            { id: wrongOwner, owner: other, taskId: task, ready: true },
            { id: wrongTask, owner: person, taskId: anotherTask, ready: true },
            { id: inconsistentTaskOwner, owner: person, taskId: otherPersonTask, ready: true },
            { id: pending, owner: person, taskId: task, ready: false },
            { id: exhausted, owner: person, taskId: task, ready: false },
            { id: leased, owner: person, taskId: task, ready: false },
        ];
        for (const asset of assets) {
            const originalKey = `${asset.id}/PRIVATE_ORIGINAL`, smallKey = `${asset.id}/thumb-256.webp`, largeKey = `${asset.id}/thumb-1024.webp`;
            objects.set(originalKey, original);
            if (asset.ready) { objects.set(smallKey, derivative); objects.set(largeKey, derivative); }
            await fixture.db.query("INSERT INTO assets(id,owner_user_id,task_id,object_key,filename,mime_type,kind,status,visibility_scope,thumbnail_256_key,thumbnail_1024_key,thumbnail_attempts,thumbnail_lease_token) VALUES($1,$2,$3,$4,'PRIVATE_FILENAME.png','image/png','image','ready','private',$5,$6,$7,$8)",
                [asset.id, asset.owner, asset.taskId, originalKey, asset.ready ? smallKey : null, asset.ready ? largeKey : null, [exhausted, leased].includes(asset.id) ? 4 : 0, asset.id === leased ? randomUUID() : null]);
        }
        const storage = {
            head: async (key: string) => {
                storageReads.push({ method: "head", key });
                return { ContentLength: objectBytes(key).length, ETag: '"synthetic-object"' };
            },
            get: async (key: string, options?: { range?: string }) => {
                storageReads.push({ method: "get", key });
                const bytes = objectBytes(key);
                const range = options?.range && /^bytes=(\d+)-(\d+)$/.exec(options.range);
                const body = range ? bytes.subarray(Number(range[1]), Number(range[2]) + 1) : bytes;
                return { ContentLength: body.length, Body: Readable.from([body]), ETag: '"synthetic-object"', ...(range ? { ContentRange: `bytes ${range[1]}-${range[2]}/${bytes.length}` } : {}) };
            },
        } as unknown as ObjectStorage;
        const app = express();
        app.use((request, _response, next) => {
            const identity = request.header("x-identity");
            (request as AuthenticatedRequest).auth = { id: identity === "owner" ? person : identity === "other" ? other : admin, role: identity ? "designer" : "super_admin", departmentId: null, groupId: null, groupRole: null } as SessionUser;
            next();
        });
        app.use("/api/assets", createAssetsRouter(fixture.db, storage));
        app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
            response.status(error.name === "ZodError" ? 400 : 500).json({ code: error.name === "ZodError" ? "INVALID_REQUEST" : "TEST_ERROR" });
        });
        server = app.listen(0, "127.0.0.1");
        await new Promise<void>((resolve) => server.once("listening", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("fixture port");
        base = `http://127.0.0.1:${address.port}/api/assets`;
    }, 120_000);

    afterAll(async () => {
        server?.closeAllConnections();
        if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
        await fixture?.close();
    });

    test("rejects incomplete or malformed usage bindings before querying assets or storage", async () => {
        for (const query of [
            `usageUserId=${person}`,
            `usageTaskId=${task}`,
            `usageUserId=not-a-uuid&usageTaskId=${task}`,
            `usageUserId=${person}&usageTaskId=not-a-uuid`,
            `usageUserId=&usageTaskId=${task}`,
            `${boundQuery()}&usageUserId=${other}`,
        ]) {
            const beforeQueries = fixture.statements.length, beforeReads = storageReads.length;
            const response = await get(good, query);
            expect(response.status).toBe(400);
            expect(fixture.statements.length).toBe(beforeQueries);
            expect(storageReads.length).toBe(beforeReads);
        }
    });

    test("rejects wrong employee, wrong task and a task not owned by the selected employee", async () => {
        for (const [assetId, query] of [
            [wrongOwner, boundQuery()],
            [wrongTask, boundQuery()],
            [good, boundQuery(other, task)],
            [good, boundQuery(person, anotherTask)],
            [inconsistentTaskOwner, boundQuery(person, otherPersonTask)],
        ]) {
            const before = storageReads.length;
            const response = await get(assetId, query);
            expect(response.status).toBe(404);
            expect(await response.text()).not.toContain("PRIVATE_");
            expect(storageReads.length).toBe(before);
        }
    });

    test("retains asset authorization before GET, HEAD and conditional responses", async () => {
        const deniedRequests: RequestInit[] = [
            { headers: { "x-identity": "other" } },
            { method: "HEAD", headers: { "x-identity": "other" } },
            { headers: { "x-identity": "other", "if-none-match": '"synthetic-object"' } },
        ];
        for (const init of deniedRequests) {
            const before = storageReads.length;
            const response = await get(good, boundQuery(), init);
            expect(response.status).toBe(404);
            expect(response.headers.get("etag")).toBeNull();
            expect(storageReads.length).toBe(before);
        }
        const ownerResponse = await get(good, boundQuery(), { headers: { "x-identity": "owner" } });
        expect(ownerResponse.status).toBe(200);
        expect(Buffer.from(await ownerResponse.arrayBuffer())).toEqual(derivative);
    });

    test("both display sizes stream only their derived object, never the stored original", async () => {
        for (const width of [256, 1024]) {
            const before = storageReads.length;
            const response = await get(good, `${boundQuery()}&w=${width}`);
            expect(response.status).toBe(200);
            expect(response.headers.get("cache-control")).toBe("no-store");
            expect(response.headers.get("content-type")).toBe("image/webp");
            expect(Buffer.from(await response.arrayBuffer())).toEqual(derivative);
            expect(storageReads.slice(before)).toEqual([
                { method: "head", key: `${good}/thumb-${width}.webp` },
                { method: "get", key: `${good}/thumb-${width}.webp` },
            ]);
        }
    });

    test("bound HEAD and conditional responses also forbid storage by the browser", async () => {
        const before = storageReads.length;
        const head = await get(good, boundQuery(), { method: "HEAD" });
        expect(head.status).toBe(200);
        expect(head.headers.get("cache-control")).toBe("no-store");
        expect(head.headers.get("content-type")).toBe("image/webp");
        expect(await head.text()).toBe("");
        expect(storageReads.slice(before)).toEqual([
            { method: "head", key: `${good}/thumb-256.webp` },
            { method: "get", key: `${good}/thumb-256.webp` },
        ]);
        const beforeConditional = storageReads.length;
        const cached = await get(good, boundQuery(), { headers: { "if-none-match": '"synthetic-object"' } });
        expect(cached.status).toBe(304);
        expect(cached.headers.get("cache-control")).toBe("no-store");
        expect(storageReads.slice(beforeConditional)).toEqual([{ method: "head", key: `${good}/thumb-256.webp` }]);
    });

    test("missing bound thumbnails return pending without requiring pending=1 or reading the original", async () => {
        for (const assetId of [pending, leased]) {
            for (const width of [256, 1024]) {
                const before = storageReads.length;
                const response = await get(assetId, `${boundQuery()}&w=${width}`);
                expect(response.status).toBe(202);
                expect(response.headers.get("retry-after")).toBe("3");
                expect(response.headers.get("cache-control")).toBe("no-store");
                expect(await response.text()).toBe("");
                expect(storageReads.length).toBe(before);
            }
        }
    });

    test("exhausted bound thumbnails return 422 without falling back to originals", async () => {
        const before = storageReads.length;
        const response = await get(exhausted);
        expect(response.status).toBe(422);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.text()).toBe("");
        expect(storageReads.length).toBe(before);
    });

    test("calls without usage bindings preserve legacy original fallback and pending opt-in", async () => {
        const before = storageReads.length;
        const legacy = await get(pending, "w=256");
        expect(legacy.status).toBe(200);
        expect(legacy.headers.get("cache-control")).toBe("private, no-cache");
        expect(legacy.headers.get("content-type")).toBe("image/png");
        expect(Buffer.from(await legacy.arrayBuffer())).toEqual(original);
        expect(storageReads.slice(before)).toEqual([
            { method: "head", key: `${pending}/PRIVATE_ORIGINAL` },
            { method: "get", key: `${pending}/PRIVATE_ORIGINAL` },
        ]);
        const afterLegacy = storageReads.length;
        const optedIn = await get(pending, "w=256&pending=1");
        expect(optedIn.status).toBe(202);
        expect(storageReads.length).toBe(afterLegacy);
        const unrelated = await get(wrongOwner, "w=1024");
        expect(unrelated.status).toBe(200);
        expect(Buffer.from(await unrelated.arrayBuffer())).toEqual(derivative);
    });
});
