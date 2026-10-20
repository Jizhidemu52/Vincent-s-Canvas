import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler } from "express";
import type { Database } from "../../src/db";
import { beginChatBilling, finishChatBilling } from "../../src/chat-billing";
import { createChatRouter } from "../../src/routes/chat";
import { encryptSecret } from "../../src/security";
import type { ToolConfiguration } from "../../src/tool-configuration";

const runtime = process.env.PGLITE_RUNTIME_PATH;
const integration = runtime ? describe : describe.skip;
const migrations = fileURLToPath(new URL("../../src/migrations/", import.meta.url));

integration("isolated PostgreSQL chat billing", () => {
    let database: any;
    let db: Database;
    let execution: ToolConfiguration & { modelConfigId: string };
    beforeAll(async () => {
        const requireRuntime = createRequire(resolve(runtime!, "package.json"));
        const { PGlite } = requireRuntime("@electric-sql/pglite");
        const { pgcrypto } = requireRuntime("@electric-sql/pglite/contrib/pgcrypto");
        const { citext } = requireRuntime("@electric-sql/pglite/contrib/citext");
        database = new PGlite({ extensions: { pgcrypto, citext } });
        await database.waitReady;
        for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) await database.exec(await readFile(`${migrations}/${name}`, "utf8"));
        const query = async (sql: string, values: unknown[] = []) => {
            const result = await database.query(sql, values);
            return { ...result, rowCount: result.affectedRows ?? result.rows.length };
        };
        // PGlite has one SQL connection. Serialize checked-out transaction clients;
        // no production data or credentials are accessed by this isolated fixture.
        let tail = Promise.resolve();
        db = { query, connect: async () => {
            const previous = tail;
            let release!: () => void;
            tail = new Promise<void>(done => { release = done; });
            await previous;
            return { query, release };
        } } as unknown as Database;
        const provider = await db.query("INSERT INTO providers(name,protocol,base_url) VALUES('chat-test','openai','https://never-called.invalid') RETURNING id");
        const model = await db.query("INSERT INTO model_configs(provider_id,name,model_id,capabilities,credit_cost) VALUES($1,'chat-test','chat-test',ARRAY['chat'],2) RETURNING id", [provider.rows[0].id]);
        execution = { toolKey: "gpt-chat", modelConfigId: model.rows[0].id, enabled: true, creditCostOverride: 7, rmbCostOverride: 0, configurationVersion: 1 };
    }, 30000);
    afterAll(async () => {
        await database?.close();
    });
    async function actor(balance = 20) {
        const result = await db.query("INSERT INTO users(username,display_name,credit_balance,credit_limit,monthly_credit_limit) VALUES($1,'Chat test',$2,$2,$2) RETURNING id", [`chat-${randomUUID()}`, balance]);
        return result.rows[0].id as string;
    }
    async function balance(userId: string) { return (await db.query("SELECT credit_balance FROM users WHERE id=$1", [userId])).rows[0].credit_balance; }
    const begin = (userId: string, requestId = randomUUID(), override = execution) => beginChatBilling(db, { userId, requestId, execution: override, enabled: true });

    test("successful request captures once; same ID cannot cause a second upstream admission", async () => {
        const userId = await actor();
        const requestId = randomUUID();
        const held = await begin(userId, requestId);
        expect(await balance(userId)).toBe(13);
        await finishChatBilling(db, held, true);
        await finishChatBilling(db, held, true);
        await expect(begin(userId, requestId)).rejects.toMatchObject({ code: "CHAT_REQUEST_ALREADY_SUBMITTED" });
        expect(await balance(userId)).toBe(13);
        const ledger = await db.query("SELECT entry_type FROM credit_ledger WHERE user_id=$1 ORDER BY created_at", [userId]);
        expect(ledger.rows.map(row => row.entry_type)).toEqual(["hold", "capture"]);
    });
    test("failure restores once and a released ID cannot be replayed for free", async () => {
        const userId = await actor();
        const requestId = randomUUID();
        const held = await begin(userId, requestId);
        await finishChatBilling(db, held, false);
        await finishChatBilling(db, held, false);
        expect(await balance(userId)).toBe(20);
        await expect(begin(userId, requestId)).rejects.toMatchObject({ code: "CHAT_REQUEST_ALREADY_SUBMITTED" });
        expect((await db.query("SELECT count(*)::int AS count FROM credit_ledger WHERE user_id=$1 AND entry_type='release'", [userId])).rows[0].count).toBe(1);
    });
    test("concurrent duplicate requests admit exactly one provider call", async () => {
        const userId = await actor();
        const requestId = randomUUID();
        const results = await Promise.allSettled([begin(userId, requestId), begin(userId, requestId)]);
        expect(results.filter(result => result.status === "fulfilled").length).toBe(1);
        expect(results.filter(result => result.status === "rejected").length).toBe(1);
        expect(await balance(userId)).toBe(13);
        const held = results.find(result => result.status === "fulfilled") as PromiseFulfilledResult<string | null>;
        await finishChatBilling(db, held.value, false);
    });
    test("same request ID in another account owns its own reservation and balance", async () => {
        const first = await actor(); const second = await actor(); const requestId = randomUUID();
        const reservations = await Promise.all([begin(first, requestId), begin(second, requestId)]);
        expect(reservations[0]).not.toBe(reservations[1]);
        expect(await balance(first)).toBe(13); expect(await balance(second)).toBe(13);
        await Promise.all(reservations.map(id => finishChatBilling(db, id, true)));
    });
    test("zero/off are free and insufficient balance rejects without a reservation", async () => {
        const userId = await actor(3);
        expect(await begin(userId, randomUUID(), { ...execution, creditCostOverride: 0 })).toBeNull();
        expect(await beginChatBilling(db, { userId, enabled: false, execution })).toBeNull();
        await expect(begin(userId)).rejects.toMatchObject({ code: "INSUFFICIENT_CREDIT" });
        expect(await balance(userId)).toBe(3);
        expect((await db.query("SELECT count(*)::int AS count FROM credit_reservations WHERE user_id=$1", [userId])).rows[0].count).toBe(0);
    });

    test("real HTTP chat route uses persisted switch, captures success, returns failures and never resubmits an ID", async () => {
        let calls = 0;
        let mode: "success" | "fail" | "empty" | "stream" | "incomplete" | "json-failed" | "json-incomplete" | "item-incomplete" | "tool" | "stream-tool" | "stream-error" | "stream-hold" = "success";
        let onProviderCall: (() => Promise<void>) | null = null;
        const heldStream: { finish?: () => void } = {};
        let lastProviderInput: unknown;
        const providerApp = express();
        providerApp.use(express.json());
        providerApp.post(["/responses", "/v1/messages"], async (request, response) => {
            calls++;
            lastProviderInput = request.body.input;
            if (onProviderCall) { const action = onProviderCall; onProviderCall = null; await action(); }
            if (mode === "fail") { response.status(503).json({ error: "fixture failure" }); return; }
            if (mode === "json-failed" || mode === "json-incomplete") {
                response.json({ status: mode === "json-failed" ? "failed" : "incomplete", output_text: "partial fixture answer" }); return;
            }
            if (mode === "item-incomplete") {
                response.json({ status: "completed", output: [{ type: "message", status: "incomplete", content: [{ type: "output_text", text: "partial fixture answer" }] }] }); return;
            }
            if (mode === "tool") {
                response.json({ status: "completed", output: [{ type: "function_call", status: "completed", call_id: "fixture-call", name: "canvas_get_state", arguments: "{}" }] }); return;
            }
            if (["stream", "incomplete", "stream-tool", "stream-error", "stream-hold"].includes(mode)) {
                response.setHeader("content-type", "text/event-stream");
                response.write(mode === "stream-tool"
                    ? 'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"fixture-tool","name":"canvas_get_state","input":{}}}\n\n'
                    : 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"fixture answer"}}\n\n');
                if (mode === "stream-hold") {
                    heldStream.finish = () => { response.end('data: {"type":"message_stop"}\n\n'); }; return;
                }
                if (mode === "stream-error") response.write('data: {"type":"error","error":{"type":"overloaded_error","message":"fixture error"}}\n\n');
                if (mode !== "incomplete") response.write('data: {"type":"message_stop"}\n\n');
                response.end(); return;
            }
            response.json({ output_text: mode === "empty" ? "" : "fixture answer" });
        });
        const providerServer = providerApp.listen(0, "127.0.0.1");
        await new Promise<void>(done => providerServer.once("listening", done));
        const encryptionKey = Buffer.alloc(32, 9).toString("base64");
        const userId = await actor(100);
        let disconnectRequestId: string | null = null;
        let disconnectedSocket: Socket | null = null;
        const app = express();
        app.use(express.json());
        app.use((request, response, next) => {
            Object.assign(request, { auth: { id: userId, role: "designer", departmentId: null } });
            if (request.body.requestId === disconnectRequestId) disconnectedSocket = request.socket;
            next();
        });
        app.use("/chat", createChatRouter(db, { AUTH_ENABLED: "true", PROVIDER_ENCRYPTION_KEY: encryptionKey } as never));
        app.use(((error, _request, response, _next) => response.status(error.code === "CHAT_REQUEST_ALREADY_SUBMITTED" ? 409 : error.code === "P0001" ? 500 : 400).json({ code: error.code })) as ErrorRequestHandler);
        const server = app.listen(0, "127.0.0.1");
        await new Promise<void>(done => server.once("listening", done));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const post = (requestId = randomUUID(), stream = false, input: unknown[] = [{ role: "user", content: "test only" }], signal?: AbortSignal) => fetch(`${base}/chat/responses`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId, modelId: execution.modelConfigId, toolKey: "gpt-chat", input, ...(stream ? { claude: { stream: true } } : {}) }) });
        try {
            await db.query("UPDATE providers SET base_url=$1,encrypted_credentials=$2 WHERE id=(SELECT provider_id FROM model_configs WHERE id=$3)", [`http://127.0.0.1:${(providerServer.address() as { port: number }).port}`, encryptSecret(JSON.stringify({ apiKey: "fixture-only" }), encryptionKey), execution.modelConfigId]);
            await db.query("INSERT INTO tool_api_configurations(tool_key,model_config_id,credit_cost_override,rmb_cost_override) VALUES('gpt-chat',$1,7,0) ON CONFLICT(tool_key) DO UPDATE SET model_config_id=$1,credit_cost_override=7,rmb_cost_override=0", [execution.modelConfigId]);
            await db.query("INSERT INTO credit_policy(singleton,credits_enabled) VALUES(true,true) ON CONFLICT(singleton) DO UPDATE SET credits_enabled=true");
            const requestId = randomUUID();
            const successful = await post(requestId);
            expect(successful.status).toBe(200); expect((await successful.json()).content).toBe("fixture answer");
            expect(await balance(userId)).toBe(93);
            expect((await post(requestId)).status).toBe(409); expect(calls).toBe(1);
            mode = "fail"; expect((await post()).status).toBe(400); expect(await balance(userId)).toBe(93);
            mode = "empty"; expect((await post()).status).toBe(400); expect(await balance(userId)).toBe(93);
            mode = "success";
            await db.query("UPDATE credit_policy SET credits_enabled=false");
            expect((await post()).status).toBe(200); expect(await balance(userId)).toBe(93);
            await db.query("UPDATE credit_policy SET credits_enabled=true");
            await db.query("UPDATE tool_api_configurations SET credit_cost_override=0 WHERE tool_key='gpt-chat'");
            expect((await post()).status).toBe(200); expect(await balance(userId)).toBe(93);
            await db.query("UPDATE tool_api_configurations SET credit_cost_override=7 WHERE tool_key='gpt-chat'");
            await db.query("UPDATE providers SET protocol='anthropic'");
            mode = "stream"; expect(await (await post(randomUUID(), true)).text()).toContain('"message_stop"'); expect(await balance(userId)).toBe(86);
            mode = "incomplete"; expect(await (await post(randomUUID(), true)).text()).toContain("event: error"); expect(await balance(userId)).toBe(86);
            const statuses = await db.query("SELECT status,count(*)::int AS count FROM credit_reservations WHERE user_id=$1 GROUP BY status", [userId]);
            expect(Object.fromEntries(statuses.rows.map(row => [row.status, row.count]))).toEqual({ captured: 2, released: 3 });
            // Authenticated non-OA chat is tracked even when credits are off or
            // free; the rejected duplicate must not create another usage record.
            const usageStatuses = await db.query("SELECT status,count(*)::int AS count FROM usage_chat_requests WHERE user_id=$1 GROUP BY status", [userId]);
            expect(Object.fromEntries(usageStatuses.rows.map(row => [row.status, row.count]))).toEqual({ success: 4, failed: 3 });

            // Inject a real database failure, not a mocked response, after the
            // provider succeeds. Both transports must refund before reporting it.
            await database.exec(`CREATE FUNCTION fail_chat_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN IF NEW.action='chat.completed' THEN RAISE EXCEPTION 'Fixture audit failure'; END IF; RETURN NEW; END $$;
                CREATE TRIGGER fail_chat_audit_fixture BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_chat_audit_fixture();`);
            for (const streaming of [false, true]) {
                await db.query("UPDATE providers SET protocol=$1", [streaming ? "anthropic" : "openai"]);
                mode = streaming ? "stream" : "success";
                const failedId = randomUUID();
                const failedResponse = await post(failedId, streaming);
                if (streaming) expect(await failedResponse.text()).toContain("event: error");
                else expect(failedResponse.status).toBe(500);
                expect(await balance(userId)).toBe(86);
                const callsAfterFailure = calls;
                expect((await post(failedId, streaming)).status).toBe(409);
                expect(calls).toBe(callsAfterFailure);
                const reservationId = `chat:${userId}:${failedId}`;
                expect((await db.query("SELECT status FROM credit_reservations WHERE request_id=$1", [reservationId])).rows[0].status).toBe("released");
                const entries = await db.query("SELECT entry_type FROM credit_ledger WHERE reference_id=$1 ORDER BY created_at", [reservationId]);
                expect(entries.rows.map(row => row.entry_type)).toEqual(["hold", "release"]);
            }
            await database.exec("DROP TRIGGER fail_chat_audit_fixture ON audit_logs; DROP FUNCTION fail_chat_audit_fixture();");

            await db.query("UPDATE providers SET protocol='openai'");
            for (const failedMode of ["json-failed", "json-incomplete", "item-incomplete"] as const) {
                mode = failedMode;
                const failedId = randomUUID();
                expect((await post(failedId)).status).toBe(400);
                expect(await balance(userId)).toBe(86);
                expect((await db.query("SELECT status FROM credit_reservations WHERE request_id=$1", [`chat:${userId}:${failedId}`])).rows[0].status).toBe("released");
            }
            // A tool plan and the following model answer are distinct billable calls.
            mode = "tool";
            expect((await (await post()).json()).toolCalls).toHaveLength(1);
            expect(await balance(userId)).toBe(79);
            mode = "success";
            const continuation = [{ type: "function_call", call_id: "fixture-call", name: "canvas_get_state", arguments: "{}" }, { type: "function_call_output", call_id: "fixture-call", output: "fixture state" }];
            expect((await post(randomUUID(), false, continuation)).status).toBe(200);
            expect(lastProviderInput).toEqual(continuation);
            expect(await balance(userId)).toBe(72);

            // Configuration changes during an admitted call affect only the next
            // request: the in-flight hold still captures its original seven credits.
            const snapshotId = randomUUID();
            onProviderCall = async () => {
                await db.query("UPDATE credit_policy SET credits_enabled=false");
                await db.query("UPDATE tool_api_configurations SET credit_cost_override=19 WHERE tool_key='gpt-chat'");
            };
            expect((await post(snapshotId)).status).toBe(200);
            expect(await balance(userId)).toBe(65);
            expect((await db.query("SELECT status,credits FROM credit_reservations WHERE request_id=$1", [`chat:${userId}:${snapshotId}`])).rows).toEqual([{ status: "captured", credits: 7 }]);
            expect((await post()).status).toBe(200); expect(await balance(userId)).toBe(65);
            await db.query("UPDATE credit_policy SET credits_enabled=true");
            await db.query("UPDATE tool_api_configurations SET credit_cost_override=7 WHERE tool_key='gpt-chat'");

            await db.query("UPDATE providers SET protocol='anthropic'");
            mode = "stream-tool";
            expect(await (await post(randomUUID(), true)).text()).toContain('"tool_use"');
            expect(await balance(userId)).toBe(58);
            mode = "stream-error";
            expect(await (await post(randomUUID(), true)).text()).toContain("event: error");
            expect(await balance(userId)).toBe(58);

            mode = "stream-hold";
            const cancelledId = randomUUID();
            disconnectRequestId = cancelledId;
            await new Promise<void>((done, reject) => {
                const socket = createConnection({ host: "127.0.0.1", port: (server.address() as { port: number }).port });
                const body = JSON.stringify({ requestId: cancelledId, modelId: execution.modelConfigId, toolKey: "gpt-chat", input: [{ role: "user", content: "disconnect fixture" }], claude: { stream: true } });
                socket.on("connect", () => socket.write(`POST /chat/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`));
                socket.on("data", chunk => {
                    if (chunk.toString().includes("fixture answer")) { socket.destroy(); done(); }
                });
                socket.on("error", reject);
            });
            expect(await balance(userId)).toBe(51);
            for (let attempt = 0; attempt < 100 && disconnectedSocket!.remoteAddress && !disconnectedSocket!.destroyed; attempt++) await new Promise(done => setTimeout(done, 10));
            expect(!disconnectedSocket!.remoteAddress || disconnectedSocket!.destroyed).toBe(true);
            heldStream.finish!();
            for (let attempt = 0; attempt < 100 && await balance(userId) !== 58; attempt++) await new Promise(done => setTimeout(done, 10));
            expect(await balance(userId)).toBe(58);
            expect((await db.query("SELECT status FROM credit_reservations WHERE request_id=$1", [`chat:${userId}:${cancelledId}`])).rows[0].status).toBe("released");
        } finally {
            heldStream.finish?.();
            await Promise.all([server, providerServer].map(item => new Promise<void>(done => { item.close(() => done()); item.closeAllConnections(); })));
        }
    });
});
