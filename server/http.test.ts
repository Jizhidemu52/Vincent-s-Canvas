import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerState, type WorkspaceSnapshot } from "./api";
import { createApiHttpServer } from "./http";
import { addAssetToProject, createInitialWorkspace, createProject, type GenerationRequest, type GenerationResult, type Profile } from "../src/domain/workspace";

function request(patch: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    projectId: "project-http",
    nodeId: "node-http",
    modelId: "gpt-image-2-low",
    prompt: "generate a clean internal fashion reference",
    referenceNodeIds: ["node-http"],
    outputCount: 1,
    operation: "generate",
    ...patch
  };
}

async function startTestServer(stateFilePath?: string) {
  const state = createServerState({ creditBalance: 10 });
  const server = createApiHttpServer(stateFilePath ? { stateFilePath } : { state });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server failed to bind a port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    state
  };
}

describe("HTTP API server", () => {
  let context: Awaited<ReturnType<typeof startTestServer>>;

  beforeEach(async () => {
    context = await startTestServer();
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      context.server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("serves model and profile endpoints without provider secrets", async () => {
    const modelsResponse = await fetch(`${context.baseUrl}/api/models`);
    const profileResponse = await fetch(`${context.baseUrl}/api/profile`);
    const models = (await modelsResponse.json()) as Array<Record<string, unknown>>;
    const profile = (await profileResponse.json()) as Profile;

    expect(modelsResponse.status).toBe(200);
    expect(profileResponse.status).toBe(200);
    expect(models.some((model) => model.id === "nanobanana2")).toBe(true);
    expect(models.every((model) => !("apiKey" in model))).toBe(true);
    expect(profile.creditBalance).toBe(10);
  });

  it("handles generation over HTTP, updates credit balance, and writes history", async () => {
    const response = await fetch(`${context.baseUrl}/api/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "http-generate-1" },
      body: JSON.stringify(request())
    });
    const result = (await response.json()) as GenerationResult;
    const profile = (await (await fetch(`${context.baseUrl}/api/profile`)).json()) as Profile;
    const history = (await (await fetch(`${context.baseUrl}/api/history`)).json()) as unknown[];

    expect(response.status).toBe(200);
    expect(result.status).toBe("succeeded");
    expect(result.creditCost).toBe(2);
    expect(profile.creditBalance).toBe(8);
    expect(history).toHaveLength(1);
  });

  it("rejects unsupported model operations over HTTP without charging credits", async () => {
    const response = await fetch(`${context.baseUrl}/api/upscale`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "http-unsupported-upscale" },
      body: JSON.stringify(request({ modelId: "gpt-image-2-low", prompt: "", operation: "upscale", outputCount: 1 }))
    });
    const profile = (await (await fetch(`${context.baseUrl}/api/profile`)).json()) as Profile;
    const history = (await (await fetch(`${context.baseUrl}/api/history`)).json()) as unknown[];
    const retryWithSupportedModel = await fetch(`${context.baseUrl}/api/upscale`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "http-unsupported-upscale" },
      body: JSON.stringify(request({ modelId: "upscale-pro", prompt: "", operation: "upscale", outputCount: 1 }))
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ status: "failed", errorMessage: "Model gpt-image-2-low does not support upscale" });
    expect(profile.creditBalance).toBe(10);
    expect(history).toHaveLength(0);
    expect(retryWithSupportedModel.status).toBe(200);
  });

  it("rejects duplicate submissions without double charging", async () => {
    const init = {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "same-http-request" },
      body: JSON.stringify(request())
    };
    await fetch(`${context.baseUrl}/api/generations`, init);
    const duplicateResponse = await fetch(`${context.baseUrl}/api/generations`, init);
    const profile = (await (await fetch(`${context.baseUrl}/api/profile`)).json()) as Profile;
    const history = (await (await fetch(`${context.baseUrl}/api/history`)).json()) as unknown[];

    expect(duplicateResponse.status).toBe(409);
    expect(profile.creditBalance).toBe(8);
    expect(history).toHaveLength(1);
  });

  it("returns clear HTTP errors for invalid JSON, unknown routes, and wrong methods", async () => {
    const invalidJson = await fetch(`${context.baseUrl}/api/generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json"
    });
    const unknownRoute = await fetch(`${context.baseUrl}/api/missing`);
    const wrongMethod = await fetch(`${context.baseUrl}/api/models`, { method: "POST" });

    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toMatchObject({ status: "failed", errorMessage: "Invalid JSON body" });
    expect(unknownRoute.status).toBe(404);
    expect(wrongMethod.status).toBe(405);
  });

  it("supports CORS preflight for future hosted frontend calls", async () => {
    const response = await fetch(`${context.baseUrl}/api/generations`, { method: "OPTIONS" });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("accepts workspace snapshots that include externally dropped image data URLs", async () => {
    const created = createProject(createInitialWorkspace({ userId: "designer-large-image", creditBalance: 80 }), "Dropped image save");
    const largeImageDataUrl = `data:image/png;base64,${"a".repeat(1_200_000)}`;
    const workspace = addAssetToProject(created.workspace, created.project.id, {
      name: "large-dropped-reference.png",
      source: largeImageDataUrl,
      width: 360,
      height: 520
    });

    const saveResponse = await fetch(`${context.baseUrl}/api/workspace`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "designer-large-image" },
      body: JSON.stringify(workspace)
    });
    const snapshot = (await saveResponse.json()) as WorkspaceSnapshot;

    expect(saveResponse.status).toBe(200);
    expect(snapshot.projects[0].nodes.some((node) => node.name === "large-dropped-reference.png")).toBe(true);
    expect(snapshot.projects[0].nodes.some((node) => node.source === largeImageDataUrl)).toBe(true);
  });

  it("persists workspace projects and canvas nodes across server restarts", async () => {
    await new Promise<void>((resolve, reject) => {
      context.server.close((error) => (error ? reject(error) : resolve()));
    });
    const dir = mkdtempSync(join(tmpdir(), "designer-canvas-workspace-"));
    const stateFilePath = join(dir, "server-state.json");
    try {
      const first = await startTestServer(stateFilePath);
      const created = createProject(createInitialWorkspace({ userId: "designer-http", creditBalance: 80 }), "Persisted collection");
      const workspace = addAssetToProject(created.workspace, created.project.id, {
        name: "persisted-reference.jpg",
        source: "/fixtures/fashion-reference.jpg",
        width: 360,
        height: 520
      });
      const saveResponse = await fetch(`${first.baseUrl}/api/workspace`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(workspace)
      });
      await new Promise<void>((resolve, reject) => {
        first.server.close((error) => (error ? reject(error) : resolve()));
      });

      const second = await startTestServer(stateFilePath);
      const snapshot = (await (await fetch(`${second.baseUrl}/api/workspace`)).json()) as WorkspaceSnapshot;
      await new Promise<void>((resolve, reject) => {
        second.server.close((error) => (error ? reject(error) : resolve()));
      });

      expect(saveResponse.status).toBe(200);
      expect(snapshot.projects).toHaveLength(1);
      expect(snapshot.activeProjectId).toBe(created.project.id);
      expect(snapshot.projects[0].nodes.some((node) => node.name === "persisted-reference.jpg")).toBe(true);
      expect(snapshot.profile.userId).toBe("designer-http");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      context = await startTestServer();
    }
  });

  it("isolates workspace snapshots and credits by x-user-id", async () => {
    const aliceCreated = createProject(createInitialWorkspace({ userId: "alice@company.local", creditBalance: 10 }), "Alice collection");
    const bobCreated = createProject(createInitialWorkspace({ userId: "bob@company.local", creditBalance: 10 }), "Bob collection");

    await fetch(`${context.baseUrl}/api/workspace`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "alice@company.local" },
      body: JSON.stringify(aliceCreated.workspace)
    });
    await fetch(`${context.baseUrl}/api/workspace`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "bob@company.local" },
      body: JSON.stringify(bobCreated.workspace)
    });
    await fetch(`${context.baseUrl}/api/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "alice-http-generate", "x-user-id": "alice@company.local" },
      body: JSON.stringify(request({ projectId: aliceCreated.project.id, outputCount: 1 }))
    });

    const aliceSnapshot = (await (await fetch(`${context.baseUrl}/api/workspace`, { headers: { "x-user-id": "alice@company.local" } })).json()) as WorkspaceSnapshot;
    const bobSnapshot = (await (await fetch(`${context.baseUrl}/api/workspace`, { headers: { "x-user-id": "bob@company.local" } })).json()) as WorkspaceSnapshot;
    const aliceHistory = (await (await fetch(`${context.baseUrl}/api/history`, { headers: { "x-user-id": "alice@company.local" } })).json()) as unknown[];
    const bobHistory = (await (await fetch(`${context.baseUrl}/api/history`, { headers: { "x-user-id": "bob@company.local" } })).json()) as unknown[];

    expect(aliceSnapshot.projects[0].name).toBe("Alice collection");
    expect(bobSnapshot.projects[0].name).toBe("Bob collection");
    expect(aliceSnapshot.profile.creditBalance).toBe(8);
    expect(bobSnapshot.profile.creditBalance).toBe(10);
    expect(aliceHistory).toHaveLength(1);
    expect(bobHistory).toHaveLength(0);
  });

  it("allows admin credit adjustments over HTTP and rejects non-admin callers", async () => {
    const adjustResponse = await fetch(`${context.baseUrl}/api/admin/credits`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "admin@company.local" },
      body: JSON.stringify({ targetUserId: "alice@company.local", delta: 25, reason: "monthly allocation" })
    });
    const adjusted = (await adjustResponse.json()) as Profile;
    const aliceProfile = (await (await fetch(`${context.baseUrl}/api/profile`, { headers: { "x-user-id": "alice@company.local" } })).json()) as Profile;
    const unauthorizedResponse = await fetch(`${context.baseUrl}/api/admin/credits`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "designer@company.local" },
      body: JSON.stringify({ targetUserId: "alice@company.local", delta: 10 })
    });
    const afterUnauthorized = (await (await fetch(`${context.baseUrl}/api/profile`, { headers: { "x-user-id": "alice@company.local" } })).json()) as Profile;

    expect(adjustResponse.status).toBe(200);
    expect(adjusted.creditBalance).toBe(35);
    expect(aliceProfile.creditBalance).toBe(35);
    expect(unauthorizedResponse.status).toBe(400);
    expect(await unauthorizedResponse.json()).toMatchObject({ status: "failed", errorMessage: "Admin role required" });
    expect(afterUnauthorized.creditBalance).toBe(35);
  });

  it("allows admins to set designer credit limits and model pricing over HTTP", async () => {
    const limitResponse = await fetch(`${context.baseUrl}/api/admin/credit-limit`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "admin@company.local" },
      body: JSON.stringify({ targetUserId: "alice@company.local", creditLimit: 12, reason: "trial cap" })
    });
    const limited = (await limitResponse.json()) as Profile;
    const overLimitResponse = await fetch(`${context.baseUrl}/api/admin/credits`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "admin@company.local" },
      body: JSON.stringify({ targetUserId: "alice@company.local", delta: 5 })
    });
    const pricingResponse = await fetch(`${context.baseUrl}/api/admin/model-pricing`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "admin@company.local" },
      body: JSON.stringify({ modelId: "gpt-image-2-low", cost: 5, priceCents: 250, currency: "CNY" })
    });
    const models = (await (await fetch(`${context.baseUrl}/api/models`)).json()) as Array<Record<string, unknown>>;

    expect(limitResponse.status).toBe(200);
    expect(limited).toMatchObject({ userId: "alice@company.local", creditBalance: 10, creditLimit: 12 });
    expect(overLimitResponse.status).toBe(400);
    expect(await overLimitResponse.json()).toMatchObject({ status: "failed", errorMessage: "Credit balance cannot exceed assigned limit" });
    expect(pricingResponse.status).toBe(200);
    expect(await pricingResponse.json()).toMatchObject({ id: "gpt-image-2-low", cost: 5, priceCents: 250, currency: "CNY" });
    expect(models.find((model) => model.id === "gpt-image-2-low")).toMatchObject({ cost: 5, priceCents: 250, currency: "CNY" });
  });

  it("allows admins to register provider models over HTTP and rejects invalid callers", async () => {
    const modelRequest = {
      modelId: "http-fashion-v1",
      name: "HTTP Fashion V1",
      provider: "runninghub",
      group: "Image",
      capability: ["generate", "edit"],
      cost: 6,
      priceCents: 399,
      currency: "CNY"
    };
    const registeredResponse = await fetch(`${context.baseUrl}/api/admin/models`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "admin@company.local" },
      body: JSON.stringify(modelRequest)
    });
    const unauthorizedResponse = await fetch(`${context.baseUrl}/api/admin/models`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "designer@company.local" },
      body: JSON.stringify({ ...modelRequest, modelId: "designer-model" })
    });
    const invalidResponse = await fetch(`${context.baseUrl}/api/admin/models`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "admin@company.local" },
      body: JSON.stringify({ ...modelRequest, modelId: "bad-capability", capability: ["download"] })
    });
    const generationResponse = await fetch(`${context.baseUrl}/api/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "http-custom-model-generation" },
      body: JSON.stringify(request({ modelId: "http-fashion-v1", outputCount: 1 }))
    });
    const models = (await (await fetch(`${context.baseUrl}/api/models`)).json()) as Array<Record<string, unknown>>;
    const audit = (await (await fetch(`${context.baseUrl}/api/admin/audit`, { headers: { "x-user-id": "admin@company.local" } })).json()) as Array<Record<string, unknown>>;

    expect(registeredResponse.status).toBe(200);
    expect(await registeredResponse.json()).toMatchObject({ id: "http-fashion-v1", provider: "runninghub", cost: 6, priceCents: 399 });
    expect(unauthorizedResponse.status).toBe(400);
    expect(await unauthorizedResponse.json()).toMatchObject({ status: "failed", errorMessage: "Admin role required" });
    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toMatchObject({ status: "failed", errorMessage: "Model capability must contain supported operations" });
    expect(generationResponse.status).toBe(200);
    expect(await generationResponse.json()).toMatchObject({ creditCost: 6 });
    expect(models.find((model) => model.id === "http-fashion-v1")).toMatchObject({ provider: "runninghub", capability: ["generate", "edit"] });
    expect(models.some((model) => model.id === "designer-model" || model.id === "bad-capability")).toBe(false);
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "model-registry", modelId: "http-fashion-v1", provider: "runninghub" })
      ])
    );
  });

  it("allows admins to configure provider settings over HTTP without leaking secrets", async () => {
    const configuredResponse = await fetch(`${context.baseUrl}/api/admin/provider-settings`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "admin@company.local" },
      body: JSON.stringify({
        provider: "openai",
        mode: "live-ready",
        endpointUrl: "https://api.openai.example/v1/images",
        secretName: "OPENAI_API_KEY",
        secretValue: "sk-http-secret"
      })
    });
    const unauthorizedResponse = await fetch(`${context.baseUrl}/api/admin/provider-settings`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "designer@company.local" },
      body: JSON.stringify({ provider: "runninghub", mode: "live-ready", secretName: "RUNNINGHUB_API_KEY", secretValue: "rh-secret" })
    });
    const providersResponse = await fetch(`${context.baseUrl}/api/admin/providers`, {
      headers: { "x-user-id": "admin@company.local" }
    });
    const configured = (await configuredResponse.json()) as Record<string, unknown>;
    const providers = (await providersResponse.json()) as Array<Record<string, unknown>>;

    expect(configuredResponse.status).toBe(200);
    expect(configured).toMatchObject({
      provider: "openai",
      mode: "live-ready",
      secretConfigured: true,
      endpointUrl: "https://api.openai.example/v1/images",
      configuredSecrets: ["OPENAI_API_KEY"]
    });
    expect(providers.find((provider) => provider.provider === "openai")).toMatchObject({
      mode: "live-ready",
      secretConfigured: true,
      configuredSecrets: ["OPENAI_API_KEY"],
      missingSecrets: []
    });
    expect(JSON.stringify(configured)).not.toContain("sk-http-secret");
    expect(JSON.stringify(providers)).not.toContain("sk-http-secret");
    expect(unauthorizedResponse.status).toBe(400);
    expect(await unauthorizedResponse.json()).toMatchObject({ status: "failed", errorMessage: "Admin role required" });
  });

  it("lists designer accounts over HTTP for admins only", async () => {
    await fetch(`${context.baseUrl}/api/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "alice@company.local", "x-request-id": "http-admin-accounts-alice" },
      body: JSON.stringify(request({ outputCount: 1 }))
    });
    await fetch(`${context.baseUrl}/api/admin/credits`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "admin@company.local" },
      body: JSON.stringify({ targetUserId: "bob@company.local", delta: 12 })
    });

    const accountsResponse = await fetch(`${context.baseUrl}/api/admin/accounts`, {
      headers: { "x-user-id": "admin@company.local" }
    });
    const unauthorizedResponse = await fetch(`${context.baseUrl}/api/admin/accounts`, {
      headers: { "x-user-id": "designer@company.local" }
    });
    const accounts = (await accountsResponse.json()) as Array<Record<string, unknown>>;

    expect(accountsResponse.status).toBe(200);
    expect(accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: "admin@company.local", role: "admin" }),
        expect.objectContaining({ userId: "alice@company.local", creditBalance: 8, creditUsed: 2, historyCount: 1 }),
        expect.objectContaining({ userId: "bob@company.local", creditBalance: 22, creditUsed: 0, historyCount: 0 })
      ])
    );
    expect(unauthorizedResponse.status).toBe(400);
    expect(await unauthorizedResponse.json()).toMatchObject({ status: "failed", errorMessage: "Admin role required" });
  });

  it("rejects non-admin reads of admin usage, audit, and provider status over HTTP", async () => {
    await fetch(`${context.baseUrl}/api/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "alice@company.local", "x-request-id": "http-admin-read-guard" },
      body: JSON.stringify(request({ outputCount: 1 }))
    });

    const usageResponse = await fetch(`${context.baseUrl}/api/admin/usage`, {
      headers: { "x-user-id": "designer@company.local" }
    });
    const auditResponse = await fetch(`${context.baseUrl}/api/admin/audit`, {
      headers: { "x-user-id": "designer@company.local" }
    });
    const providersResponse = await fetch(`${context.baseUrl}/api/admin/providers`, {
      headers: { "x-user-id": "designer@company.local" }
    });

    expect(usageResponse.status).toBe(400);
    expect(await usageResponse.json()).toMatchObject({ status: "failed", errorMessage: "Admin role required" });
    expect(auditResponse.status).toBe(400);
    expect(await auditResponse.json()).toMatchObject({ status: "failed", errorMessage: "Admin role required" });
    expect(providersResponse.status).toBe(400);
    expect(await providersResponse.json()).toMatchObject({ status: "failed", errorMessage: "Admin role required" });
  });

  it("exposes admin generation job logs with designer and task status over HTTP", async () => {
    await fetch(`${context.baseUrl}/api/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "job-log-alice", "x-user-id": "alice@company.local" },
      body: JSON.stringify(request({ outputCount: 1 }))
    });
    await fetch(`${context.baseUrl}/api/upscale`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "job-log-bob", "x-user-id": "bob@company.local" },
      body: JSON.stringify(request({ modelId: "upscale-pro", prompt: "", operation: "upscale", outputCount: 1 }))
    });

    const jobsResponse = await fetch(`${context.baseUrl}/api/admin/jobs`, {
      headers: { "x-user-id": "admin@company.local" }
    });
    const unauthorizedResponse = await fetch(`${context.baseUrl}/api/admin/jobs`, {
      headers: { "x-user-id": "designer@company.local" }
    });

    expect(jobsResponse.status).toBe(200);
    const jobs = (await jobsResponse.json()) as Array<Record<string, unknown>>;
    expect(jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: "alice@company.local", modelId: "gpt-image-2-low", operation: "generate", status: "succeeded", creditCost: 2 }),
        expect.objectContaining({ userId: "bob@company.local", modelId: "upscale-pro", operation: "upscale", status: "succeeded", creditCost: 4 })
      ])
    );
    expect(jobs[0]).toHaveProperty("historyId");
    expect(unauthorizedResponse.status).toBe(400);
    expect(await unauthorizedResponse.json()).toMatchObject({ status: "failed", errorMessage: "Admin role required" });
  });

  it("persists profile balance, history, and duplicate request ids across server restarts", async () => {
    await new Promise<void>((resolve, reject) => {
      context.server.close((error) => (error ? reject(error) : resolve()));
    });
    const dir = mkdtempSync(join(tmpdir(), "designer-canvas-api-"));
    const stateFilePath = join(dir, "server-state.json");
    try {
      const first = await startTestServer(stateFilePath);
      await fetch(`${first.baseUrl}/api/generations`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "persisted-request" },
        body: JSON.stringify(request())
      });
      await new Promise<void>((resolve, reject) => {
        first.server.close((error) => (error ? reject(error) : resolve()));
      });

      const second = await startTestServer(stateFilePath);
      const profile = (await (await fetch(`${second.baseUrl}/api/profile`)).json()) as Profile;
      const history = (await (await fetch(`${second.baseUrl}/api/history`)).json()) as unknown[];
      const duplicate = await fetch(`${second.baseUrl}/api/generations`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "persisted-request" },
        body: JSON.stringify(request())
      });
      await new Promise<void>((resolve, reject) => {
        second.server.close((error) => (error ? reject(error) : resolve()));
      });

      expect(profile.creditBalance).toBe(118);
      expect(history).toHaveLength(1);
      expect(duplicate.status).toBe(409);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      context = await startTestServer();
    }
  });
});
