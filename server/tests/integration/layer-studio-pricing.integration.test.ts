import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express, { type ErrorRequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { reserveCredits } from "../../src/billing";
import type { AppConfig } from "../../src/config";
import { loadLayerStudioPriceSnapshot, settleLayerStudioReservation } from "../../src/layer-studio-billing";
import { createLayerStudioRouter } from "../../src/routes/layer-studio";
import { createModelConfigurationRouter, createPublicModelRouter } from "../../src/routes/model-configuration";
import { resolveToolExecution } from "../../src/tool-configuration";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const integration = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
integration("layer workspace configuration and cost SQL", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let base: string;
  const actorId = randomUUID(); const providerId = randomUUID();
  const modelId = randomUUID(); const otherModelId = randomUUID();
  const rates = { inputRmb: 0.01, lowOutputRmb: 0.1, highOutputRmb: 0.2, sourceNote: "Isolated fixture; not a real price" };
  const pricesPath = "/admin/layer-studio-pricing";
  const row = async (sql: string, values: unknown[] = []) => (await fixture.db.query(sql, values)).rows[0];
  const request = (path: string, method = "GET", body?: unknown, role: string | null = "super_admin") => fetch(base + path, {
    method, headers: { "content-type": "application/json", ...(role ? { "x-fixture-role": role } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.db.query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'layer-price-admin','Price fixture','super_admin',false)", [actorId]);
    await fixture.db.query("INSERT INTO providers(id,name,protocol,base_url) VALUES($1,'Secret layer provider','apimart','https://no-network.invalid')", [providerId]);
    await fixture.db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost) VALUES($1,$2,'Secret layer model','seedream-5-5',ARRAY['generate','edit'],3,777),($3,$2,'Other fixture','other-fixture',ARRAY['generate'],0,0)", [modelId, providerId, otherModelId]);
    const app = express(); app.use(express.json());
    app.use((req, _response, next) => {
      const role = req.get("x-fixture-role");
      if (role) Object.assign(req, { auth: { id: actorId, role, departmentId: null } });
      next();
    });
    app.use("/admin", createModelConfigurationRouter(fixture.db, {} as AppConfig));
    app.use("/studio", createLayerStudioRouter(fixture.db, false));
    app.use("/models", createPublicModelRouter(fixture.db, false));
    app.use(((error, _req, res, _next) => res.status(error.name === "ZodError" ? 400 : error.status ?? 500).json({ error: error.code, message: error.message })) as ErrorRequestHandler);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(done => server.once("listening", done));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 30_000);
  afterAll(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
    await fixture?.close();
  });

  test("migration leaves new module disabled and unbound; only super admin may configure complete rates", async () => {
    expect(await row("SELECT enabled,model_config_id FROM tool_api_configurations WHERE tool_key='layer-studio'")).toEqual({ enabled: false, model_config_id: null });
    expect(await row("SELECT enabled FROM module_flags WHERE module_key='layer-studio'")).toEqual({ enabled: false });
    expect((await request("/studio/estimate", "POST", { parameters: {}, sourceCount: 0 })).status).toBe(403);
    for (const role of [null, "designer", "department_admin"]) {
      expect((await request(pricesPath, "GET", undefined, role)).status).toBe(role ? 403 : 401);
      expect((await request(`${pricesPath}/${modelId}`, "PUT", rates, role)).status).toBe(role ? 403 : 401);
    }
    expect((await request(`${pricesPath}/${modelId}`, "PUT", { ...rates, inputRmb: undefined })).status).toBe(400);
    expect((await request(`${pricesPath}/${otherModelId}`, "PUT", rates)).status).toBe(400);
    expect((await request(`${pricesPath}/${modelId}`, "PUT", { ...rates, highOutputRmb: 0.05 })).status).toBe(400);
    for (const [field, value] of [["inputRmb", 0.0000001], ["lowOutputRmb", 0.1000001], ["highOutputRmb", 0.2000001]] as const) {
      expect((await request(`${pricesPath}/${modelId}`, "PUT", { ...rates, [field]: value })).status).toBe(400);
    }
    expect((await row("SELECT count(*)::int AS n FROM layer_studio_prices")).n).toBe(0);
    const saved = await request(`${pricesPath}/${modelId}`, "PUT", rates);
    expect(saved.status).toBe(200);
    expect((await saved.json()).price).toMatchObject({ ...rates, modelConfigId: modelId, version: 1 });
    expect((await row("SELECT count(*)::int AS n FROM audit_logs WHERE action='layer_studio.price_updated'")).n).toBe(1);
  });

  test("strict dedicated binding, anonymous read-only quote and invalid options rejection", async () => {
    const configuredInput = { modelConfigId: modelId, enabled: true, creditCostOverride: null, rmbCostOverride: null };
    expect((await request("/admin/tool-configurations/image", "PUT", configuredInput)).status).toBe(400);
    expect((await request("/admin/tool-configurations/layer-studio", "PUT", { ...configuredInput, modelConfigId: otherModelId })).status).toBe(400);
    expect((await request("/admin/tool-configurations/layer-studio", "PUT", configuredInput)).status).toBe(200);
    await fixture.db.query("UPDATE module_flags SET enabled=true WHERE module_key='layer-studio'");
    const options = { parameters: { layer_decomposition: true, size: "1K", layer_decomposition_options: { max_images: 4 } }, sourceCount: 1 };
    const quote = await request("/studio/estimate", "POST", options, "designer");
    expect(quote.status).toBe(200); expect(quote.headers.get("cache-control")).toBe("no-store");
    const body = await quote.json();
    expect(body.estimate).toMatchObject({ currency: "CNY", estimatedPrecharge: 0.41, maximumOutputs: 4, employeeCredits: 0, priceVersion: 1, providerCharge: "unverified" });
    expect(JSON.stringify(body)).not.toMatch(/seedream|apimart|Secret|modelConfigId|sourceNote/i);
    for (const parameters of [{ background: "transparent", output_format: "jpeg" }, { layer_decomposition: true, background: "auto" }, { n: 2 }, { size: "4K" }]) {
      const invalid = await request("/studio/estimate", "POST", { parameters, sourceCount: 1 });
      expect(invalid.status).toBe(400); expect((await invalid.json()).error).toBe("INVALID_LAYER_PARAMETERS");
    }
    expect((await row("SELECT count(*)::int AS n FROM tasks")).n).toBe(0);
    expect((await row("SELECT count(*)::int AS n FROM credit_reservations")).n).toBe(0);
    await expect(resolveToolExecution(fixture.db, { operationType: "image_generation", toolKey: "layer-studio", modelConfigId: otherModelId }, { allowModelOverride: true })).rejects.toMatchObject({ code: "TOOL_MODEL_CHANGED" });
    for (const role of ["designer", "department_admin", "super_admin"]) {
      const publicModels = await (await request("/models", "GET", undefined, role)).json();
      expect(JSON.stringify(publicModels)).not.toMatch(/seedream|Secret layer/i);
      expect(publicModels.models.some((model: { id: string }) => model.id === modelId)).toBe(false);
    }
  });

  test("captured estimate uses immutable original rates and actual pixels; repeated settlement is a no-op", async () => {
    const execution = await resolveToolExecution(fixture.db, { operationType: "image_generation", toolKey: "layer-studio" });
    const snapshot = await loadLayerStudioPriceSnapshot(fixture.db, { modelConfigId: modelId, toolConfiguration: execution,
      parameters: { layer_decomposition: true, size: "2K", layer_decomposition_options: { max_images: 8 } }, sourceCount: 1, creditsEnabled: false });
    expect(snapshot.totalRmb).toBe(1.61); expect(snapshot.totalCredits).toBe(0);
    const requestId = randomUUID();
    await reserveCredits(fixture.db, { requestId, userId: actorId, operationType: "image_generation", modelConfigId: modelId, toolConfiguration: execution, quantity: 1, creditsEnabled: false, priceSnapshot: snapshot });
    expect((await request(`${pricesPath}/${modelId}`, "PUT", { ...rates, highOutputRmb: 10 })).status).toBe(200);
    const outputs = [{ width: 1000, height: 1000 }, { width: 2048, height: 2048 }];
    expect(await settleLayerStudioReservation(fixture.db, requestId, outputs)).toEqual({ status: "captured", duplicate: false });
    const saved = await row("SELECT status,rmb_cost::float8 AS cost,price_snapshot FROM credit_reservations WHERE request_id=$1", [requestId]);
    expect(saved).toMatchObject({ status: "captured", cost: 0.31, price_snapshot: { billingDisabled: true,
      totalRmb: 1.61, settledTotalRmb: 0.31, layerStudioCost: { version: 1, highOutputRmb: 0.2, settledOutputCount: 2, providerCharge: "unverified" } } });
    expect(await settleLayerStudioReservation(fixture.db, requestId, outputs)).toEqual({ status: "captured", duplicate: true });
    expect(await row("SELECT status,rmb_cost::float8 AS cost,price_snapshot FROM credit_reservations WHERE request_id=$1", [requestId])).toEqual(saved);
  });

  test("SQL capture failure rolls the amount and snapshot back with the hold", async () => {
    const execution = await resolveToolExecution(fixture.db, { operationType: "image_generation", toolKey: "layer-studio" });
    const snapshot = await loadLayerStudioPriceSnapshot(fixture.db, { modelConfigId: modelId, toolConfiguration: execution, parameters: {}, sourceCount: 0, creditsEnabled: false });
    const requestId = randomUUID();
    await reserveCredits(fixture.db, { requestId, userId: actorId, operationType: "image_generation", modelConfigId: modelId, toolConfiguration: execution, quantity: 1, creditsEnabled: false, priceSnapshot: snapshot });
    const before = await row("SELECT status,rmb_cost,price_snapshot FROM credit_reservations WHERE request_id=$1", [requestId]);
    await fixture.db.query("CREATE FUNCTION layer_capture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='captured' THEN RAISE EXCEPTION 'Fixture capture failure'; END IF; RETURN NEW; END $$");
    await fixture.db.query("CREATE TRIGGER layer_capture_failure BEFORE UPDATE ON credit_reservations FOR EACH ROW EXECUTE FUNCTION layer_capture_failure()");
    try {
      await expect(settleLayerStudioReservation(fixture.db, requestId, [{ width: 1000, height: 1000 }])).rejects.toThrow("Fixture capture failure");
      expect(await row("SELECT status,rmb_cost,price_snapshot FROM credit_reservations WHERE request_id=$1", [requestId])).toEqual(before);
    } finally {
      await fixture.db.query("DROP TRIGGER layer_capture_failure ON credit_reservations");
      await fixture.db.query("DROP FUNCTION layer_capture_failure()");
    }
  });
});
