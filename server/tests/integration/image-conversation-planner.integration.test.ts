import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { expectedRejection } from "../helpers/expected-rejection";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AppConfig } from "../../src/config";
import type { SessionUser } from "../../src/types";
import { encryptSecret } from "../../src/security";
import { resolveToolExecution } from "../../src/tool-configuration";
import { IMAGE_CONVERSATION_PLANNER_MODEL_ID, IMAGE_CONVERSATION_HISTORY_TOOL, prepareImageConversationPlanner, type ImageConversationPlannerInput } from "../../src/image-conversation-planner";
import { createConversationPostgres as createIsolatedPostgres, conversationDatabaseMode } from "../helpers/conversation-postgres";
import { plannerContext, plannerEdit, plannerIds, plannerMessages, plannerReply, plannerText } from "../fixtures/image-conversation-planner";

const integration = conversationDatabaseMode() ? describe : describe.skip;
type Mode = "success" | "rejected" | "invalid-plan" | "invalid-json" | "disconnect" | "lookup" | "lookup-loop" | "lookup-disconnect";

integration("isolated image conversation planner billing and loopback provider", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let baseUrl: string;
  let calls = 0;
  let mode: Mode = "success";
  const requests: Array<{ path: string; body: Record<string, any> }> = [];
  const providerId = randomUUID(), modelId = randomUUID(), alternateProviderId = randomUUID(), alternateModelId = randomUUID();
  const encryptionKey = Buffer.alloc(32, 19).toString("base64");
  const config = { AUTH_ENABLED: "true", CREDITS_ENABLED: "true", PROVIDER_ENCRYPTION_KEY: encryptionKey } as AppConfig;
  const row = async (sql: string, values: unknown[] = []) => (await fixture.db.query(sql, values)).rows[0];

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    const app = express();
    app.use(express.json({ limit: "20mb" }));
    app.post(["/responses", "/chat/completions", "/alternate/responses", "/alternate/chat/completions"], (request, response) => {
      calls++;
      requests.push({ path: request.path, body: request.body });
      if (mode === "disconnect" || mode === "lookup-disconnect" && calls === 2) { request.socket.destroy(); return; }
      if (mode === "rejected") { response.status(503).json({ error: { message: "loopback-only unavailable" } }); return; }
      if (mode === "invalid-json") { response.type("application/json").send('{"choices":['); return; }
      const reply = plannerReply();
      if (mode === "lookup-loop" || ["lookup", "lookup-disconnect"].includes(mode) && calls === 1) reply.toolCalls = [{ id: `history-${calls}`, type: "function", function: { name: IMAGE_CONVERSATION_HISTORY_TOOL, arguments: JSON.stringify({ versionIds: [plannerIds.original] }) } }];
      if (mode === "invalid-plan") reply.toolCalls.push(reply.toolCalls[0]!);
      if (request.path.endsWith("/chat/completions")) {
        response.json({ choices: [{ message: { role: "assistant", content: "", tool_calls: reply.toolCalls }, finish_reason: "tool_calls" }] });
      } else {
        response.json({ status: "completed", output: reply.toolCalls.map(call => ({ type: "function_call", status: "completed", call_id: call.id, ...call.function })) });
      }
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(done => server.once("listening", done));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const [provider, model, suffix] of [[providerId, modelId, ""], [alternateProviderId, alternateModelId, "/alternate"]]) {
      await fixture.db.query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,$4,'apimart',$2,$3)", [provider, baseUrl + suffix, encryptSecret(JSON.stringify({ apiKey: "loopback-fixture-key" }), encryptionKey), `planner-${provider}`]);
      await fixture.db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost) VALUES($1,$2,'Planner fixture',$3,ARRAY['chat','vision'],2,0)", [model, provider, IMAGE_CONVERSATION_PLANNER_MODEL_ID]);
    }
  }, 30_000);

  beforeEach(async () => {
    mode = "success"; calls = 0; requests.length = 0;
    await fixture.db.query("UPDATE providers SET enabled=true,protocol='apimart',base_url=$1,encrypted_credentials=$2 WHERE id=$3", [baseUrl, encryptSecret(JSON.stringify({ apiKey: "loopback-fixture-key" }), encryptionKey), providerId]);
    await fixture.db.query("UPDATE model_configs SET enabled=true,model_id=$1,capabilities=ARRAY['chat','vision'] WHERE id=$2", [IMAGE_CONVERSATION_PLANNER_MODEL_ID, modelId]);
    for (const [key, bound, price] of [["gpt-chat", modelId, 7], ["canvas-chat", alternateModelId, 11], ["canvas-design-chat", alternateModelId, 13]]) {
      await fixture.db.query(`INSERT INTO tool_api_configurations(tool_key,model_config_id,enabled,credit_cost_override,rmb_cost_override)
        VALUES($1,$2,true,$3,0) ON CONFLICT(tool_key) DO UPDATE SET model_config_id=$2,enabled=true,credit_cost_override=$3,rmb_cost_override=0,configuration_version=1`, [key, bound, price]);
    }
    await fixture.db.query("INSERT INTO credit_policy(singleton,credits_enabled) VALUES(true,true) ON CONFLICT(singleton) DO UPDATE SET credits_enabled=true");
  });

  afterAll(async () => {
    if (server) await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
    await fixture?.close();
  });

  async function actor(balance = 100): Promise<SessionUser> {
    const id = randomUUID();
    await fixture.db.query("INSERT INTO users(id,username,display_name,credit_balance,credit_limit,monthly_credit_limit) VALUES($1,$2,'Planner fixture',$3,$3,$3)", [id, `planner-${id}`, balance]);
    return { id, username: `planner-${id}`, displayName: "Planner fixture", email: null, employeeNo: null, role: "designer", status: "active",
      departmentId: null, departmentName: null, groupId: null, groupName: null, groupRole: null, mustChangePassword: false, mfaEnabled: false,
      creditBalance: balance, creditLimit: balance, monthlyCreditLimit: balance, temporaryCreditAdjustment: 0,
      creditPeriodStart: "2026-01-01T00:00:00Z", creditResetAt: "2099-01-01T00:00:00Z" };
  }
  async function prepare(options: { toolKey?: "gpt-chat" | "canvas-chat" | "canvas-design-chat"; user?: Awaited<ReturnType<typeof actor>>; requestId?: string; lookupHistory?: ImageConversationPlannerInput["lookupHistory"] } = {}) {
    const user = options.user ?? await actor();
    const requestId = options.requestId ?? `ic:${randomUUID()}:planner:1`;
    const execution = await resolveToolExecution(fixture.db, { operationType: "chat", toolKey: options.toolKey ?? "gpt-chat" });
    const prepared = await prepareImageConversationPlanner(fixture.db, config, { actor: user, requestId, execution, context: plannerContext(), input: plannerMessages(), lookupHistory: options.lookupHistory });
    return { prepared, user, execution, requestId, reservationId: `chat:${user.id}:${requestId}` };
  }
  const balance = async (id: string) => (await row("SELECT credit_balance FROM users WHERE id=$1", [id])).credit_balance;
  const reservation = (requestId: string) => row("SELECT status,credits FROM credit_reservations WHERE request_id=$1", [requestId]);
  const usage = async (id: string) => (await fixture.db.query("SELECT board_key,prompt,status FROM usage_chat_requests WHERE user_id=$1 ORDER BY created_at", [id])).rows;

  function lookupFixture() {
    const selections: unknown[] = [];
    let validations = 0;
    const lookupHistory: NonNullable<ImageConversationPlannerInput["lookupHistory"]> = async selection => {
      selections.push(selection);
      const context = plannerContext(), input = plannerMessages();
      context.versions[0]!.previewed = true;
      context.manifest.images.push({ versionId: plannerIds.original, assetId: randomUUID(), role: "original", previewed: true });
      input.splice(1, 0, { role: "user", content: [{ type: "input_text", text: "历史原图真实预览" }, { type: "input_image", image_url: "data:image/png;base64,BAUG" }] });
      return { context, input, validate: async () => { validations++; } };
    };
    return { selections, lookupHistory, validations: () => validations };
  }

  test("one bounded history lookup supplies real pixels and stable IDs before the final plan with one logical billing reservation", async () => {
    mode = "lookup";
    const lookup = lookupFixture(), current = await prepare({ lookupHistory: lookup.lookupHistory });
    expect(await current.prepared.run()).toEqual(plannerEdit());
    expect(calls).toBe(2);
    expect(lookup.selections).toEqual([{ versionIds: [plannerIds.original], imageNos: [] }]);
    expect(lookup.validations()).toBe(1);
    expect(requests[0]!.body).toMatchObject({ tool_choice: "required" });
    expect(requests[0]!.body.tools).toHaveLength(2);
    expect(requests[1]!.body.messages.some((message: any) => message.role === "tool" && message.tool_call_id === "history-1")).toBe(true);
    expect(JSON.stringify(requests[1]!.body.messages)).toContain("data:image/png;base64,BAUG");
    expect(requests[1]!.body.messages.at(-1)).toEqual({ role: "user", content: plannerText });
    expect(await reservation(current.reservationId)).toEqual({ status: "captured", credits: 7 });
    expect(await usage(current.user.id)).toHaveLength(1);
  });

  test("lookup loops stop after two reads and a missing second response remains unknown without replay", async () => {
    mode = "lookup-loop";
    const lookup = lookupFixture(), loop = await prepare({ lookupHistory: lookup.lookupHistory });
    expect(await expectedRejection(loop.prepared.run())).toMatchObject({ code: "IMAGE_AGENT_TOOL_INVALID", dispatchOutcome: "rejected" });
    expect(calls).toBe(3); expect(lookup.selections).toHaveLength(2);
    expect(requests[2]!.body.tools).toHaveLength(1);
    calls = 0; mode = "lookup-disconnect";
    const lost = await prepare({ lookupHistory: lookupFixture().lookupHistory });
    expect(await expectedRejection(lost.prepared.run())).toMatchObject({ code: "PLANNER_OUTCOME_UNKNOWN", dispatchOutcome: "unknown" });
    expect(calls).toBe(2);
    expect((await reservation(lost.reservationId)).status).toBe("held");
    expect(await expectedRejection(lost.prepared.run())).toHaveProperty("code", "PLANNER_REQUEST_ALREADY_RUN");
    expect(calls).toBe(2);
  });

  test("one schema plan is billed once, usage excludes private context and repeat admission never resubmits", async () => {
    const current = await prepare();
    expect(await current.prepared.run()).toEqual(plannerEdit());
    expect(calls).toBe(1);
    expect(requests[0]!.path).toBe("/chat/completions");
    expect(requests[0]!.body).toMatchObject({ model: IMAGE_CONVERSATION_PLANNER_MODEL_ID, stream: false, parallel_tool_calls: false,
      tool_choice: { type: "function", function: { name: "plan_image_conversation" } } });
    expect(requests[0]!.body.tools).toHaveLength(1);
    expect(requests[0]!.body.messages.at(-1)).toEqual({ role: "user", content: plannerText });
    expect(await balance(current.user.id)).toBe(93);
    expect(await reservation(current.reservationId)).toEqual({ status: "captured", credits: 7 });
    expect(await usage(current.user.id)).toEqual([{ board_key: "gpt-chat", prompt: plannerText, status: "success" }]);
    const audit = await row("SELECT detail FROM audit_logs WHERE actor_user_id=$1 AND action='chat.completed'", [current.user.id]);
    expect(audit.detail).toMatchObject({ purpose: "image_conversation_planner", requestId: current.requestId, action: "edit" });
    expect(JSON.stringify(audit)).not.toContain("loopback-fixture-key");
    expect(await expectedRejection(current.prepared.run())).toMatchObject({ code: "PLANNER_REQUEST_ALREADY_RUN", dispatchOutcome: "not_submitted" });
    const duplicate = await prepare({ user: current.user, requestId: current.requestId });
    expect(await expectedRejection(duplicate.prepared.run())).toMatchObject({ code: "CHAT_REQUEST_ALREADY_SUBMITTED", dispatchOutcome: "not_submitted" });
    expect(calls).toBe(1); expect(await usage(current.user.id)).toHaveLength(1);
  });

  test("canvas chat uses the shared model but its own price; right-side chat keeps its independent binding", async () => {
    const canvas = await prepare({ toolKey: "canvas-chat" });
    expect(canvas.prepared.modelConfigId).toBe(modelId);
    await canvas.prepared.run();
    expect(await reservation(canvas.reservationId)).toEqual({ status: "captured", credits: 11 });
    await fixture.db.query("UPDATE tool_api_configurations SET model_config_id=NULL WHERE tool_key='gpt-chat'");
    const side = await prepare({ toolKey: "canvas-design-chat" });
    expect(side.prepared.modelConfigId).toBe(alternateModelId);
    await side.prepared.run();
    expect(requests.map(request => request.path)).toEqual(["/chat/completions", "/alternate/chat/completions"]);
    expect(await reservation(side.reservationId)).toEqual({ status: "captured", credits: 13 });
    expect(await expectedRejection(prepare({ toolKey: "canvas-chat" }))).toMatchObject({ code: "CHAT_MODEL_NOT_CONFIGURED" });
    expect(calls).toBe(2);
  });

  test("wrong model, missing vision, disabled provider and invalid credentials fail before billing or HTTP", async () => {
    const mutations = [
      ["UPDATE model_configs SET model_id='unrelated-chat-model' WHERE id=$1", modelId, "PLANNER_MODEL_NOT_CONFIGURED"],
      ["UPDATE model_configs SET model_id='gpt-6.2-sol',capabilities=ARRAY['chat'] WHERE id=$1", modelId, "CHAT_VISION_REQUIRED"],
      ["UPDATE providers SET enabled=false WHERE id=$1", providerId, "MODEL_DISABLED"],
      ["UPDATE providers SET enabled=true,encrypted_credentials='invalid-cipher' WHERE id=$1", providerId, "PROVIDER_NOT_CONFIGURED"],
    ];
    const user = await actor();
    for (const [sql, id, code] of mutations) {
      await fixture.db.query("UPDATE model_configs SET capabilities=ARRAY['chat','vision'] WHERE id=$1", [modelId]);
      await fixture.db.query(sql!, [id]);
      expect(await expectedRejection(prepare({ user }))).toMatchObject({ code });
    }
    expect(calls).toBe(0); expect(await balance(user.id)).toBe(100);
    expect((await row("SELECT count(*)::int n FROM credit_reservations WHERE user_id=$1", [user.id])).n).toBe(0);
  });

  test("price, inherited binding, provider and model changes after prepare invalidate the captured plan", async () => {
    const mutations = [
      "UPDATE tool_api_configurations SET credit_cost_override=12 WHERE tool_key='canvas-chat'",
      "UPDATE tool_api_configurations SET configuration_version=configuration_version+1 WHERE tool_key='gpt-chat'",
      "UPDATE providers SET updated_at=updated_at+interval '1 second'",
      "UPDATE model_configs SET updated_at=updated_at+interval '1 second'",
      "UPDATE model_configs SET credit_cost=credit_cost+1,rmb_cost=rmb_cost+0.01",
    ];
    for (const sql of mutations) {
      const current = await prepare({ toolKey: "canvas-chat" });
      await fixture.db.query(sql);
      expect(await expectedRejection(current.prepared.run())).toMatchObject({ code: "PLANNER_BINDING_CHANGED", dispatchOutcome: "not_submitted" });
      expect(await reservation(current.reservationId)).toBeUndefined();
      expect(await balance(current.user.id)).toBe(100);
    }
    expect(calls).toBe(0);
  });

  test.each(["rejected", "invalid-plan", "invalid-json"] as const)("%s response releases credits without repair or endpoint fallback", async failure => {
    const current = await prepare(); mode = failure;
    expect(await expectedRejection(current.prepared.run())).toMatchObject({ dispatchOutcome: "rejected" });
    expect(calls).toBe(1); expect(await balance(current.user.id)).toBe(100);
    expect(await reservation(current.reservationId)).toEqual({ status: "released", credits: 7 });
    expect(await usage(current.user.id)).toEqual([{ board_key: "gpt-chat", prompt: plannerText, status: "failed" }]);
    expect(await expectedRejection(current.prepared.run())).toMatchObject({ code: "PLANNER_REQUEST_ALREADY_RUN" });
    expect(calls).toBe(1);
  });

  test("connection loss after HTTP receipt retains the held reservation and never automatically retries", async () => {
    const current = await prepare(); mode = "disconnect";
    expect(await expectedRejection(current.prepared.run())).toMatchObject({ code: "PLANNER_OUTCOME_UNKNOWN", dispatchOutcome: "unknown" });
    expect(calls).toBe(1); expect(await balance(current.user.id)).toBe(93);
    expect(await reservation(current.reservationId)).toEqual({ status: "held", credits: 7 });
    const duplicate = await prepare({ user: current.user, requestId: current.requestId });
    expect(await expectedRejection(duplicate.prepared.run())).toMatchObject({ code: "CHAT_REQUEST_ALREADY_SUBMITTED", dispatchOutcome: "not_submitted" });
    expect(calls).toBe(1);
  });

  test("insufficient balance blocks HTTP, while persisted credits-off and zero price stay free", async () => {
    const user = await actor(3), insufficient = await prepare({ user });
    expect(await expectedRejection(insufficient.prepared.run())).toMatchObject({ code: "INSUFFICIENT_CREDIT", dispatchOutcome: "not_submitted" });
    expect(calls).toBe(0); expect(await reservation(insufficient.reservationId)).toBeUndefined();
    await fixture.db.query("UPDATE credit_policy SET credits_enabled=false");
    const disabled = await prepare({ user }); await disabled.prepared.run();
    await fixture.db.query("UPDATE credit_policy SET credits_enabled=true");
    await fixture.db.query("UPDATE tool_api_configurations SET credit_cost_override=0 WHERE tool_key='gpt-chat'");
    const zero = await prepare({ user });
    const results = await Promise.allSettled([zero.prepared.run(), zero.prepared.run()]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(calls).toBe(2); expect(await balance(user.id)).toBe(3);
    expect(await reservation(disabled.reservationId)).toBeUndefined(); expect(await reservation(zero.reservationId)).toBeUndefined();
    expect(await usage(user.id)).toHaveLength(2);
  });

  test.each(["audit", "capture", "usage"] as const)("provider success followed by %s failure atomically rolls back successful bookkeeping", async stage => {
    const current = await prepare();
    const table = stage === "audit" ? "audit_logs" : stage === "capture" ? "credit_reservations" : "usage_chat_requests";
    const condition = stage === "audit" ? "NEW.action='chat.completed'" : `NEW.status='${stage === "capture" ? "captured" : "success"}'`;
    await fixture.db.query(`CREATE FUNCTION planner_audit_failure_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF ${condition} THEN RAISE EXCEPTION 'Planner fixture bookkeeping failure'; END IF; RETURN NEW; END $$`);
    await fixture.db.query(`CREATE TRIGGER planner_audit_failure_fixture BEFORE ${stage === "audit" ? "INSERT" : "UPDATE"} ON ${table} FOR EACH ROW EXECUTE FUNCTION planner_audit_failure_fixture()`);
    try {
      expect(await expectedRejection(current.prepared.run())).toMatchObject({ code: "PLANNER_BOOKKEEPING_FAILED", dispatchOutcome: "rejected" });
      expect(await balance(current.user.id)).toBe(100);
      expect(await reservation(current.reservationId)).toEqual({ status: "released", credits: 7 });
      expect(await usage(current.user.id)).toEqual([{ board_key: "gpt-chat", prompt: plannerText, status: "failed" }]);
      expect((await row("SELECT count(*)::int n FROM audit_logs WHERE actor_user_id=$1 AND action='chat.completed'", [current.user.id])).n).toBe(0);
      expect((await fixture.db.query("SELECT entry_type FROM credit_ledger WHERE user_id=$1 ORDER BY created_at", [current.user.id])).rows.map(item => item.entry_type)).toEqual(["hold", "release"]);
      expect(calls).toBe(1);
    } finally {
      await fixture.db.query(`DROP TRIGGER planner_audit_failure_fixture ON ${table}`);
      await fixture.db.query("DROP FUNCTION planner_audit_failure_fixture()");
    }
  });
});
