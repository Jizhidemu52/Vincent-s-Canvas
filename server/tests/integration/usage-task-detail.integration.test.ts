import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AppConfig } from "../../src/config";
import { createAdminUsageRouter } from "../../src/routes/usage-analytics";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const sqlSuite = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
sqlSuite("explicit task detail with owner-bound paged results", () => {
    let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
    let server: ReturnType<ReturnType<typeof express>["listen"]>;
    let base: string;
    const admin = randomUUID(),
        person = randomUUID(),
        other = randomUUID(),
        task = randomUUID(),
        otherTask = randomUUID();
    const good = randomUUID(),
        wrongOwner = randomUUID(),
        wrongTask = randomUUID(),
        missingThumb = randomUUID();
    const path = (uid: string = person, tid: string = task) => `${base}/people/${uid}/tasks/${tid}`;
    const get = (suffix = "", identity = "admin", uid = person) =>
        fetch(`${path(uid)}${suffix}`, { headers: { "x-identity": identity } });
    beforeAll(async () => {
        fixture = await createIsolatedPostgres();
        for (const [id, name, role] of [
            [admin, "detail-admin", "super_admin"],
            [person, "detail-person", "designer"],
            [other, "detail-other", "designer"],
        ])
            await fixture.db.query(
                "INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,$2::text,$2::text,$3,false)",
                [id, name, role],
            );
        for (const id of [task, otherTask])
            await fixture.db.query(
                "INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,prompt,user_input,parameters,status,queued_at,started_at,completed_at) VALUES($1,$1::uuid::text,$2,'private-project','image_generation','PRIVATE_PROMPT','{\"userText\":\"PRIVATE_USER_INPUT\",\"fields\":{\"private\":\"PRIVATE_FIELDS\"}}',$3,'success','2026-10-01T01:00:00Z','2026-10-01T01:00:03Z','2026-10-01T01:00:08Z')",
                [
                    id,
                    person,
                    JSON.stringify({
                        size: "1024x1024",
                        n: 4,
                        seed: 17,
                        token: "PRIVATE_TOKEN",
                        prompt: "PRIVATE_NESTED_PROMPT",
                        mask: "data:image/PRIVATE_MASK",
                        quality: "high",
                    }),
                ],
            );
        for (const [id, owner, tid, thumb] of [
            [good, person, task, true],
            [wrongOwner, other, task, true],
            [wrongTask, person, otherTask, true],
            [missingThumb, person, task, false],
        ] as const)
            await fixture.db.query(
                "INSERT INTO assets(id,owner_user_id,task_id,object_key,filename,mime_type,kind,status,thumbnail_256_key,thumbnail_1024_key,prompt,metadata) VALUES($1,$2,$3,$1::uuid::text,'PRIVATE_FILENAME','image/png','image','ready',$4,$5,'PRIVATE_ASSET_PROMPT',$6)",
                [
                    id,
                    owner,
                    tid,
                    thumb ? `${id}/thumb256` : null,
                    thumb ? `${id}/thumb1024` : null,
                    JSON.stringify({
                        prompt: "PRIVATE_METADATA",
                        imageResult: { version: 1, role: "primary", resultIndex: 0 },
                    }),
                ],
            );
        const results = [
            `/api/assets/${good}/content`,
            `/api/assets/${wrongOwner}/content`,
            `/api/assets/${wrongTask}/content`,
            "https://private.invalid/PRIVATE_EXTERNAL.png",
            `/api/assets/${missingThumb}/content`,
            ...Array.from({ length: 10 }, () => `/api/assets/${good}/content`),
        ];
        await fixture.db.query("UPDATE tasks SET result_urls=$2::jsonb WHERE id=$1", [task, JSON.stringify(results)]);
        await fixture.db.query(
            "INSERT INTO generation_history(task_id,user_id,project_id,operation_type,prompt,parameters,source_urls,result_urls,credits,rmb_cost,status) SELECT id,user_id,project_id,operation_type,prompt,parameters,source_urls,result_urls,0,0.234567,'success' FROM tasks WHERE id=$1",
            [task],
        );
        const adoption = randomUUID();
        for (const [id, type, sourceId] of [
            [randomUUID(), "asset.downloaded", null],
            [adoption, "asset.adopted", null],
            [randomUUID(), "asset.event_reversed", adoption],
        ] as const)
            await fixture.db.query(
                "INSERT INTO asset_events(id,asset_id,designer_user_id,task_id,event_type,source_event_id,idempotency_key,prompt,metadata) VALUES($1,$2,$3,$4,$5,$6,$1::uuid::text,'PRIVATE_EVENT_PROMPT','{\"private\":\"PRIVATE_EVENT_META\"}')",
                [id, good, person, task, type, sourceId],
            );
        // Wrong-owner and wrong-task events must not appear as evidence for this result.
        await fixture.db.query(
            "INSERT INTO asset_events(asset_id,designer_user_id,task_id,event_type,idempotency_key) VALUES($1,$2,$3,'asset.delivered',$4),($1,$5,$6,'asset.adopted',$7)",
            [good, other, task, randomUUID(), person, otherTask, randomUUID()],
        );
        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            const identity = request.header("x-identity");
            if (identity !== "anonymous")
                Object.assign(request, {
                    auth: {
                        id: admin,
                        role:
                            identity === "designer"
                                ? "designer"
                                : identity === "department-admin"
                                  ? "department_admin"
                                  : "super_admin",
                    },
                    ...(identity === "trial" ? { allowsAnonymousCreation: true } : {}),
                });
            next();
        });
        app.use("/api/admin/usage", createAdminUsageRouter(fixture.db, {} as AppConfig));
        server = app.listen(0, "127.0.0.1");
        await new Promise<void>((resolve) => server.once("listening", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("fixture port");
        base = `http://127.0.0.1:${address.port}/api/admin/usage`;
    }, 120000);
    afterAll(async () => {
        server?.closeAllConnections();
        if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
        await fixture?.close();
    });
    test("detail denies other roles and wrong person-task pairs without leaking saved private content", async () => {
        for (const identity of ["anonymous", "designer", "department-admin", "trial"]) {
            const before = fixture.statements.length;
            const response = await get("", identity);
            expect(response.status).toBe(403);
            expect(fixture.statements.length).toBe(before);
        }
        const response = await get("", "admin", other);
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain("PRIVATE_");
    });
    test("first detail page exposes only safe parameters and valid same-owner same-task asset identities", async () => {
        const response = await get();
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const body = (await response.json()).data;
        expect(body).toMatchObject({
            userId: person,
            taskId: task,
            timing: { waitMs: 3000, runMs: 5000, totalMs: 8000 },
            bookedCny: "0.234567",
            parameters: { size: "1024x1024", n: 4, seed: 17, quality: "high" },
            results: { pagination: { page: 1, pageSize: 12, total: 15 } },
        });
        expect(body.results.items).toHaveLength(12);
        expect(body.results.items[0]).toMatchObject({
            position: 1,
            assetId: good,
            thumbnailAvailable: true,
            previewAvailable: true,
            evidence: [{ eventType: "asset.downloaded", count: 1, basis: "client_reported" }],
        });
        for (const index of [1, 2, 3])
            expect(body.results.items[index]).toMatchObject({
                assetId: null,
                thumbnailAvailable: false,
                previewAvailable: false,
                evidence: [],
            });
        expect(body.results.items[4]).toMatchObject({
            assetId: missingThumb,
            thumbnailAvailable: false,
            previewAvailable: false,
        });
        const serialized = JSON.stringify(body);
        for (const secret of ["PRIVATE_", "private.invalid", wrongOwner, wrongTask, "object_key", "/content"])
            expect(serialized).not.toContain(secret);
        const audit = (
            await fixture.db.query(
                "SELECT detail FROM audit_logs WHERE action='usage.v2.task.viewed' ORDER BY created_at DESC LIMIT 1",
            )
        ).rows[0];
        expect(audit.detail).toMatchObject({ userId: person, taskId: task, page: 1, resultCount: 12 });
        expect(JSON.stringify(audit)).not.toContain("PRIVATE_");
    });
    test("result pagination is explicit and bounded, not prefetched and not confused with unique generated image counts", async () => {
        const response = await get("?page=2&pageSize=12");
        expect(response.status).toBe(200);
        const body = (await response.json()).data;
        expect(body.results.items).toHaveLength(3);
        expect(body.results.items.map((item: any) => item.position)).toEqual([13, 14, 15]);
        for (const query of ["?page=0", "?pageSize=25", "?page=1&includePrompt=true"])
            expect((await get(query)).status).toBe(400);
    });
    test("raw prompt has a separate explicit confirmation and audit and cannot cross the selected person", async () => {
        const send = (uid: string, body: unknown) =>
            fetch(`${path(uid)}/prompt`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            });
        expect((await send(person, { confirm: false })).status).toBe(400);
        expect((await send(other, { confirm: true })).status).toBe(404);
        const response = await send(person, { confirm: true });
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect((await response.json()).data).toMatchObject({
            userId: person,
            taskId: task,
            prompt: "PRIVATE_PROMPT",
            userInput: "PRIVATE_USER_INPUT",
            truncated: false,
        });
        const audit = (
            await fixture.db.query(
                "SELECT detail FROM audit_logs WHERE action='usage.v2.task.prompt_viewed' ORDER BY created_at DESC LIMIT 1",
            )
        ).rows[0];
        expect(audit.detail).toMatchObject({ userId: person, taskId: task });
        expect(JSON.stringify(audit)).not.toContain("PRIVATE_");
    });
    test("missing or invalid fields stay unavailable and a history row attributed to another employee cannot supply cost", async () => {
        const missing = randomUUID();
        await fixture.db.query(
            "INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,prompt,parameters,status,source_urls,result_urls,queued_at,started_at,completed_at) VALUES($1,$1::uuid::text,$2,'fixture','image_generation','PRIVATE_MISSING_PROMPT',$3,'success','null','null','2026-10-01T01:00:08Z','2026-10-01T01:00:03Z','2026-10-01T01:00:00Z')",
            [missing, person, JSON.stringify({ size: "PRIVATE_NOT_A_SIZE", quality: { prompt: "PRIVATE_NESTED" } })],
        );
        await fixture.db.query(
            "INSERT INTO generation_history(task_id,user_id,project_id,operation_type,prompt,source_urls,result_urls,credits,rmb_cost,status) VALUES($1,$2,'fixture','image_generation','PRIVATE_OTHER_PROMPT','[]','[]',0,99,'success')",
            [missing, other],
        );
        const response = await fetch(path(person, missing));
        expect(response.status).toBe(200);
        const body = (await response.json()).data;
        expect(body).toMatchObject({
            bookedCny: null,
            parameters: {},
            submittedReferenceCount: null,
            timing: { waitMs: null, runMs: null, totalMs: null },
            results: { available: false, items: [], pagination: { total: 0 } },
        });
        expect(JSON.stringify(body)).not.toContain("PRIVATE_");
    });
});
