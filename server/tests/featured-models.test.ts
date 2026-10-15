import { afterEach, describe, expect, test } from "bun:test";
import express, { type ErrorRequestHandler } from "express";
import type { Server } from "node:http";
import { ZodError } from "zod";
import { MARK_IMAGE_PROVIDER_ID } from "../../shared/mark-image-models";
import type { AppConfig } from "../src/config";
import type { Database } from "../src/db";
import { listAvailableDemoModels } from "../src/demo-provider-configuration";
import {
  applyModelPresentation,
  defaultFeaturedModelIds,
  isFeaturedModelCandidate,
  resolveFeaturedModelIds,
} from "../src/model-presentation";
import { createModelConfigurationRouter, createPublicModelRouter } from "../src/routes/model-configuration";

const ids = {
  flare: "20000000-0000-4000-8000-000000000001",
  sunburst: "20000000-0000-4000-8000-000000000002",
  nano21: "20000000-0000-4000-8000-000000000003",
  chat: "20000000-0000-4000-8000-000000000004",
  video: "20000000-0000-4000-8000-000000000005",
  blend: "20000000-0000-4000-8000-000000000006",
  gpt2: "20000000-0000-4000-8000-000000000007",
  grok: "20000000-0000-4000-8000-000000000008",
  official: "20000000-0000-4000-8000-000000000009",
  openToken: "20000000-0000-4000-8000-000000000010",
  other: "20000000-0000-4000-8000-000000000011",
  missing: "20000000-0000-4000-8000-000000000099",
};
const defaultIds = [ids.flare, ids.sunburst, ids.nano21, ids.blend, ids.gpt2];

function model(id = ids.flare, modelId = "gpt-image-2.5-flare", overrides: Record<string, unknown> = {}) {
  return {
    id, modelId, name: modelId, publicNumber: 1,
    providerId: MARK_IMAGE_PROVIDER_ID, providerName: "APIMart 平台", protocol: "apimart",
    providerBaseUrl: "https://api.apimart.ai/v1", providerEnabled: true, enabled: true,
    capabilities: ["generate", "edit", "batch"], creditCost: 4, rmbCost: 0.4,
    workflowConfigId: null, workflowName: null, replacementModelConfigId: null,
    concurrencyLimit: 5, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function catalog() {
  // Deliberately not preset order: defaults must not depend on SQL/name ordering.
  return [
    model(ids.official, "gemini-3.1-flash-image-preview-official"),
    model(ids.openToken, "gpt-image-2", { providerId: ids.openToken, providerName: "OpenToken", protocol: "openai", providerBaseUrl: "https://api.opentoken.io/v1" }),
    model(ids.grok, "grok-imagine-image-2.0", { enabled: false }),
    model(ids.video, "happyhorse-1.1", { capabilities: ["video"] }),
    model(ids.gpt2, "gpt-image-2"),
    model(ids.blend, "midjourney-blend", { capabilities: ["generate"] }),
    model(ids.chat, "gpt-6-astra", { capabilities: ["chat"] }),
    model(ids.nano21, "gemini-nano-banana-2.1"),
    model(ids.sunburst, "gpt-image-2.5-sunburst"),
    model(ids.flare, "gpt-image-2.5-flare"),
  ];
}

describe("featured image model presentation", () => {
  test.each([
    ["enabled Mark image", {}, true],
    ["public row without enabled columns", { enabled: undefined, providerEnabled: undefined }, true],
    ["wrong provider UUID", { providerId: ids.other }, false],
    ["same name on another provider", { providerId: ids.other, providerName: "APIMart 平台" }, false],
    ["wrong protocol", { protocol: "openai" }, false],
    ["unknown preset", { modelId: "unregistered-image" }, false],
    ["disabled model remains an admin candidate", { enabled: false }, true],
    ["disabled provider remains an admin candidate", { providerEnabled: false }, true],
    ["editing without generation", { capabilities: ["edit"] }, false],
    ["mixed chat", { capabilities: ["generate", "chat"] }, false],
    ["mixed video", { capabilities: ["generate", "video"] }, false],
    ["mixed audio", { capabilities: ["generate", "audio"] }, false],
    ["missing capabilities", { capabilities: undefined }, false],
  ] as Array<[string, Record<string, unknown>, boolean]>)("candidate gate: %s", (_label, overrides, expected) => {
    expect(isFeaturedModelCandidate(model(ids.flare, "gpt-image-2.5-flare", overrides))).toBe(expected);
  });

  test("defaults select the first five eligible Mark presets, including Blend but excluding chat, video and disabled Grok", () => {
    const rows = catalog();
    expect(defaultFeaturedModelIds(rows)).toEqual(defaultIds);
    expect(defaultFeaturedModelIds([...rows].reverse())).toEqual(defaultIds);
    expect(rows.filter(isFeaturedModelCandidate).map(row => row.id).sort()).toEqual([
      ids.flare, ids.sunburst, ids.nano21, ids.blend, ids.gpt2, ids.grok, ids.official,
    ].sort());
  });

  test("defaults skip disabled providers and fill from later eligible presets", () => {
    const rows = catalog().map(row => row.id === ids.flare ? { ...row, providerEnabled: false } : row);
    expect(defaultFeaturedModelIds(rows)).toEqual([ids.sunburst, ids.nano21, ids.blend, ids.gpt2, ids.official]);
  });

  test("only an absent setting uses defaults; explicit empty and stale-only settings stay empty", () => {
    const rows = catalog();
    expect(resolveFeaturedModelIds(rows, null)).toEqual(defaultIds);
    expect(resolveFeaturedModelIds(rows, [])).toEqual([]);
    expect(resolveFeaturedModelIds(rows, [ids.missing, ids.grok, ids.chat, ids.video, ids.openToken])).toEqual([]);
  });

  test("configured order is preserved while duplicates, unavailable entries and excess selections are removed", () => {
    const rows = catalog();
    expect(resolveFeaturedModelIds(rows, [ids.official, ids.missing, ids.sunburst, ids.official, ids.openToken, ids.blend]))
      .toEqual([ids.official, ids.sunburst, ids.blend]);
    expect(resolveFeaturedModelIds(rows, [ids.official, ids.gpt2, ids.blend, ids.nano21, ids.sunburst, ids.flare]))
      .toEqual([ids.official, ids.gpt2, ids.blend, ids.nano21, ids.sunburst]);
  });

  test("presentation copies every row, preserves configuration identity and places featured selections ahead of Mark then OpenToken", () => {
    const rows = catalog();
    const before = structuredClone(rows);
    const shown = applyModelPresentation(rows, [ids.official, ids.blend]);
    expect(rows).toEqual(before);
    expect(shown).toHaveLength(rows.length);
    for (const row of shown) {
      const original = rows.find(item => item.id === row.id)!;
      expect(row).not.toBe(original);
      expect(row).toMatchObject({ id: original.id, modelId: original.modelId, providerId: original.providerId });
      expect(typeof row.isFeatured).toBe("boolean");
      expect(Number.isInteger(row.displayOrder)).toBe(true);
      if (![ids.official, ids.blend].includes(row.id)) expect(row.displayOrder).toBeGreaterThanOrEqual(1000);
    }
    const byId = new Map(shown.map(row => [row.id, row]));
    expect(byId.get(ids.official)).toMatchObject({ isFeatured: true, displayOrder: 0 });
    expect(byId.get(ids.blend)).toMatchObject({ isFeatured: true, displayOrder: 1 });
    expect(byId.get(ids.flare)!.displayOrder).toBeLessThan(byId.get(ids.sunburst)!.displayOrder);
    expect(byId.get(ids.sunburst)!.displayOrder).toBeLessThan(byId.get(ids.nano21)!.displayOrder);
    expect(byId.get(ids.gpt2)!.displayOrder).toBeLessThan(byId.get(ids.openToken)!.displayOrder);
    expect(applyModelPresentation(rows, []).every(row => row.isFeatured === false)).toBe(true);
  });
});

describe("read-only demo featured model presentation", () => {
  const provider = { id: MARK_IMAGE_PROVIDER_ID, name: "APIMart 平台", protocol: "apimart", enabled: true, hasCredentials: true };

  test("uses the same first five defaults including Blend without changing the demo catalog", () => {
    const rows = catalog();
    const before = structuredClone(rows);
    const visible = listAvailableDemoModels(rows, [provider]);
    expect(visible.filter(row => row.isFeatured).map(row => row.id)).toEqual(defaultIds);
    expect(visible.filter(row => row.isFeatured).map(row => row.displayOrder)).toEqual([0, 1, 2, 3, 4]);
    expect(visible.some(row => row.id === ids.grok)).toBe(false);
    expect(visible.filter(row => [ids.chat, ids.video].includes(row.id)).every(row => row.isFeatured === false)).toBe(true);
    expect(rows).toEqual(before);
  });

  test("a disabled provider hides all its models even with configured credentials", () => {
    expect(listAvailableDemoModels(catalog(), [{ ...provider, enabled: false }])).toEqual([]);
  });

  test("the actual provider protocol overrides a model's claimed protocol before selection", () => {
    const lyingModel = model(ids.flare, "gpt-image-2.5-flare", { protocol: "apimart" });
    expect(listAvailableDemoModels([lyingModel], [{ ...provider, protocol: "openai" }])).toEqual([]);
    const staleModel = model(ids.flare, "gpt-image-2.5-flare", { protocol: "openai" });
    expect(listAvailableDemoModels([staleModel], [provider])).toEqual([
      expect.objectContaining({ id: ids.flare, protocol: "apimart", isFeatured: true, displayOrder: 0 }),
    ]);
    expect(staleModel.protocol).toBe("openai");
  });
});

type Statement = { source: "pool" | "client"; sql: string; values: unknown[] };

function databaseFixture(initialIds: string[] | null = null) {
  const models = catalog();
  const statements: Statement[] = [];
  let storedIds = initialIds === null ? null : [...initialIds];
  let stagedIds: string[] | null = null;
  let transaction = false;
  let connects = 0;
  let releases = 0;
  let audits = 0;
  let stagedAudits = 0;
  let failOn: "save" | "audit" | null = null;
  const query = async (source: Statement["source"], sql: string, values: unknown[] = []) => {
    statements.push({ source, sql, values });
    if (sql === "BEGIN") { transaction = true; stagedIds = storedIds === null ? null : [...storedIds]; stagedAudits = 0; return { rows: [] }; }
    if (sql === "COMMIT") { storedIds = stagedIds; audits += stagedAudits; transaction = false; return { rows: [] }; }
    if (sql === "ROLLBACK") { transaction = false; stagedIds = null; stagedAudits = 0; return { rows: [] }; }
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("FROM model_configs")) {
      const requested = values.find(Array.isArray) as string[] | undefined;
      let rows = requested ? models.filter(row => requested.includes(row.id)) : models;
      if (sql.includes("m.enabled=true")) rows = rows.filter(row => row.enabled && row.providerEnabled);
      return { rows: rows.map(row => ({ ...row })) };
    }
    if (sql.includes("FROM model_presentation_settings")) {
      const value = source === "client" && transaction ? stagedIds : storedIds;
      return { rows: value === null ? [] : [{ featuredModelIds: [...value] }] };
    }
    if (/INSERT\s+INTO\s+model_presentation_settings/.test(sql)) {
      if (source !== "client" || !transaction) throw new Error("Featured settings must be saved in a transaction");
      if (failOn === "save") throw new Error("Simulated settings write failure");
      const selected = values.find(Array.isArray) as string[] | undefined;
      if (!selected) throw new Error("Settings write did not bind the selected UUID array");
      stagedIds = [...selected];
      return { rows: [{ featuredModelIds: [...selected] }] };
    }
    if (/INSERT\s+INTO\s+audit_logs/.test(sql)) {
      if (source !== "client" || !transaction) throw new Error("Featured audit must share the settings transaction");
      if (failOn === "audit") throw new Error("Simulated audit write failure");
      stagedAudits++;
      return { rows: [] };
    }
    if (sql.includes("FROM pricing_rule_versions") || sql.includes("FROM tool_api_configurations")) return { rows: [] };
    throw new Error(`Unexpected database operation: ${sql}`);
  };
  const client = { query: (sql: string, values?: unknown[]) => query("client", sql, values), release: () => { releases++; } };
  const db = { query: (sql: string, values?: unknown[]) => query("pool", sql, values), connect: async () => { connects++; return client; } } as unknown as Database;
  return {
    db, models, statements,
    get storedIds() { return storedIds; }, get connects() { return connects; }, get releases() { return releases; }, get audits() { return audits; },
    set failOn(value: "save" | "audit" | null) { failOn = value; },
  };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

async function serve(state = databaseFixture()) {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    if (request.headers["x-test-role"] !== "unauthenticated") {
      Object.assign(request, { auth: { id: "10000000-0000-4000-8000-000000000001", role: request.headers["x-test-role"] || "super_admin", departmentId: null } });
    }
    next();
  });
  app.use("/api/admin/model-configuration", createModelConfigurationRouter(state.db, {} as AppConfig));
  app.use("/api/models", createPublicModelRouter(state.db));
  app.use(((error, _request, response, _next) => {
    response.status(error instanceof ZodError ? 400 : 500).json({ error: error instanceof ZodError ? "VALIDATION_ERROR" : "INTERNAL_ERROR" });
  }) as ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return { state, url: `http://127.0.0.1:${address.port}` };
}

function put(url: string, body: unknown, role = "super_admin") {
  return fetch(`${url}/api/admin/model-configuration/featured-models`, {
    method: "PUT", headers: { "content-type": "application/json", "x-test-role": role }, body: JSON.stringify(body),
  });
}

describe("featured model configuration HTTP contract", () => {
  test("GET returns image candidates including disabled choices and unsaved defaults without creating settings", async () => {
    const { state, url } = await serve();
    const response = await fetch(`${url}/api/admin/model-configuration/featured-models`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.featuredModelIds).toEqual(defaultIds);
    expect(body.maxFeatured).toBe(5);
    expect(body.models.map((row: { id: string }) => row.id).sort()).toEqual([
      ids.flare, ids.sunburst, ids.nano21, ids.blend, ids.gpt2, ids.grok, ids.official,
    ].sort());
    expect(body.models.find((row: { id: string }) => row.id === ids.grok)).toMatchObject({ enabled: false, isFeatured: false });
    expect(state.storedIds).toBeNull();
    expect(state.connects).toBe(0);
    expect(state.statements.every(({ sql }) => sql.startsWith("SELECT"))).toBe(true);
  });

  test("PUT persists custom order atomically and GET/public models use that same order", async () => {
    const { state, url } = await serve();
    const selected = [ids.official, ids.blend, ids.flare];
    const response = await put(url, { modelConfigIds: selected });
    expect(response.status).toBe(200);
    expect((await response.json()).featuredModelIds).toEqual(selected);
    expect(state.storedIds).toEqual(selected);
    expect(state.audits).toBe(1);
    expect(state.connects).toBe(1);
    expect(state.releases).toBe(1);
    const writeStatements = state.statements.map(({ sql }) => sql);
    const order = [
      writeStatements.findIndex(sql => sql === "BEGIN"),
      writeStatements.findIndex(sql => sql.includes("pg_advisory_xact_lock")),
      writeStatements.findIndex(sql => sql.includes("FROM model_configs")),
      writeStatements.findIndex(sql => /INSERT\s+INTO\s+model_presentation_settings/.test(sql)),
      writeStatements.findIndex(sql => /INSERT\s+INTO\s+audit_logs/.test(sql)),
      writeStatements.findIndex(sql => sql === "COMMIT"),
    ];
    expect(order.every(index => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(state.statements.every(({ source }) => source === "client")).toBe(true);
    expect(writeStatements).not.toContain("ROLLBACK");

    const reread = await (await fetch(`${url}/api/admin/model-configuration/featured-models`)).json();
    expect(reread.featuredModelIds).toEqual(selected);
    const publicResult = await (await fetch(`${url}/api/models`, { headers: { "x-test-role": "designer" } })).json();
    const featured = publicResult.models.filter((row: { isFeatured: boolean }) => row.isFeatured)
      .sort((a: { displayOrder: number }, b: { displayOrder: number }) => a.displayOrder - b.displayOrder);
    expect(featured.map((row: { id: string }) => row.id)).toEqual(selected);
    expect(featured.map((row: { displayOrder: number }) => row.displayOrder)).toEqual([0, 1, 2]);
    expect(featured.every((row: { id: string; modelId: string }) => row.modelId === row.id)).toBe(true);
  });

  test("saving zero selections stays empty after rereading and never restores the defaults", async () => {
    const { state, url } = await serve(databaseFixture([ids.flare]));
    const response = await put(url, { modelConfigIds: [] });
    expect(response.status).toBe(200);
    expect((await response.json()).featuredModelIds).toEqual([]);
    expect(state.storedIds).toEqual([]);
    const reread = await (await fetch(`${url}/api/admin/model-configuration/featured-models`)).json();
    expect(reread.featuredModelIds).toEqual([]);
    const publicResult = await (await fetch(`${url}/api/models`)).json();
    expect(publicResult.models.every((row: { isFeatured: boolean }) => row.isFeatured === false)).toBe(true);
    expect(publicResult.models.every((row: { displayOrder: number }) => row.displayOrder >= 1000)).toBe(true);
  });

  test.each([
    ["missing field", {}],
    ["null field", { modelConfigIds: null }],
    ["non-array field", { modelConfigIds: ids.flare }],
    ["non-UUID entry", { modelConfigIds: ["gpt-image-2.5-flare"] }],
    ["duplicate entry", { modelConfigIds: [ids.flare, ids.flare] }],
    ["six entries", { modelConfigIds: [ids.flare, ids.sunburst, ids.nano21, ids.blend, ids.gpt2, ids.official] }],
    ["unexpected field", { modelConfigIds: [ids.flare], ignored: true }],
  ])("rejects %s as VALIDATION_ERROR before accessing the database", async (_label, input) => {
    const { state, url } = await serve();
    const response = await put(url, input);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(state.statements).toEqual([]);
    expect(state.connects).toBe(0);
    expect(state.storedIds).toBeNull();
  });

  test.each([
    ["unknown config", ids.missing, null],
    ["non-Mark provider", ids.openToken, null],
    ["disabled model", ids.grok, null],
    ["chat preset", ids.chat, null],
    ["video preset", ids.video, null],
    ["wrong protocol", ids.flare, { protocol: "openai" }],
    ["disabled provider", ids.flare, { providerEnabled: false }],
  ] as Array<[string, string, Record<string, unknown> | null]>)("rejects %s without replacing the saved selection", async (_label, invalidId, overrides) => {
    const state = databaseFixture([ids.sunburst]);
    if (overrides) Object.assign(state.models.find(row => row.id === invalidId)!, overrides);
    const { url } = await serve(state);
    const response = await put(url, { modelConfigIds: [ids.blend, invalidId] });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("INVALID_FEATURED_MODEL");
    expect(state.storedIds).toEqual([ids.sunburst]);
    expect(state.audits).toBe(0);
    expect(state.statements.some(({ sql }) => /INSERT\s+INTO\s+model_presentation_settings/.test(sql))).toBe(false);
    expect(state.statements.map(({ sql }) => sql)).not.toContain("COMMIT");
    expect(state.statements.map(({ sql }) => sql)).toContain("ROLLBACK");
    expect(state.releases).toBe(1);
  });

  test.each(["designer", "department_admin"])("%s cannot read or change featured settings and performs no database operations", async role => {
    const { state, url } = await serve();
    for (const response of [
      await fetch(`${url}/api/admin/model-configuration/featured-models`, { headers: { "x-test-role": role } }),
      await put(url, { modelConfigIds: [ids.flare] }, role),
    ]) {
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("FORBIDDEN");
    }
    expect(state.statements).toEqual([]);
    expect(state.connects).toBe(0);
    expect(state.storedIds).toBeNull();
  });

  test("unauthenticated requests cannot read or change featured settings and perform no database operations", async () => {
    const { state, url } = await serve();
    for (const response of [
      await fetch(`${url}/api/admin/model-configuration/featured-models`, { headers: { "x-test-role": "unauthenticated" } }),
      await put(url, { modelConfigIds: [ids.flare] }, "unauthenticated"),
    ]) {
      expect(response.status).toBe(401);
      expect((await response.json()).error).toBe("UNAUTHENTICATED");
    }
    expect(state.statements).toEqual([]);
    expect(state.connects).toBe(0);
    expect(state.storedIds).toBeNull();
  });

  test.each(["save", "audit"] as const)("rolls back on %s failure and releases the connection", async failure => {
    const state = databaseFixture([ids.sunburst]);
    state.failOn = failure;
    const { url } = await serve(state);
    const response = await put(url, { modelConfigIds: [ids.blend] });
    expect(response.status).toBe(500);
    expect(state.storedIds).toEqual([ids.sunburst]);
    expect(state.audits).toBe(0);
    expect(state.releases).toBe(1);
    expect(state.statements.map(({ sql }) => sql)).toContain("ROLLBACK");
    expect(state.statements.map(({ sql }) => sql)).not.toContain("COMMIT");
  });
});
