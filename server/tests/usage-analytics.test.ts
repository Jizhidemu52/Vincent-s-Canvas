import { describe, expect, test } from "bun:test";
import express from "express";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import type { Database } from "../src/db";
import type { AppConfig } from "../src/config";
import { createAdminUsageRouter, createUsageRouter, streamUsageExport } from "../src/routes/usage-analytics";
import { sanitizeUsagePrompt, submittedChatPrompt, safeUsageParameters, usageEventsSchema, usageFiltersSchema, usageSqlFilter, usageRecordsCte, mapUsageRecord } from "../src/usage-analytics";
import { sessionMiddleware } from "../src/session";
import { loadConfig } from "../src/config";
import { CHAT_COMPLETION_PROTOCOLS } from "../src/routes/chat";
import { MARK_IMAGE_PROVIDER_ID, MARK_PLATFORM_MODELS } from "../../shared/mark-image-models";

const uid = "10000000-0000-4000-8000-000000000001";
const event = () => ({ eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), boardKey: "image", action: "change", controlKey: "resolution", parameters: { resolution: "2K" } });

describe("business usage input privacy", () => {
  test("accepts only known business metadata and semantic controls", () => {
    expect(usageEventsSchema.parse({ events: [event()] }).events).toHaveLength(1);
    for (const controlKey of ["canvas-tool.maskEdit", "fallback:button:0.2.11", "undo"]) expect(usageEventsSchema.safeParse({ events: [{ ...event(), controlKey }] }).success).toBe(true);
    expect(usageEventsSchema.safeParse({ events: [{ ...event(), action: "gap", controlKey: "collection-gap", parameters: { droppedEventCount: 12 } }] }).success).toBe(true);
  });
  test.each(["apiKey", "password", "cookie", "oaToken", "prompt", "image", "sourceUrl", "label", "value"])("rejects metadata field %s without storing its value", key => {
    expect(usageEventsSchema.safeParse({ events: [{ ...event(), parameters: { [key]: "sensitive-sentinel" } }] }).success).toBe(false);
  });
  test("rejects identity injection, free-form fallback, unknown boards and invalid bounds", () => {
    for (const input of [{ ...event(), userId: uid }, { ...event(), controlKey: "fallback:button:password-secret" }, { ...event(), controlKey: "canvas-tool.secret" }, { ...event(), boardKey: "admin" }, { ...event(), parameters: { modelConfigId: "api-key-secret" } }, { ...event(), parameters: { aspectRatio: "https://secret" } }, { ...event(), parameters: { droppedEventCount: 5 } }, { ...event(), occurredAt: "2020-01-01T00:00:00Z" }]) expect(usageEventsSchema.safeParse({ events: [input] }).success).toBe(false);
    expect(usageEventsSchema.safeParse({ events: Array.from({ length: 51 }, event) }).success).toBe(false);
    expect(usageEventsSchema.safeParse({ events: [] }).success).toBe(false);
    expect(usageFiltersSchema.safeParse({ userIds: [] }).success).toBe(false);
  });
  test("redacts credential syntax, JSON credentials, media bytes and contact identifiers", () => {
    const secret = '毛衣设计 password=pass-sentinel {"apiKey":"key-sentinel"} Cookie: cookie-sentinel Authorization: Bearer-token-secret oa_token=oa-sentinel https://private.test/image?token=abc data:image/png;base64,aGVsbG8= alice@example.com 13912345678 sk-abcdefgh12345678';
    const result = sanitizeUsagePrompt(secret);
    expect(result.text).toContain("毛衣设计"); expect(result.redacted).toBe(true);
    for (const forbidden of ["pass-sentinel", "key-sentinel", "cookie-sentinel", "Bearer-token-secret", "oa-sentinel", "private.test", "aGVsbG8", "alice@", "13912345678", "sk-abcdefgh"]) expect(result.text).not.toContain(forbidden);
    expect(sanitizeUsagePrompt("设计一件麻花毛衣")).toEqual({ text: "设计一件麻花毛衣", redacted: false });
    const pathsAndHeaders = sanitizeUsagePrompt("设计毛衣\nC:\\Private\\secret.png\nCookie: auth=alpha-secret; session=beta-secret\nfile:///private/secret.png\n/home/employee/private.jpg").text;
    for (const forbidden of ["Private", "alpha-secret", "beta-secret", "secret.png", "employee"]) expect(pathsAndHeaders).not.toContain(forbidden);
  });
  test("captures only current submitted user text, never attachments/history/tool results", () => {
    expect(submittedChatPrompt([{ role: "user", content: "old" }, { type: "function_call_output", output: "tool-secret" }]).text).toBe("");
    expect(submittedChatPrompt([{ role: "system", content: "system-secret" }, { role: "user", content: [{ type: "input_text", text: "new design" }, { type: "input_image", image_url: "data:image/png;base64,SECRET" }] }]).text).toBe("new design");
  });
  test("preserves long accepted Chinese prompts in records, independent of analysis snippet limits", () => {
    const prompt = "完整保留麻花毛衣细节和针织结构。".repeat(6000) + "末尾不可丢失";
    expect(Buffer.byteLength(prompt)).toBeGreaterThan(60_000);
    expect(sanitizeUsagePrompt(prompt)).toEqual({ text: prompt, redacted: false });
    expect(submittedChatPrompt([{ role: "user", content: prompt }]).text).toBe(prompt);
  });
  test("accepts bounded multi-day offline events, rejects expired/future batches for explicit gap handling", () => {
    expect(usageEventsSchema.safeParse({ events: [{ ...event(), occurredAt: new Date(Date.now() - 3 * 86400000).toISOString() }] }).success).toBe(true);
    expect(usageEventsSchema.safeParse({ events: [{ ...event(), occurredAt: new Date(Date.now() - 8 * 86400000).toISOString() }] }).success).toBe(false);
    expect(usageEventsSchema.safeParse({ events: [{ ...event(), occurredAt: new Date(Date.now() + 6 * 60000).toISOString() }] }).success).toBe(false);
  });
  test("parameter export is a safe allowlist and query values remain bound", () => {
    expect(safeUsageParameters({ size: "3:4", resolution: "2K", count: 1, apiKey: "secret", inputArchive: { password: "secret" }, source_urls: ["secret"] })).toEqual({ aspectRatio: "3:4", size: "3:4", resolution: "2K", count: 1 });
    expect(safeUsageParameters({ size: "1024x1536", duration: 15, seed: 42, steps: 30, strength: .6, watermark: false, output_format: "png", count: 4, n: 4, headers: { token: "secret" } })).toEqual({ aspectRatio: "1024x1536", size: "1024x1536", duration: 15, seed: 42, steps: 30, strength: .6, watermark: false, output_format: "png", count: 4, n: 4 });
    const filter = usageSqlFilter({ userIds: [uid], boardKey: "image", to: "2026-10-16T00:00:00Z" });
    expect(filter.where).toBe("WHERE r.user_id=ANY($1::uuid[]) AND r.occurred_at<$2::timestamptz AND r.board_key=$3");
    expect(filter.values).toEqual([[uid], "2026-10-16T00:00:00Z", "image"]);
    expect(usageRecordsCte).not.toContain("generation_history");
  });
});

describe("usage HTTP authorization", () => {
  test("usage session boundary returns anonymous 403 without creating a guest; existing defaults remain 401", async () => {
    const config = loadConfig({ DATABASE_URL: "postgres://fixture", REDIS_URL: "redis://fixture", OA_LOGIN_ENABLED: "true" });
    for (const desired of [401, 403] as const) {
      let status = 0, continued = false;
      const response = { status(code: number) { status = code; return this; }, json() {} };
      await sessionMiddleware({} as never, {} as never, config, { allowGuest: false, ...(desired === 403 ? { unauthenticatedStatus: 403 } : {}) })({ cookies: {} } as Request, response as unknown as Response, () => { continued = true; });
      expect(status).toBe(desired); expect(continued).toBe(false);
    }
  });
  test.each(["designer", "department_admin", "anonymous"])("%s cannot read, export, preview or analyze", async role => {
    let queries = 0;
    const db = { query: async () => { queries++; throw Error("must not read database"); } } as unknown as Database;
    const app = express(); app.use(express.json());
    app.use((request, _response, next) => { if (role !== "anonymous") Object.assign(request, { auth: { id: uid, role } }); next(); });
    app.use("/api/admin/usage", createAdminUsageRouter(db, {} as AppConfig));
    const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw Error("missing port");
    try {
      for (const [path, method] of [["analysis-models", "GET"], ["people", "GET"], [`people/${uid}`, "GET"], ["export", "POST"], ["analysis-preview", "POST"], ["analyze", "POST"]]) {
        const result = await fetch(`http://127.0.0.1:${address.port}/api/admin/usage/${path}`, { method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) });
        expect(result.status).toBe(403);
      }
      expect(queries).toBe(0);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  test("trial cannot create fake usage records; strict errors never echo injected values", async () => {
    let queries = 0;
    const db = { query: async () => { queries++; return { rows: [] }; } } as unknown as Database;
    const app = express(); app.use(express.json());
    app.use((request, _response, next) => { Object.assign(request, { auth: { id: uid, role: "designer" } }); next(); });
    app.use("/trial", createUsageRouter(db, { enabled: false })); app.use("/usage", createUsageRouter(db));
    const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw Error("missing port");
    try {
      const send = (path: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect((await send("/trial/events", { events: [event()] })).status).toBe(503);
      const result = await send("/usage/events", { events: [{ ...event(), parameters: { apiKey: "secret-should-not-echo" } }] });
      expect(result.status).toBe(400); expect(await result.text()).not.toContain("secret-should-not-echo"); expect(queries).toBe(0);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

describe("administrator analysis model directory", () => {
  async function withServer(db: Database, config: AppConfig, run: (base: string) => Promise<void>) {
    const app = express(); app.use(express.json());
    app.use((request, _response, next) => { Object.assign(request, { auth: { id: uid, role: "super_admin" } }); next(); });
    app.use("/api/admin/usage", createAdminUsageRouter(db, config));
    const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw Error("missing port");
    try { await run(`http://127.0.0.1:${address.port}/api/admin/usage`); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
  test("selects only required safe fields and returns curated UUID/name/description", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = { query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      return { rows: sql.includes("FROM model_configs") ? [{ id: uid, name: "internal model label", modelId: "gpt-6-astra", providerId: MARK_IMAGE_PROVIDER_ID, protocol: "apimart", capabilities: ["chat"], base_url: "https://private-provider.invalid", encrypted_credentials: "SECRET-CIPHER", headers: { authorization: "SECRET-HEADER" } }] : [] };
    } } as unknown as Database;
    await withServer(db, { PROVIDER_ENCRYPTION_KEY: "fixture-present" } as AppConfig, async base => {
      const response = await fetch(`${base}/analysis-models`); const result = await response.json();
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
      const preset = MARK_PLATFORM_MODELS.find(model => model.modelId === "gpt-6-astra")!;
      expect(result).toEqual({ code: 0, data: { models: [{ id: uid, name: preset.name, description: preset.description }] }, msg: "ok" });
      for (const secret of ["private-provider", "SECRET", "headers", "protocol", "providerId", "modelId"]) expect(JSON.stringify(result)).not.toContain(secret);
    });
    const selected = calls.find(call => call.sql.includes("FROM model_configs"))!;
    expect(selected.values).toEqual([CHAT_COMPLETION_PROTOCOLS]);
    for (const field of ["base_url", "encrypted_credentials", "headers"]) expect(selected.sql.slice(0, selected.sql.indexOf(" FROM "))).not.toContain(field);
    expect(selected.sql).toContain("m.enabled=true AND p.enabled=true"); expect(selected.sql).toContain("'chat'=ANY(m.capabilities)");
    expect(selected.sql).toContain("NULLIF(btrim(p.encrypted_credentials),'') IS NOT NULL");
  });
  test("missing encryption configuration returns no selectable models", async () => {
    const queries: string[] = [];
    const db = { query: async (sql: string) => { queries.push(sql); return { rows: [] }; } } as unknown as Database;
    await withServer(db, {} as AppConfig, async base => {
      expect(await (await fetch(`${base}/analysis-models`)).json()).toEqual({ code: 0, data: { models: [] }, msg: "ok" });
    });
    expect(queries.every(sql => !sql.includes("FROM model_configs"))).toBe(true);
  });
  test("unavailable selection is checked before claiming any saved preview", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = { query: async (sql: string, values: unknown[] = []) => { calls.push({ sql, values }); return { rows: [] }; } } as unknown as Database;
    await withServer(db, { PROVIDER_ENCRYPTION_KEY: "fixture-present" } as AppConfig, async base => {
      const response = await fetch(`${base}/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ previewId: uid, previewHash: "a".repeat(64), modelConfigId: uid, confirm: true }) });
      expect(response.status).toBe(400); expect((await response.json()).code).toBe("USAGE_MODEL_UNAVAILABLE");
    });
    expect(calls).toHaveLength(1); expect(calls[0]!.values).toEqual([CHAT_COMPLETION_PROTOCOLS, uid]);
    expect(calls[0]!.sql).toContain("p.protocol=ANY($1::text[])"); expect(calls[0]!.sql).not.toContain("usage_analysis_previews");
  });
});

function exportFixture(total: number, abortAfter?: number) {
  let cursor = 0, fetches = 0, released = false; const commands: string[] = [];
  const lines: string[] = []; const response = new EventEmitter() as EventEmitter & { destroyed: boolean; write: (line: string) => boolean; setHeader: () => void; end: () => void };
  Object.assign(response, { destroyed: false, setHeader() {}, end() {}, write(line: string) { lines.push(line); if (abortAfter && lines.length >= abortAfter) { response.destroyed = true; response.emit("close"); } return true; } });
  const row = (id: number) => ({ id: `event:${id}`, user_id: uid, display_name: "Employee", kind: "visit", board_key: "image", action: "visit", control_key: null, model_config_id: null, status: "recorded", prompt: null, parameters: {}, occurred_at: "2026-10-15T00:00:00Z", updated_at: "2026-10-15T00:00:00Z" });
  const query = async (sql: string) => {
    commands.push(sql);
    if (sql.startsWith("FETCH")) { fetches++; const length = Math.min(500, total - cursor); const rows = Array.from({ length }, (_, i) => row(cursor + i)); cursor += length; return { rows }; }
    if (sql.includes("usage_collection_metadata")) return { rows: [{ startedAt: "2026-10-15T00:00:00Z" }] };
    if (sql.includes("droppedEventCount")) return { rows: [{ count: 0 }] };
    return { rows: [] };
  };
  const db = { query, connect: async () => ({ query, release() { released = true; } }) } as unknown as Database;
  return { db, response, lines, commands, info: () => ({ fetches, released }) };
}
describe("full streaming export", () => {
  test("reads every cursor page, has completion marker and never silently truncates", async () => {
    const fixture = exportFixture(1201);
    await streamUsageExport(fixture.db, { auth: { id: uid, role: "super_admin" } } as unknown as Request, fixture.response as unknown as Response, {});
    const records = fixture.lines.map(line => JSON.parse(line));
    expect(records.filter(row => row.type === "record")).toHaveLength(1201);
    expect(records.at(-1)).toEqual({ type: "complete", recordCount: 1201 });
    expect(fixture.info()).toEqual({ fetches: 3, released: true });
    expect(fixture.commands).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  });
  test("disconnect stops further reads, rolls back and omits completion", async () => {
    const fixture = exportFixture(5000, 25);
    await streamUsageExport(fixture.db, { auth: { id: uid, role: "super_admin" } } as unknown as Request, fixture.response as unknown as Response, {});
    expect(fixture.info()).toEqual({ fetches: 1, released: true });
    expect(fixture.commands).toContain("ROLLBACK");
    expect(fixture.lines.some(line => line.includes('"type":"complete"'))).toBe(false);
  });
  test("record mapping never returns source images, archives or raw secrets", () => {
    const record = mapUsageRecord({ id: "task:1", kind: "generation", user_id: uid, display_name: "A", board_key: "image", action: "image_generation", control_key: null, model_config_id: null, status: "success", occurred_at: "2026-10-15", updated_at: "2026-10-15", prompt: "毛衣 api_key=secret123", source_urls: ["private-media"], parameters: { resolution: "1K", apiKey: "secret123", inputArchive: { image: "private-media" } } });
    expect(record.promptRedacted).toBe(true);
    expect(JSON.stringify(record)).not.toContain("secret123"); expect(JSON.stringify(record)).not.toContain("private-media");
  });
});
