import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler } from "express";
import { reserveCredits } from "../../src/billing";
import type { Cache, Database } from "../../src/db";
import { createTaskReconciliationRouter } from "../../src/routes/task-reconciliation";
import { queueScore, restoreWaitingTasksToQueue } from "../../src/tasks";

const runtime = process.env.PGLITE_RUNTIME_PATH;
const integration = runtime ? describe : describe.skip;
const evidence = { reason: "已核对供应商记录", evidenceReference: "supplier-ticket:fixture-123" };

integration("auditable administrator reconciliation using isolated PostgreSQL and HTTP", () => {
    let database: any;
    let db: Database;
    let server: ReturnType<ReturnType<typeof express>["listen"]>;
    let base: string;
    const adminId = randomUUID();
    const modelId = randomUUID();
    const providerId = randomUUID();
    let cacheFails = false;
    const cacheCalls: Array<{ keys: string[]; arguments: string[] }> = [];
    const removedSlots: Array<[string, string]> = [];
    const cache = {
        eval: async (_script: string, options: { keys: string[]; arguments: string[] }) => {
            if (cacheFails) throw new Error("Fixture cache unavailable");
            cacheCalls.push(options); return 1;
        },
        zRem: async (key: string, member: string) => { removedSlots.push([key, member]); return 1; },
    } as unknown as Cache;
    beforeAll(async () => {
        const requireRuntime = createRequire(resolve(runtime!, "package.json"));
        const { PGlite } = requireRuntime("@electric-sql/pglite");
        const { pgcrypto } = requireRuntime("@electric-sql/pglite/contrib/pgcrypto");
        const { citext } = requireRuntime("@electric-sql/pglite/contrib/citext");
        database = new PGlite({ extensions: { pgcrypto, citext } });
        await database.waitReady;
        const migrations = fileURLToPath(new URL("../../src/migrations/", import.meta.url));
        for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) await database.exec(await readFile(`${migrations}/${name}`, "utf8"));
        const query = async (sql: string, values: unknown[] = []) => {
            const result = await database.query(sql, values);
            return { ...result, rowCount: result.affectedRows ?? result.rows.length };
        };
        let tail = Promise.resolve();
        db = { query, connect: async () => {
            const previous = tail;
            let release!: () => void;
            tail = new Promise<void>(done => { release = done; });
            await previous;
            return { query, release };
        } } as unknown as Database;
        await query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'reconcile-admin','Reconcile admin','super_admin',false)", [adminId]);
        await query("INSERT INTO providers(id,name,protocol,base_url) VALUES($1,'No-network reconcile fixture','apimart','https://never-called.invalid')", [providerId]);
        await query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities) VALUES($1,$2,'Reconcile fixture','fixture-model',ARRAY['generate','video','audio','chat'])", [modelId, providerId]);
        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            Object.assign(request, { auth: { id: adminId, role: request.header("x-fixture-role") ?? "super_admin", departmentId: null } });
            next();
        });
        app.use("/reconcile", createTaskReconciliationRouter(db, cache));
        app.use(((error, _request, response, _next) => response.status(500).json({ code: "FIXTURE_DATABASE_FAILURE" })) as ErrorRequestHandler);
        server = app.listen(0, "127.0.0.1");
        await new Promise<void>(done => server.once("listening", done));
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}/reconcile`;
    }, 30_000);
    afterAll(async () => {
        if (server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
        await database?.close();
    });
    const request = (path = "", body?: unknown, role = "super_admin") => fetch(base + path, {
        method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-fixture-role": role },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const taskResolve = (id: string, decision: string, extras = {}) => request(`/tasks/${id}/resolve`, { ...evidence, decision, ...extras });
    const chatResolve = (requestId: string, action: string, extras = {}) => request("/chat/resolve", { ...evidence, requestId, action, ...extras });
    const row = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows[0];
    const balance = async (userId: string) => (await row("SELECT credit_balance FROM users WHERE id=$1", [userId])).credit_balance;
    async function hold(operationType = "image_generation") {
        const userId = randomUUID();
        await db.query("INSERT INTO users(id,username,display_name,credit_balance,credit_limit,monthly_credit_limit) VALUES($1,$2,'Reconciliation employee',100,100,100)", [userId, `reconcile-${userId}`]);
        const requestId = operationType === "chat" ? `chat:${userId}:${randomUUID()}` : `reconcile:${randomUUID()}`;
        await reserveCredits(db, {
            requestId, userId, operationType, modelConfigId: modelId, quantity: 1,
            priceSnapshot: { operationType, operationCredits: 7, operationRmb: 0, modelId, modelCredits: 0, modelRmb: 0, quantity: 1, totalCredits: 7, totalRmb: 0, priceVersion: 1 },
        });
        return { userId, requestId };
    }
    async function task(operationType = "image_generation") {
        const held = await hold(operationType);
        const id = randomUUID(); const slot = randomUUID();
        await db.query(`INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,model_config_id,status,attempts,credits,model_slot_token,model_slot_expires_at,queued_at,upstream_submission_started_at)
            VALUES($1,$2,$3,'reconcile-fixture',$4,$5,'paused',1,7,$6,now()-interval '1 hour',now()-interval '2 hours',now()-interval '1 hour')`, [id, held.requestId, held.userId, operationType, modelId, slot]);
        return { id, slot, ...held };
    }
    async function asset(userId: string, kind = "image", status = "ready") {
        const id = randomUUID();
        await db.query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind,status) VALUES($1,$2,$3,'fixture.png',$4,123,$5,$6)", [id, userId, `fixture/${id}`, kind === "video" ? "video/mp4" : "image/png", kind, status]);
        return id;
    }

    test("role, ID and evidence validation blocks unauthorized or unsubstantiated mutations", async () => {
        const item = await task();
        for (const role of ["designer", "department_admin"]) {
            expect((await request("", undefined, role)).status).toBe(403);
            expect((await request(`/tasks/${item.id}/resolve`, { ...evidence, decision: "confirmed_failed" }, role)).status).toBe(403);
            expect((await request("/chat/resolve", { ...evidence, requestId: item.requestId, action: "release" }, role)).status).toBe(403);
        }
        expect((await request("/tasks/not-a-uuid/resolve", { ...evidence, decision: "confirmed_failed" })).status).toBe(400);
        expect((await request(`/tasks/${item.id}/resolve`, { decision: "confirmed_failed", reason: "等太久了" })).status).toBe(400);
        expect((await taskResolve(randomUUID(), "confirmed_failed")).status).toBe(404);
        expect((await row("SELECT status FROM tasks WHERE id=$1", [item.id])).status).toBe("paused");
        expect(await balance(item.userId)).toBe(93);
    });

    test("listing includes only safe paused work and old orphan chat holds", async () => {
        const paused = await task(); const active = await task();
        await db.query("UPDATE tasks SET lease_expires_at=now()+interval '10 minutes',execution_token=$2 WHERE id=$1", [active.id, randomUUID()]);
        const old = await hold("chat"); const fresh = await hold("chat");
        await db.query("UPDATE credit_reservations SET created_at=now()-interval '31 minutes' WHERE request_id=$1", [old.requestId]);
        const response = await request();
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const { data } = await response.json();
        expect(data.minimumChatAgeMinutes).toBe(30);
        expect(data.tasks.some((value: any) => value.id === paused.id && value.canAttachUpstream)).toBe(true);
        expect(data.tasks.some((value: any) => value.id === active.id)).toBe(false);
        expect(data.chats.some((value: any) => value.requestId === old.requestId)).toBe(true);
        expect(data.chats.some((value: any) => value.requestId === fresh.requestId)).toBe(false);
        expect((await taskResolve(active.id, "confirmed_failed")).status).toBe(409);
    });

    test.each(["confirmed_failed", "confirmed_not_submitted"])("%s settles atomically, removes capacity and cannot be reversed", async decision => {
        const item = await task();
        const response = await taskResolve(item.id, decision);
        expect(response.status).toBe(200);
        const status = decision === "confirmed_failed" ? "failed" : "cancelled";
        expect((await response.json()).data).toMatchObject({ id: item.id, status, decision, duplicate: false, resultUrls: [] });
        expect(await balance(item.userId)).toBe(100);
        expect(await row("SELECT status,execution_token,lease_expires_at,model_slot_token,model_slot_expires_at FROM tasks WHERE id=$1", [item.id])).toEqual({ status, execution_token: null, lease_expires_at: null, model_slot_token: null, model_slot_expires_at: null });
        expect((await row("SELECT status FROM credit_reservations WHERE request_id=$1", [item.requestId])).status).toBe("released");
        expect(removedSlots).toContainEqual([`model:${modelId}:leases`, `${item.id}:${item.slot}`]);
        expect((await row("SELECT detail,actor_user_id FROM audit_logs WHERE action='task.reconciled' AND target_id=$1", [item.id]))).toMatchObject({ actor_user_id: adminId, detail: { ...evidence, decision } });
        expect((await taskResolve(item.id, decision)).status).toBe(200);
        expect((await (await taskResolve(item.id, decision)).json()).data.duplicate).toBe(true);
        expect((await taskResolve(item.id, "confirmed_success")).status).toBe(409);
        expect((await row("SELECT count(*)::int AS count FROM credit_ledger WHERE reference_id=$1 AND entry_type='release'", [item.requestId])).count).toBe(1);
        expect((await row("SELECT count(*)::int AS count FROM audit_logs WHERE action='task.reconciled' AND target_id=$1", [item.id])).count).toBe(1);
    });

    test("an audit SQL failure rolls back task state, wallet, reservation and ledger together", async () => {
        const item = await task();
        await database.exec(`CREATE FUNCTION fail_reconcile_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='task.reconciled' THEN RAISE EXCEPTION 'Fixture audit unavailable'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER fail_reconcile_audit_fixture BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_reconcile_audit_fixture();`);
        try {
            expect((await taskResolve(item.id, "confirmed_failed")).status).toBe(500);
            expect(await balance(item.userId)).toBe(93);
            expect((await row("SELECT status FROM credit_reservations WHERE request_id=$1", [item.requestId])).status).toBe("held");
            expect(await row("SELECT status,model_slot_token FROM tasks WHERE id=$1", [item.id])).toEqual({ status: "paused", model_slot_token: item.slot });
            expect((await row("SELECT count(*)::int AS count FROM generation_history WHERE task_id=$1", [item.id])).count).toBe(0);
            expect((await row("SELECT count(*)::int AS count FROM credit_ledger WHERE reference_id=$1 AND entry_type<>'hold'", [item.requestId])).count).toBe(0);
        } finally { await database.exec("DROP TRIGGER fail_reconcile_audit_fixture ON audit_logs; DROP FUNCTION fail_reconcile_audit_fixture();"); }
    });

    test("success needs an owned ready matching result and records history exactly once", async () => {
        const item = await task(); const foreign = await hold();
        expect((await taskResolve(item.id, "confirmed_success")).status).toBe(409);
        for (const id of [await asset(foreign.userId), await asset(item.userId, "image", "pending"), await asset(item.userId, "video")]) {
            expect((await taskResolve(item.id, "confirmed_success", { resultAssetIds: [id] })).status).toBe(409);
        }
        await db.query("UPDATE tasks SET result_urls=$2 WHERE id=$1", [item.id, JSON.stringify(["http://127.0.0.1/private.png"])]);
        expect((await taskResolve(item.id, "confirmed_success")).status).toBe(409);
        const id = await asset(item.userId);
        const response = await taskResolve(item.id, "confirmed_success", { resultAssetIds: [id] });
        expect(response.status).toBe(200);
        expect((await response.json()).data.resultUrls).toEqual([`/api/assets/${id}/content`]);
        expect(await balance(item.userId)).toBe(93);
        expect((await row("SELECT status FROM credit_reservations WHERE request_id=$1", [item.requestId])).status).toBe("captured");
        expect(await row("SELECT status,result_urls,credits FROM generation_history WHERE task_id=$1", [item.id])).toEqual({ status: "success", result_urls: [`/api/assets/${id}/content`], credits: 7 });
        expect((await (await taskResolve(item.id, "confirmed_success", { resultAssetIds: [id] })).json()).data.duplicate).toBe(true);
        expect((await taskResolve(item.id, "confirmed_failed")).status).toBe(409);
        expect((await row("SELECT count(*)::int AS count FROM credit_ledger WHERE reference_id=$1 AND entry_type='capture'", [item.requestId])).count).toBe(1);
        const existing = await task("video_generation"); const video = await asset(existing.userId, "video");
        await db.query("UPDATE tasks SET result_urls=$2 WHERE id=$1", [existing.id, JSON.stringify([`/api/assets/${video}/content`])]);
        expect((await taskResolve(existing.id, "confirmed_success")).status).toBe(200);
    });

    test.each(["image_generation", "video_generation"])("attach_upstream %s preserves identity, original order and slot without submitting work", async operation => {
        const item = await task(operation);
        const original = await row("SELECT queued_at,parameters FROM tasks WHERE id=$1", [item.id]);
        const response = await taskResolve(item.id, "attach_upstream", { upstreamTaskId: "existing-provider-job" });
        expect(response.status).toBe(200);
        expect((await response.json()).data).toMatchObject({ status: "processing", upstreamTaskId: "existing-provider-job", queuePending: false });
        const current = await row("SELECT status,upstream_task_id,upstream_submission_started_at,execution_token,lease_expires_at,model_slot_token,queued_at,parameters,poll_deadline_at FROM tasks WHERE id=$1", [item.id]);
        expect(current).toMatchObject({ status: "processing", upstream_task_id: "existing-provider-job", execution_token: null, lease_expires_at: null, model_slot_token: item.slot, queued_at: original.queued_at, parameters: original.parameters });
        if (operation === "video_generation") expect(new Date(current.poll_deadline_at).getTime()).toBeGreaterThan(Date.now());
        expect(cacheCalls.at(-1)!.arguments[0]).toBe(item.id);
        expect(Number(cacheCalls.at(-1)!.arguments[3])).toBe(queueScore("normal", new Date(original.queued_at).getTime()));
        expect(await balance(item.userId)).toBe(93);
        expect((await row("SELECT status FROM credit_reservations WHERE request_id=$1", [item.requestId])).status).toBe("held");
        expect((await (await taskResolve(item.id, "attach_upstream", { upstreamTaskId: "existing-provider-job" })).json()).data.duplicate).toBe(true);
        expect((await taskResolve(item.id, "attach_upstream", { upstreamTaskId: "different-provider-job" })).status).toBe(409);
    });

    test("queue outage never erases an attached upstream ID and SQL recovery redelivers it", async () => {
        const item = await task();
        cacheFails = true;
        try {
            const response = await taskResolve(item.id, "attach_upstream", { upstreamTaskId: "recoverable-provider-job" });
            expect(response.status).toBe(200);
            expect((await response.json()).data.queuePending).toBe(true);
            expect(await row("SELECT status,upstream_task_id FROM tasks WHERE id=$1", [item.id])).toEqual({ status: "processing", upstream_task_id: "recoverable-provider-job" });
        } finally { cacheFails = false; }
        await restoreWaitingTasksToQueue(db, cache);
        expect(cacheCalls.some(call => call.arguments[0] === item.id)).toBe(true);
        expect(await balance(item.userId)).toBe(93);
    });

    test("unsupported providers, audio and workflow bindings cannot use upstream attachment", async () => {
        const audio = await task("audio_generation");
        expect((await taskResolve(audio.id, "attach_upstream", { upstreamTaskId: "untrusted-job" })).status).toBe(409);
        const item = await task();
        await db.query("UPDATE providers SET protocol='openai' WHERE id=$1", [providerId]);
        try { expect((await taskResolve(item.id, "attach_upstream", { upstreamTaskId: "untrusted-job" })).status).toBe(409); }
        finally { await db.query("UPDATE providers SET protocol='apimart' WHERE id=$1", [providerId]); }
        const workflow = await row("INSERT INTO workflow_configs(name,provider_id,protocol,capability,submit_path,output_path) VALUES('Reconcile workflow fixture',$1,'custom','generate','/fixture-submit','output') RETURNING id", [providerId]);
        await db.query("UPDATE model_configs SET workflow_config_id=$2 WHERE id=$1", [modelId, workflow.id]);
        try { expect((await taskResolve(item.id, "attach_upstream", { upstreamTaskId: "untrusted-job" })).status).toBe(409); }
        finally { await db.query("UPDATE model_configs SET workflow_config_id=NULL WHERE id=$1", [modelId]); }
    });

    test.each(["capture", "release"])("orphan chat %s requires age and evidence, is atomic and cannot reverse", async action => {
        const item = await hold("chat");
        expect((await chatResolve(item.requestId, action)).status).toBe(409);
        await db.query("UPDATE credit_reservations SET created_at=now()-interval '31 minutes' WHERE request_id=$1", [item.requestId]);
        expect((await request("/chat/resolve", { requestId: item.requestId, action, reason: "时间较久" })).status).toBe(400);
        const response = await chatResolve(item.requestId, action);
        expect(response.status).toBe(200);
        expect((await response.json()).data).toEqual({ requestId: item.requestId, status: action === "capture" ? "captured" : "released", duplicate: false });
        expect(await balance(item.userId)).toBe(action === "capture" ? 93 : 100);
        expect((await (await chatResolve(item.requestId, action)).json()).data.duplicate).toBe(true);
        expect((await chatResolve(item.requestId, action === "capture" ? "release" : "capture")).status).toBe(409);
        expect((await row("SELECT detail,actor_user_id FROM audit_logs WHERE action='chat.reservation_reconciled' AND detail->>'requestId'=$1", [item.requestId]))).toMatchObject({ actor_user_id: adminId, detail: { ...evidence, action, requestId: item.requestId } });
        expect((await row("SELECT count(*)::int AS count FROM credit_ledger WHERE reference_id=$1 AND entry_type=$2", [item.requestId, action])).count).toBe(1);
    });

    test("chat audit failure rolls back capture and task-linked reservations are excluded", async () => {
        const item = await hold("chat");
        await db.query("UPDATE credit_reservations SET created_at=now()-interval '31 minutes' WHERE request_id=$1", [item.requestId]);
        await database.exec(`CREATE FUNCTION fail_chat_reconcile_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='chat.reservation_reconciled' THEN RAISE EXCEPTION 'Fixture audit unavailable'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER fail_chat_reconcile_fixture BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_chat_reconcile_fixture();`);
        try {
            expect((await chatResolve(item.requestId, "capture")).status).toBe(500);
            expect((await row("SELECT status FROM credit_reservations WHERE request_id=$1", [item.requestId])).status).toBe("held");
            expect((await row("SELECT count(*)::int AS count FROM credit_ledger WHERE reference_id=$1 AND entry_type='capture'", [item.requestId])).count).toBe(0);
        } finally { await database.exec("DROP TRIGGER fail_chat_reconcile_fixture ON audit_logs; DROP FUNCTION fail_chat_reconcile_fixture();"); }
        const linked = await task("chat");
        await db.query("UPDATE credit_reservations SET created_at=now()-interval '31 minutes' WHERE request_id=$1", [linked.requestId]);
        expect((await chatResolve(linked.requestId, "release")).status).toBe(409);
        const data = (await (await request()).json()).data;
        expect(data.chats.some((value: any) => value.requestId === linked.requestId)).toBe(false);
    });

    test("concurrent opposite decisions cannot double-settle or reverse the winner", async () => {
        const item = await task(); const id = await asset(item.userId);
        const responses = await Promise.all([taskResolve(item.id, "confirmed_failed"), taskResolve(item.id, "confirmed_success", { resultAssetIds: [id] })]);
        expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
        expect((await row("SELECT count(*)::int AS count FROM credit_ledger WHERE reference_id=$1 AND entry_type<>'hold'", [item.requestId])).count).toBe(1);
        expect((await row("SELECT count(*)::int AS count FROM audit_logs WHERE action='task.reconciled' AND target_id=$1", [item.id])).count).toBe(1);
    });
});
