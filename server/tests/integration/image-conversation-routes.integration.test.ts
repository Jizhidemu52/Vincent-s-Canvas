import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import cookieParser from "cookie-parser";
import express from "express";
import type { Server } from "node:http";
import * as Public from "../../../shared/image-conversation-public-schemas";
import { loadConfig } from "../../src/config";
import type { Cache } from "../../src/db";
import { withTransaction } from "../../src/db-transaction";
import { ImageConversationEvents } from "../../src/image-conversation-events";
import { appendConversationEvent, readConversation, turnSnapshot, type TurnRow } from "../../src/image-conversation-store";
import { resolveEffectiveImageParameters } from "../../src/image-output-policy";
import { createImageConversationsRouter, imageConversationBoundary, imageConversationErrors } from "../../src/routes/image-conversations";
import { requireAccountReady, sessionMiddleware } from "../../src/session";
import { createSessionToken, hashToken } from "../../src/security";
import { createConversationPostgres as createIsolatedPostgres, conversationDatabaseMode } from "../helpers/conversation-postgres";

const integration = conversationDatabaseMode() ? describe : describe.skip;
integration("image conversation HTTP contract with existing real sessions", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>, server: Server, url: string;
  let accepting = true, wakes = 0;
  const events = new ImageConversationEvents();
  const cacheEntries = new Map<string, string>();
  const cache = { get: async (key: string) => cacheEntries.get(key) ?? null,
    set: async (key: string, value: string) => { cacheEntries.set(key, value); },
    del: async (key: string) => { cacheEntries.delete(key); } } as unknown as Cache;
  const secret = Buffer.alloc(32, 13).toString("base64");
  const config = loadConfig({ DATABASE_URL: "postgres://unused", REDIS_URL: "redis://unused", AUTH_ENABLED: "true", PROVIDER_ENCRYPTION_KEY: secret });
  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    const app = express();
    app.use(imageConversationBoundary, express.json({ limit: "64kb" }), imageConversationErrors, cookieParser());
    app.use(sessionMiddleware(fixture.db, cache, config, { allowGuest: false }), requireAccountReady);
    app.use("/api/image-conversations", createImageConversationsRouter(fixture.db, {
      events, cursorSecret: secret, acceptingNewTurns: () => accepting, wakeWorker: () => { wakes++; }, streamLifetimeMs: 40,
    }));
    app.use(imageConversationErrors);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No isolated HTTP port");
    url = `http://127.0.0.1:${address.port}/api/image-conversations`;
  }, 30_000);
  afterAll(async () => {
    events.close(); server?.closeAllConnections();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await fixture?.close();
  });
  async function account(mustChangePassword = false) {
    const id = randomUUID(), session = createSessionToken();
    await fixture.db.query("INSERT INTO users(id,username,display_name,must_change_password) VALUES($1,$2,'Conversation HTTP',$3)", [id, `http-${id}`, mustChangePassword]);
    await fixture.db.query("INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')", [session.id, id, hashToken(session.token)]);
    return { id, cookie: `${config.SESSION_COOKIE_NAME}=${session.token}` };
  }
  const request = (cookie: string, path = "", body?: unknown, headers: Record<string, string> = {}) => fetch(url + path, {
    method: body === undefined ? "GET" : "POST", headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  test("authentication and onboarding preserve status in the new error envelope without provisioning guests", async () => {
    const before = (await fixture.db.query("SELECT count(*)::int n FROM users")).rows[0].n;
    const anonymous = await request("");
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ code: "UNAUTHENTICATED", data: null, msg: "请先登录" });
    expect((await fixture.db.query("SELECT count(*)::int n FROM users")).rows[0].n).toBe(before);
    const incomplete = await account(true), forbidden = await request(incomplete.cookie);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ code: "ACCOUNT_NOT_READY", data: null });
  });

  test("201/200 creation and 202/200 turn receipts are durable and recovery GET never wakes model work", async () => {
    const user = await account(), createBody = { clientRequestId: randomUUID(), entrypoint: "standalone" };
    const first = await request(user.cookie, "", createBody);
    expect(first.status).toBe(201);
    const created = await first.json() as any, id = created.data.id;
    expect(created).toMatchObject({ code: "OK", data: { stateRevision: 0, latestEventSeq: 1 }, msg: "" });
    expect((await request(user.cookie, "", createBody)).status).toBe(200);
    const body = { clientRequestId: "http:request_1", expectedStateRevision: 0, text: "改为蓝色" };
    const response = await request(user.cookie, `/${id}/turns`, body);
    expect(response.status).toBe(202);
    const result = await response.json() as any;
    expect(result).toMatchObject({ code: "OK", data: { state: "accepted", stateRevision: 1 } });
    expect((await fixture.db.query("SELECT input_payload FROM image_conversation_turns WHERE id=$1", [result.data.turnId])).rows[0].input_payload.text).toBe(body.text);
    const replay = await request(user.cookie, `/${id}/turns`, body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(result);
    const wakeCount = wakes;
    const byKey = await request(user.cookie, `/${id}/turns/by-request/${encodeURIComponent(body.clientRequestId)}`);
    expect(byKey.status).toBe(200);
    expect(await byKey.json()).toMatchObject({ code: "OK", data: { turn: { id: result.data.turnId, state: "accepted" } } });
    expect((await request(user.cookie, `/${id}/turns/${result.data.turnId}`)).status).toBe(200);
    expect(wakes).toBe(wakeCount);
    const stranger = await account(), foreign = await request(stranger.cookie, `/${id}`);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  test("unknown fields, malformed identifiers and query parameters fail before state or work changes", async () => {
    const user = await account(), before = wakes;
    for (const extra of [{ userId: user.id }, { model: "gpt-anything" }, { ownerId: user.id }]) {
      const response = await request(user.cookie, "", { clientRequestId: randomUUID(), entrypoint: "standalone", ...extra });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    for (const path of ["/not-a-uuid", "?limit=0", "?limit=101", "?limit=", "?limit=1.5", "?limit=1&limit=2", "?unknown=value"]) {
      expect((await request(user.cookie, path)).status).toBe(400);
    }
    const invalidJson = await fetch(url, { method: "POST", headers: { cookie: user.cookie, "content-type": "application/json" }, body: "{" });
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(wakes).toBe(before);
    expect((await fixture.db.query("SELECT count(*)::int n FROM image_conversations WHERE owner_user_id=$1", [user.id])).rows[0].n).toBe(0);
  });

  test("creation recovery GET is owner-scoped, validates request keys and never creates work or wakes subscribers", async () => {
    const user = await account(), stranger = await account(), clientRequestId = "create:中文/request?value#%";
    const created = await (await request(user.cookie, "", { clientRequestId, entrypoint: "standalone" })).json() as { data: unknown };
    const snapshot = Public.conversationSnapshotSchema.parse(created.data), path = `/by-request/${encodeURIComponent(clientRequestId)}`;
    const state = async () => ({
      conversations: (await fixture.db.query("SELECT * FROM image_conversations WHERE owner_user_id=ANY($1::uuid[]) ORDER BY id", [[user.id, stranger.id]])).rows,
      counts: (await fixture.db.query(`SELECT
        (SELECT count(*)::int FROM image_conversation_turns WHERE owner_user_id=ANY($1::uuid[])) turns,
        (SELECT count(*)::int FROM tasks WHERE user_id=ANY($1::uuid[])) tasks,
        (SELECT count(*)::int FROM credit_reservations WHERE user_id=ANY($1::uuid[])) reservations,
        (SELECT count(*)::int FROM image_conversation_messages WHERE conversation_id=$2) messages,
        (SELECT count(*)::int FROM image_conversation_events WHERE conversation_id=$2) events`, [[user.id, stranger.id], snapshot.id])).rows[0],
    });
    const before = await state(), wakeCount = wakes;
    let subscriberWakes = 0;
    const unsubscribe = events.subscribe(snapshot.id, () => { subscriberWakes++; }, () => {});
    accepting = false;
    try {
      const recovered = await request(user.cookie, path);
      expect(recovered.status).toBe(200);
      expect(recovered.headers.get("cache-control")).toBe("private, no-store");
      const payload = await recovered.json() as { data: unknown };
      expect(Public.conversationSnapshotSchema.parse(payload.data)).toEqual(snapshot);
      const missing = await request(user.cookie, `/by-request/${randomUUID()}`), foreign = await request(stranger.cookie, path);
      expect(missing.status).toBe(404); expect(foreign.status).toBe(404);
      expect(await missing.json()).toEqual(await foreign.json());
      expect((await request(user.cookie, `/by-request/${"x".repeat(160)}`)).status).toBe(404);
      const invalid = await request(user.cookie, `/by-request/${"x".repeat(161)}`);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ code: "VALIDATION_ERROR" });
      expect(await state()).toEqual(before);
      expect(before.counts).toEqual({ turns: 0, tasks: 0, reservations: 0, messages: 0, events: 1 });
      expect(wakes).toBe(wakeCount); expect(subscriberWakes).toBe(0);
    } finally { accepting = true; unsubscribe(); }
  });

  test("JSON and persisted SSE expose public settings and safe status text without rewriting user input or stored audit data", async () => {
    const user = await account(), clientRequestId = randomUUID();
    const originalText = "请保留原文 APIMart、gpt-image-2.6-flare 和 flare-auto-v1，不要替换这些字样。";
    const created = await (await request(user.cookie, "", { clientRequestId, entrypoint: "standalone", title: originalText })).json() as { data: unknown };
    const conversation = Public.conversationSnapshotSchema.parse(created.data), turnRequestId = randomUUID();
    const accepted = await (await request(user.cookie, `/${conversation.id}/turns`, { clientRequestId: turnRequestId, expectedStateRevision: 0, text: originalText })).json() as { data: unknown };
    const receipt = Public.turnSubmissionResultSchema.parse(accepted.data);
    const modelId = randomUUID(), providerId = randomUUID(), taskId = randomUUID(), taskRequestId = `ic:${receipt.turnId}:image:1`;
    const settings = resolveEffectiveImageParameters({ action: "generate_new", intent: { purpose: "standard", complexity: "medium" },
      binding: { modelConfigId: modelId, provider: "HTTP fixture", providerProtocol: "apimart", apiModelId: "gpt-image-2.6-flare", enabled: true },
      priceSnapshot: { modelId, quantity: 1, totalCredits: 7, totalRmb: 0.7, priceVersion: 1 } });
    const lastError = { code: "UPSTREAM_OUTCOME_UNKNOWN", message: "APIMart gpt-image-2.6-flare 结果尚未确认", retryable: false };
    await withTransaction(fixture.db, async client => {
      await client.query("INSERT INTO providers(id,name,protocol,base_url) VALUES($1,'HTTP privacy fixture','apimart','https://no-network.invalid')", [providerId]);
      await client.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities) VALUES($1,$2,'HTTP privacy fixture','gpt-image-2.6-flare',ARRAY['generate','edit'])", [modelId, providerId]);
      await client.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,model_config_id,status) VALUES($1,$2,$3,'','image_generation',$4,'processing')", [taskId, taskRequestId, user.id, modelId]);
      const turn = (await client.query<TurnRow>(`UPDATE image_conversation_turns SET intent='generate_new',state='uncertain',planner_status='succeeded',
        task_id=$2,task_request_id=$3,settings_snapshot=$4,last_error=$5 WHERE id=$1 RETURNING *`,
      [receipt.turnId, taskId, taskRequestId, JSON.stringify(settings), JSON.stringify(lastError)])).rows[0];
      const current = await readConversation(client, user.id, conversation.id, true);
      await appendConversationEvent(client, current, receipt.turnId, "settings.resolved", { stateRevision: 1, turnId: receipt.turnId, settingsSnapshot: settings });
      await appendConversationEvent(client, current, receipt.turnId, "turn.uncertain", { stateRevision: 1, turn: turnSnapshot(turn) });
    });
    const before = (await fixture.db.query("SELECT settings_snapshot,last_error,input_payload FROM image_conversation_turns WHERE id=$1", [receipt.turnId])).rows[0];
    const wakeCount = wakes, expectedSettings = { ...settings, policyVersion: "image-auto-v1" as const, effective: { ...settings.effective, model: modelId } };
    for (const path of [`/${conversation.id}`, `/by-request/${clientRequestId}`]) {
      const response = await request(user.cookie, path);
      expect(response.status).toBe(200);
      const payload = await response.json() as { data: unknown }, snapshot = Public.conversationSnapshotSchema.parse(payload.data);
      expect(snapshot.title).toBe(originalText);
      expect(snapshot.pendingTurn?.settingsSnapshot).toEqual(expectedSettings);
      expect(snapshot.pendingTurn?.lastError?.message).toBe("图像服务 结果尚未确认");
      expect(snapshot.pendingTurn?.assistant.text).toBe("图像服务 结果尚未确认");
    }
    for (const path of [`/${conversation.id}/turns/${receipt.turnId}`, `/${conversation.id}/turns/by-request/${turnRequestId}`]) {
      const response = await request(user.cookie, path);
      expect(response.status).toBe(200);
      const payload = await response.json() as { data: unknown }, details = Public.turnDetailsSchema.parse(payload.data);
      expect(details.turn.settingsSnapshot).toEqual(expectedSettings);
      expect(JSON.stringify(details)).not.toMatch(/APIMart|gpt-image-2\.6-flare|flare-auto-v1/i);
    }
    const messageResponse = await request(user.cookie, `/${conversation.id}/messages`);
    const messagePayload = await messageResponse.json() as { data: unknown }, messages = Public.messagePageSchema.parse(messagePayload.data);
    expect(messages.items).toHaveLength(1); expect(messages.items[0]?.text).toBe(originalText);
    const streamResponse = await request(user.cookie, `/${conversation.id}/events`);
    expect(streamResponse.status).toBe(200);
    const stream = await streamResponse.text(), received = stream.split("\n\n").filter(frame => frame.startsWith("id: ")).map(frame => {
      const lines = frame.split("\n"), event = Public.conversationEventSchema.parse(JSON.parse(lines.find(line => line.startsWith("data: "))!.slice(6)));
      expect(lines[0]).toBe(`id: ${event.seq}`); expect(lines[1]).toBe(`event: ${event.type}`);
      return event;
    });
    expect(received.map(event => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(received.find(event => event.type === "settings.resolved")?.payload.settingsSnapshot).toEqual(expectedSettings);
    const status = received.find(event => event.type === "turn.uncertain");
    const statusPayload = Public.turnEventPayloadSchema.parse(status?.payload);
    expect(statusPayload.turn.settingsSnapshot).toEqual(expectedSettings);
    expect(statusPayload.turn.lastError?.message).toBe("图像服务 结果尚未确认");
    expect(JSON.stringify(status)).not.toMatch(/APIMart|gpt-image-2\.6-flare|flare-auto-v1/i);
    expect(received.find(event => event.type === "message.created")?.payload.message.text).toBe(originalText);
    expect(received.find(event => event.type === "conversation.created")?.payload.conversation.title).toBe(originalText);
    expect((await fixture.db.query("SELECT settings_snapshot,last_error,input_payload FROM image_conversation_turns WHERE id=$1", [receipt.turnId])).rows[0]).toEqual(before);
    expect(before.settings_snapshot).toEqual(settings); expect(before.last_error).toEqual(lastError); expect(before.input_payload.text).toBe(originalText);
    expect(wakes).toBe(wakeCount);
  });

  test("SSE replays persisted event identities, uses Last-Event-ID and reports expiry before streaming", async () => {
    const user = await account();
    const created = await (await request(user.cookie, "", { clientRequestId: randomUUID(), entrypoint: "standalone" })).json() as any;
    const id = created.data.id;
    const response = await request(user.cookie, `/${id}/events`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const stream = await response.text();
    expect(stream).toContain("id: 1\nevent: conversation.created\ndata:");
    const resumed = await request(user.cookie, `/${id}/events?afterSeq=0`, undefined, { "Last-Event-ID": "1" });
    expect(await resumed.text()).toBe(": connected\n\n");
    const future = await request(user.cookie, `/${id}/events?afterSeq=2`);
    expect(future.status).toBe(400);
    expect(await future.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    await fixture.db.query("DELETE FROM image_conversation_events WHERE conversation_id=$1", [id]);
    const expired = await request(user.cookie, `/${id}/events`);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ code: "EVENT_CURSOR_EXPIRED", data: { latestEventSeq: 1, earliestAvailableEventSeq: 2 } });
  });

  test("rollout stop blocks new admission but preserves reads and explicit cancellation", async () => {
    const user = await account();
    const created = await (await request(user.cookie, "", { clientRequestId: randomUUID(), entrypoint: "standalone" })).json() as any;
    const id = created.data.id;
    const accepted = await (await request(user.cookie, `/${id}/turns`, { clientRequestId: randomUUID(), expectedStateRevision: 0, text: "讨论设计" })).json() as any;
    accepting = false;
    try {
      expect((await request(user.cookie, "", { clientRequestId: randomUUID(), entrypoint: "standalone" })).status).toBe(503);
      expect((await request(user.cookie, `/${id}/turns`, { clientRequestId: randomUUID(), expectedStateRevision: 1, text: "新请求" })).status).toBe(503);
      expect((await request(user.cookie, `/${id}`)).status).toBe(200);
      const cancelled = await request(user.cookie, `/${id}/turns/${accepted.data.turnId}/cancel`, { expectedStateRevision: 1 });
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toMatchObject({ code: "OK", data: { state: "cancelled", disposition: "cancelled_before_submission" } });
    } finally { accepting = true; }
  });
});
