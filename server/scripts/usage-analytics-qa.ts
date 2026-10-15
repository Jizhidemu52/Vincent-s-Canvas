/** Isolated PostgreSQL-engine + production-router QA. No production DB, key or provider access.
 * Uses the existing optional PGlite runtime: npm install --prefix output/mark-admin-qa/runtime --no-save @electric-sql/pglite
 * From server: bun build scripts/usage-analytics-qa.ts --target=node --outfile ../output/usage-analytics-qa/server.mjs
 * node ../output/usage-analytics-qa/server.mjs [--serve]
 * --serve keeps the isolated fixture on loopback port 3104 for UI QA, never production authentication.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";
import type { Database } from "../src/db";
import type { AppConfig } from "../src/config";
import { encryptSecret } from "../src/security";
import { createAdminUsageRouter, createUsageRouter } from "../src/routes/usage-analytics";
import { CHAT_COMPLETION_PROTOCOLS, createChatRouter } from "../src/routes/chat";
import { beginUsageChat, finishUsageChat } from "../src/usage-analytics";
import { MARK_IMAGE_PROVIDER_ID, MARK_PLATFORM_MODELS } from "../../shared/mark-image-models";

const requireQa = createRequire(resolve("../output/mark-admin-qa/runtime/package.json"));
const { PGlite } = requireQa("@electric-sql/pglite");
const { pgcrypto } = requireQa("@electric-sql/pglite/contrib/pgcrypto");
const { citext } = requireQa("@electric-sql/pglite/contrib/citext");
const database = new PGlite({ extensions: { pgcrypto, citext } }); await database.waitReady;
const migrations = (await readdir("src/migrations")).filter(name => name.endsWith(".sql")).sort();
for (const name of migrations) await database.exec(await readFile(resolve("src/migrations", name), "utf8"));
const adminId = "10000000-0000-4000-8000-000000000001";
const firstId = "10000000-0000-4000-8000-000000000002";
const secondId = "10000000-0000-4000-8000-000000000003";
const guestId = "10000000-0000-4000-8000-000000000004";
const providerId = "20000000-0000-4000-8000-000000000001";
const modelId = "30000000-0000-4000-8000-000000000001";
const encryptionKey = Buffer.alloc(32, 29).toString("base64");
await database.query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'usage-admin','使用分析管理员','super_admin',false),($2,'alice-fixture','张三','designer',false),($3,'bob-fixture','李四','designer',false)", [adminId, firstId, secondId]);
await database.query("INSERT INTO users(id,username,display_name,role,must_change_password,is_guest) VALUES($1,'usage-guest','试用访客','designer',false,true)", [guestId]);
await database.query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'Usage QA Provider','openai-chat','http://unreachable-usage-fixture.invalid/v1',$2)", [providerId, encryptSecret(JSON.stringify({ apiKey: "fixture-usage-secret" }), encryptionKey)]);
await database.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities) VALUES($1,$2,'测试文字模型','fixture-chat',ARRAY['chat'])", [modelId, providerId]);
let queryCount = 0; let fetchCount = 0;
const query = async (sql: string, values: unknown[] = []) => { queryCount++; if (sql.startsWith("FETCH")) fetchCount++; const result = await database.query(sql, values); return { ...result, rowCount: result.affectedRows ?? result.rows.length }; };
const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Database;
const providerInputs: unknown[] = []; let failProvider = false;
const nativeFetch = globalThis.fetch; let chatProviderCalls = 0; let failChatProvider = false;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("http://unreachable-usage-fixture.invalid/")) {
    chatProviderCalls++;
    return failChatProvider ? Response.json({ error: { message: "fixture unavailable" } }, { status: 503 }) : Response.json({ choices: [{ message: { role: "assistant", content: "针织建议" }, finish_reason: "stop" }] });
  }
  return nativeFetch(input, init);
}) as typeof fetch;
const app = express(); app.use(["/api/chat", "/api/trial-chat"], express.json({ limit: "12mb" })); app.use(express.json({ limit: "128kb" }));
app.use((request, _response, next) => {
  const role = request.get("x-qa-role") || "super_admin";
  if (role !== "anonymous") Object.assign(request, { auth: { id: request.get("x-qa-user") || adminId, role, departmentId: null } });
  next();
});
app.use("/api/usage", createUsageRouter(db));
app.use("/api/chat", createChatRouter(db, { OA_LOGIN_ENABLED: "true", PROVIDER_ENCRYPTION_KEY: encryptionKey } as AppConfig));
app.use("/api/trial-chat", createChatRouter(db, { OA_LOGIN_ENABLED: "false", PROVIDER_ENCRYPTION_KEY: encryptionKey } as AppConfig));
app.use("/api/admin/usage", createAdminUsageRouter(db, { PROVIDER_ENCRYPTION_KEY: encryptionKey } as AppConfig, { complete: async (_model, _credentials, input) => {
  providerInputs.push(input); if (failProvider) throw Error("fixture failed api_key=fixture-usage-secret");
  return { content: "统计显示常用文生图板块；旧点击记录缺失，不据此评价人员。", toolCalls: [] };
} }));
app.use((error: Error & { code?: string }, _request: express.Request, response: express.Response, _next: express.NextFunction) => { if (error.code !== "UPSTREAM_REQUEST_FAILED") console.error(error); response.status(500).json({ code: "QA_ERROR", msg: error.message }); });
const server = app.listen(process.argv.includes("--serve") ? 3104 : 0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
const results: string[] = [];
const passed = (name: string) => { results.push(name); console.log(`PASS ${name}`); };
const send = async (path: string, body?: unknown, role = "super_admin", userId = adminId) => fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-qa-role": role, "x-qa-user": userId }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async (response: Response, status = 200) => { const body = await response.json() as any; assert.equal(response.status, status, JSON.stringify(body)); return body; };
try {
  for (const role of ["designer", "department_admin", "anonymous"]) {
    const before = queryCount;
    for (const [path, body] of [["analysis-models", undefined], ["people", undefined], [`people/${firstId}`, undefined], ["export", {}], ["analysis-preview", {}], ["analyze", {}]] as const) await json(await send(`/api/admin/usage/${path}`, body, role), 403);
    assert.equal(queryCount, before); passed(`${role}: all admin endpoints 403 before SQL`);
  }
  const catalogFixtures: Array<{ modelId: string; providerId: string; allowed: boolean; label: string }> = [];
  const catalogCase = async (label: string, protocol: string, options: { providerEnabled?: boolean; modelEnabled?: boolean; credentials?: string | null; capabilities?: string[]; mark?: boolean } = {}) => {
    const fixtureProviderId = options.mark ? MARK_IMAGE_PROVIDER_ID : crypto.randomUUID(); const fixtureModelId = crypto.randomUUID();
    const credentials = options.credentials === undefined ? encryptSecret(JSON.stringify({ apiKey: "catalog-key-secret" }), encryptionKey) : options.credentials;
    await query("INSERT INTO providers(id,name,protocol,base_url,enabled,encrypted_credentials) VALUES($1,$2,$3,'https://catalog-private.invalid/v1',$4,$5)", [fixtureProviderId, `Catalog ${label}`, protocol, options.providerEnabled ?? true, credentials]);
    await query("INSERT INTO model_configs(id,provider_id,name,model_id,enabled,capabilities) VALUES($1,$2,$3,$4,$5,$6)", [fixtureModelId, fixtureProviderId, `Catalog ${label}`, options.mark ? "gpt-6-astra" : `fixture-${label}`, options.modelEnabled ?? true, options.capabilities ?? ["chat"]]);
    catalogFixtures.push({ modelId: fixtureModelId, providerId: fixtureProviderId, label, allowed: (CHAT_COMPLETION_PROTOCOLS as readonly string[]).includes(protocol) && options.providerEnabled !== false && options.modelEnabled !== false && Boolean(credentials?.trim()) && (options.capabilities ?? ["chat"]).includes("chat") });
  };
  for (const protocol of CHAT_COMPLETION_PROTOCOLS) await catalogCase(`supported-${protocol}`, protocol, { mark: protocol === "apimart" });
  for (const protocol of ["comfyui", "runninghub", "volcengine"]) await catalogCase(`unsupported-${protocol}`, protocol);
  await catalogCase("disabled-provider", "openai-chat", { providerEnabled: false });
  await catalogCase("disabled-model", "openai-chat", { modelEnabled: false });
  await catalogCase("no-credentials", "openai-chat", { credentials: null });
  await catalogCase("blank-credentials", "openai-chat", { credentials: "   " });
  await catalogCase("image-only", "openai-chat", { capabilities: ["generate"] });
  const modelDirectory = (await json(await send("/api/admin/usage/analysis-models"))).data.models;
  assert.deepEqual(modelDirectory.map((model: { id: string }) => model.id).sort(), [modelId, ...catalogFixtures.filter(model => model.allowed).map(model => model.modelId)].sort());
  const markPreset = MARK_PLATFORM_MODELS.find(model => model.modelId === "gpt-6-astra")!;
  assert.deepEqual(modelDirectory.find((model: { id: string }) => model.id === catalogFixtures.find(model => model.providerId === MARK_IMAGE_PROVIDER_ID)!.modelId), { id: catalogFixtures.find(model => model.providerId === MARK_IMAGE_PROVIDER_ID)!.modelId, name: markPreset.name, description: markPreset.description });
  for (const model of modelDirectory) assert.ok(Object.keys(model).every(key => ["id", "name", "description"].includes(key)));
  for (const forbidden of ["catalog-private", "catalog-key-secret", "encrypted_credentials", "providerId", "protocol", "base_url", "headers"]) assert.ok(!JSON.stringify(modelDirectory).includes(forbidden));
  passed("analysis model directory uses all supported chat protocols, credential/enabled filters and safe curated fields");
  for (const rejected of catalogFixtures.filter(model => !model.allowed)) {
    const rejectedResponse = await json(await send("/api/admin/usage/analyze", { previewId: crypto.randomUUID(), previewHash: "a".repeat(64), modelConfigId: rejected.modelId, confirm: true }), 400);
    assert.equal(rejectedResponse.code, "USAGE_MODEL_UNAVAILABLE", rejected.label);
  }
  assert.equal(providerInputs.length, 0); assert.equal((await query("SELECT count(*)::int AS total FROM usage_analysis_previews")).rows[0].total, 0);
  for (const fixture of catalogFixtures) { await query("DELETE FROM model_configs WHERE id=$1", [fixture.modelId]); await query("DELETE FROM providers WHERE id=$1", [fixture.providerId]); }
  assert.deepEqual((await json(await send("/api/admin/usage/analysis-models"))).data.models, [{ id: modelId, name: "测试文字模型" }]);
  passed("analysis rejects unavailable/unsupported models before preview claim or provider calls");
  const event = { eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), boardKey: "image", action: "visit" };
  assert.deepEqual((await json(await send("/api/usage/events", { events: [event] }, "designer", firstId))).data, { accepted: 1, duplicates: 0 });
  assert.deepEqual((await json(await send("/api/usage/events", { events: [event] }, "designer", firstId))).data, { accepted: 0, duplicates: 1 });
  assert.equal((await query("SELECT count(*)::int AS total FROM usage_events WHERE user_id=$1", [firstId])).rows[0].total, 1);
  passed("real SQL per-owner event deduplication");
  const injection = await send("/api/usage/events", { events: [{ ...event, userId: secondId, parameters: { apiKey: "INJECTION-SECRET", image: "data:image/png;base64,AAA" } }] }, "designer", firstId);
  assert.equal(injection.status, 400); assert.ok(!(await injection.text()).includes("INJECTION-SECRET")); passed("strict event identity and secret injection rejection");
  await json(await send("/api/usage/events", { events: [{ ...event, eventId: crypto.randomUUID(), action: "change", controlKey: "model", parameters: { modelConfigId: modelId } }, { ...event, eventId: crypto.randomUUID(), action: "gap", controlKey: "collection-gap", parameters: { droppedEventCount: 9 } }] }, "designer", firstId));
  const taskA = crypto.randomUUID(), taskB = crypto.randomUUID();
  await query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,status,tool_key,attempts) VALUES($1,'usage-task-a',$2,'usage-project','image_generation',$3,'张三做红色毛衣 api_key=TASK-SECRET https://private.test/input', $4,$5,'success','image',1),($6,'usage-task-b',$7,'usage-project','inpaint',$3,'李四做花型配色','{}','[]','failed','image-edit',3)", [taskA, firstId, modelId, { resolution: "2K", apiKey: "PARAM-SECRET", inputArchive: { token: "ARCHIVE-SECRET" } }, ["IMAGE-BYTES-SECRET"], taskB, secondId]);
  await query("INSERT INTO tasks(request_id,user_id,project_id,operation_type,prompt,status) VALUES('usage-guest-task',$1,'guest','image_generation','guest-private','success')", [guestId]);
  const chatId = await beginUsageChat(db, { userId: firstId, modelConfigId: modelId, boardKey: "gpt-chat", input: [{ role: "system", content: "SYSTEM-SECRET" }, { role: "user", content: [{ type: "input_text", text: "张三规划春季系列 password=CHAT-SECRET" }, { type: "input_image", image_url: "data:image/png;base64,MEDIA-SECRET" }] }] });
  await finishUsageChat(db, chatId, "success"); await finishUsageChat(db, chatId, "failed");
  const beforeRecovery = (await json(await send("/api/admin/usage/people"))).data;
  assert.deepEqual(beforeRecovery.summary, { visits: 1, interactions: 1, generationRequests: 2, chatRequests: 1, succeeded: 2, failed: 1, pending: 0 });
  assert.equal(beforeRecovery.breakdowns.models[0].count, 3); assert.equal(beforeRecovery.coverage.droppedEventCount, 9);
  await query("UPDATE tasks SET attempts=attempts+1,updated_at=now() WHERE id=$1", [taskA]);
  assert.deepEqual((await json(await send("/api/admin/usage/people"))).data.summary, beforeRecovery.summary);
  passed("distinct generation/chat/interaction totals; recovery and guest excluded; model usage excludes selection");
  const detail = (await json(await send(`/api/admin/usage/people/${firstId}?page=1&pageSize=2`))).data;
  assert.equal(detail.pagination.total, 5); assert.equal(detail.records.length, 2); assert.equal(detail.person.userId, firstId);
  const secondPage = (await json(await send(`/api/admin/usage/people/${firstId}?page=2&pageSize=2`))).data;
  assert.equal(secondPage.records.length, 2); assert.notEqual(detail.records[0].id, secondPage.records[0].id);
  const searched = (await json(await send(`/api/admin/usage/people?search=${encodeURIComponent("张三")}`))).data;
  assert.equal(searched.people.length, 1); assert.equal(searched.summary.generationRequests, 1); assert.equal(searched.summary.failed, 0);
  const me = (await json(await send("/api/usage/me", undefined, "designer", firstId))).data;
  assert.ok(!JSON.stringify(me).includes("李四")); assert.ok(!JSON.stringify(me).includes("prompt")); passed("person pagination and own-only aggregates");
  const preview = (await json(await send("/api/admin/usage/analysis-preview", { userIds: [firstId] }))).data;
  for (const forbidden of ["张三", "李四", firstId, "TASK-SECRET", "CHAT-SECRET", "毛衣", "IMAGE-BYTES", "SYSTEM-SECRET"]) assert.ok(!preview.content.includes(forbidden), forbidden);
  assert.equal(JSON.parse(preview.content).limits.dailyTimezone, "UTC");
  assert.equal(preview.sampleCount, 0); assert.equal(providerInputs.length, 0); passed("preview defaults exclude names, IDs and all prompts; UTC daily buckets explicit; no model call");
  const sampled = (await json(await send("/api/admin/usage/analysis-preview", { includePromptSamples: true }))).data;
  assert.equal(sampled.sampleCount, 3); assert.ok(sampled.content.includes("红色毛衣"));
  for (const forbidden of ["张三", "李四", "TASK-SECRET", "CHAT-SECRET", "MEDIA-SECRET", "SYSTEM-SECRET"]) assert.ok(!sampled.content.includes(forbidden), forbidden);
  passed("opt-in limited prompt snippets redacted without attachments");
  const analyze = { previewId: preview.previewId, previewHash: preview.previewHash, modelConfigId: modelId, confirm: true };
  await query("UPDATE providers SET enabled=false WHERE id=$1", [providerId]);
  await json(await send("/api/admin/usage/analyze", analyze), 400);
  assert.deepEqual((await json(await send("/api/admin/usage/analysis-models"))).data.models, []);
  await query("UPDATE providers SET enabled=true WHERE id=$1", [providerId]);
  await query("UPDATE model_configs SET enabled=false WHERE id=$1", [modelId]);
  await json(await send("/api/admin/usage/analyze", analyze), 400);
  assert.deepEqual((await json(await send("/api/admin/usage/analysis-models"))).data.models, []);
  await query("UPDATE model_configs SET enabled=true WHERE id=$1", [modelId]);
  assert.deepEqual((await query("SELECT status,consumed_at FROM usage_analysis_previews WHERE id=$1", [preview.previewId])).rows[0], { status: "preview", consumed_at: null });
  assert.equal(providerInputs.length, 0); passed("stale selections rechecked immediately before claim; disabling model/provider preserves unused preview");
  await json(await send("/api/admin/usage/analyze", { ...analyze, confirm: false }), 400);
  await json(await send("/api/admin/usage/analyze", { ...analyze, previewHash: "a".repeat(64) }), 409);
  assert.equal(providerInputs.length, 0);
  await json(await send("/api/admin/usage/analyze", analyze));
  await json(await send("/api/admin/usage/analyze", analyze), 409);
  assert.equal(providerInputs.length, 1); assert.equal((providerInputs[0] as any).input[1].content, preview.content); assert.deepEqual((providerInputs[0] as any).tools, []);
  assert.equal((providerInputs[0] as any).webSearch, false); passed("exact frozen preview/model and explicit confirmation; repeat call blocked");
  failProvider = true;
  const failing = { previewId: sampled.previewId, previewHash: sampled.previewHash, modelConfigId: modelId, confirm: true };
  const failure = await send("/api/admin/usage/analyze", failing); assert.equal(failure.status, 502); assert.ok(!(await failure.text()).includes("fixture-usage-secret"));
  await json(await send("/api/admin/usage/analyze", failing), 409); assert.equal(providerInputs.length, 2); failProvider = false;
  passed("failed analysis cannot auto/retry replay and errors do not leak credentials");
  await query("INSERT INTO usage_events(event_id,user_id,board_key,action,occurred_at,received_at) SELECT gen_random_uuid(),$1,'canvas','visit',now()-interval '1 hour',now()-interval '1 hour' FROM generate_series(1,1201)", [firstId]);
  const expected = (await json(await send(`/api/admin/usage/people/${firstId}`))).data.pagination.total;
  const exportResponse = await send("/api/admin/usage/export", { userIds: [firstId] }); assert.equal(exportResponse.status, 200);
  const exported = (await exportResponse.text()).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(exported.at(-1).type, "complete"); assert.equal(exported.at(-1).recordCount, expected); assert.equal(exported.filter(row => row.type === "record").length, expected); assert.ok(fetchCount >= 3);
  const output = JSON.stringify(exported); for (const forbidden of ["TASK-SECRET", "CHAT-SECRET", "PARAM-SECRET", "ARCHIVE-SECRET", "IMAGE-BYTES-SECRET", "MEDIA-SECRET", "SYSTEM-SECRET", "李四", "guest-private"]) assert.ok(!output.includes(forbidden), forbidden);
  passed("complete real SQL cursor export across three pages with owner filter and safe parameters");
  const allExport = await send("/api/admin/usage/export", {}); const allRows = (await allExport.text()).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(allRows.at(-1).recordCount, expected + 1); passed("omitted userIds exports all employees without undocumented cap");
  const longPrompt = "保留针织结构与定位花型所有细节。".repeat(6000) + "完整结尾不可丢失";
  await query("UPDATE tasks SET prompt=$2 WHERE id=$1", [taskA, longPrompt]);
  const longChatId = await beginUsageChat(db, { userId: firstId, modelConfigId: modelId, boardKey: "gpt-chat", input: [{ role: "user", content: longPrompt }] });
  await finishUsageChat(db, longChatId, "success");
  const longRows = (await (await send("/api/admin/usage/export", { userIds: [firstId] })).text()).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(longRows.find(row => row.record?.id === `task:${taskA}`).record.prompt, longPrompt);
  assert.equal(longRows.find(row => row.record?.id === `chat:${longChatId}`).record.prompt, longPrompt);
  const longPreview = (await json(await send("/api/admin/usage/analysis-preview", { userIds: [firstId], includePromptSamples: true }))).data;
  assert.ok(JSON.parse(longPreview.content).promptSamples.every((sample: string) => sample.length <= 280));
  passed("complete long Chinese task/chat prompts exported; only LLM preview snippets are bounded");
  const concurrentRequest = { previewId: longPreview.previewId, previewHash: longPreview.previewHash, modelConfigId: modelId, confirm: true };
  const callsBeforeConcurrent = providerInputs.length;
  const concurrent = await Promise.all([send("/api/admin/usage/analyze", concurrentRequest), send("/api/admin/usage/analyze", concurrentRequest)]);
  assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409]);
  assert.equal(providerInputs.length, callsBeforeConcurrent + 1); passed("concurrent same-preview confirmation atomically submits once");
  const foreignPreview = (await json(await send("/api/admin/usage/analysis-preview", {}))).data;
  await json(await send("/api/admin/usage/analyze", { previewId: foreignPreview.previewId, previewHash: foreignPreview.previewHash, modelConfigId: modelId, confirm: true }, "super_admin", firstId), 409);
  await query("UPDATE usage_analysis_previews SET expires_at=now()-interval '1 second' WHERE id=$1", [foreignPreview.previewId]);
  await json(await send("/api/admin/usage/analyze", { previewId: foreignPreview.previewId, previewHash: foreignPreview.previewHash, modelConfigId: modelId, confirm: true }), 409);
  assert.equal(providerInputs.length, callsBeforeConcurrent + 1); passed("preview ownership and expiry enforced before any provider request");
  const chatCountBefore = (await query("SELECT count(*)::int AS total FROM usage_chat_requests")).rows[0].total;
  const submitted = { modelId, toolKey: "gpt-chat", input: [{ role: "system", content: "SYSTEM-NOT-COLLECTED" }, { role: "user", content: [{ type: "input_text", text: "企业聊天正文 password=HTTP-CHAT-SECRET" }, { type: "input_image", image_url: "data:image/png;base64,HTTP-MEDIA-SECRET" }] }], tools: [] };
  const chatSuccess = await json(await send("/api/chat/responses", submitted, "designer", firstId)); assert.equal(chatSuccess.content, "针织建议");
  failChatProvider = true; const failedChat = await send("/api/chat/responses", submitted, "designer", firstId); assert.equal(failedChat.status, 500); await failedChat.text(); failChatProvider = false;
  await json(await send("/api/trial-chat/responses", submitted, "designer", firstId));
  const realChats = (await query("SELECT prompt,status FROM usage_chat_requests WHERE prompt LIKE '企业聊天正文%' ORDER BY created_at")).rows;
  assert.deepEqual(realChats.map(row => row.status), ["success", "failed"]); assert.equal(chatProviderCalls, 3);
  assert.equal((await query("SELECT count(*)::int AS total FROM usage_chat_requests")).rows[0].total, chatCountBefore + 2);
  for (const forbidden of ["HTTP-CHAT-SECRET", "HTTP-MEDIA-SECRET", "SYSTEM-NOT-COLLECTED"]) assert.ok(!JSON.stringify(realChats).includes(forbidden));
  passed("actual chat HTTP protocol records one success/failure; trial not collected; no automatic resubmit");
  const audits = (await query("SELECT action,detail FROM audit_logs WHERE action LIKE 'usage.%' ORDER BY id")).rows;
  assert.ok(audits.some(row => row.action === "usage.export.completed")); assert.ok(audits.some(row => row.action === "usage.analysis.failed"));
  assert.ok(!JSON.stringify(audits).includes("TASK-SECRET")); assert.ok(!JSON.stringify(audits).includes("fixture-usage-secret")); passed("administrator access/export/analysis audited without content or keys");
  await mkdir(resolve("../output/usage-analytics-qa"), { recursive: true });
  await writeFile(resolve("../output/usage-analytics-qa/report.json"), JSON.stringify({ status: "passed", cases: results.length, checks: results, migrations: migrations.length, exportRecords: expected, fetchPages: fetchCount, providerCalls: 0, mockAnalysisCalls: providerInputs.length, mockChatCalls: chatProviderCalls, server: process.argv.includes("--serve") ? base : null }, null, 2));
  console.log(JSON.stringify({ status: "passed", cases: results.length, providerCalls: 0, base }));
} finally {
  if (!process.argv.includes("--serve")) { globalThis.fetch = nativeFetch; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await database.close(); }
}
