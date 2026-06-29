import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerState, type WorkspaceSnapshot } from "./api";
import { createApiHttpServer } from "./http";
import {
  addAssetToProject,
  createInitialWorkspace,
  createProject,
  type GenerationRequest,
  type GenerationResult,
  type LibraryAsset,
  type Profile,
  type PromptPreset
} from "../src/domain/workspace";

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

  it("manages designer prompt presets over HTTP by account", async () => {
    const createResponse = await fetch(`${context.baseUrl}/api/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "alice@company.local" },
      body: JSON.stringify({ prompt: "Use pleated silk, pearl trim, and showroom lighting.", tags: ["Silk", "Trim"] })
    });
    const saved = (await createResponse.json()) as PromptPreset;

    expect(createResponse.status).toBe(200);
    expect(saved).toMatchObject({
      prompt: "Use pleated silk, pearl trim, and showroom lighting.",
      tags: ["silk", "trim"],
      userId: "alice@company.local",
      designerName: "alice"
    });

    const alicePrompts = (await (await fetch(`${context.baseUrl}/api/prompts`, { headers: { "x-user-id": "alice@company.local" } })).json()) as PromptPreset[];
    const bobPrompts = (await (await fetch(`${context.baseUrl}/api/prompts`, { headers: { "x-user-id": "bob@company.local" } })).json()) as PromptPreset[];
    expect(alicePrompts.some((prompt) => prompt.id === saved.id)).toBe(true);
    expect(bobPrompts.some((prompt) => prompt.id === saved.id)).toBe(false);

    const updateResponse = await fetch(`${context.baseUrl}/api/prompts/${saved.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-user-id": "alice@company.local" },
      body: JSON.stringify({ tags: ["silk", "trim", "favorite"] })
    });
    const updated = (await updateResponse.json()) as PromptPreset;
    expect(updateResponse.status).toBe(200);
    expect(updated).toMatchObject({ id: saved.id, tags: ["silk", "trim", "favorite"] });

    const deleteResponse = await fetch(`${context.baseUrl}/api/prompts/${saved.id}`, {
      method: "DELETE",
      headers: { "x-user-id": "alice@company.local" }
    });
    const afterDelete = (await deleteResponse.json()) as PromptPreset[];
    expect(deleteResponse.status).toBe(200);
    expect(afterDelete.some((prompt) => prompt.id === saved.id)).toBe(false);
  });

  it("updates reusable asset metadata over HTTP by account", async () => {
    const asset: LibraryAsset = {
      id: "asset-http-editorial",
      type: "image",
      title: "editorial-reference.jpg",
      source: "/fixtures/fashion-reference.jpg",
      tags: ["generated"],
      createdAt: "2026-06-28T11:00:00.000Z",
      metadata: { folder: "Unfiled", projectId: "project-http" }
    };
    await fetch(`${context.baseUrl}/api/workspace`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "alice@company.local" },
      body: JSON.stringify({ assets: [asset] })
    });

    const updateResponse = await fetch(`${context.baseUrl}/api/assets/${asset.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-user-id": "alice@company.local" },
      body: JSON.stringify({ tags: ["Editorial", "reference", "reference"], folder: "Campaign A" })
    });
    const updated = (await updateResponse.json()) as LibraryAsset;
    const snapshot = (await (await fetch(`${context.baseUrl}/api/workspace`, { headers: { "x-user-id": "alice@company.local" } })).json()) as WorkspaceSnapshot;

    expect(updateResponse.status).toBe(200);
    expect(updated).toMatchObject({
      id: asset.id,
      tags: ["editorial", "reference"],
      metadata: { folder: "Campaign A", projectId: "project-http" }
    });
    expect(snapshot.assets.find((item) => item.id === asset.id)).toMatchObject({ metadata: { folder: "Campaign A" } });
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

  it("routes live-ready provider generations through the live execution boundary over HTTP", async () => {
    const fetchCalls: Array<{ url: string; body?: string }> = [];
    const state = createServerState({ creditBalance: 10 });
    const server = createApiHttpServer({
      state,
      resolveProviderSecret: (name) => (name === "OPENAI_API_KEY" ? "sk-http-live" : undefined),
      providerFetchJson: async (url, init) => {
        fetchCalls.push({ url, body: init.body });
        return {
          ok: true,
          status: 200,
          body: { data: [{ url: "https://cdn.example/http-live.png", width: 1536, height: 1024 }] }
        };
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server failed to bind a port");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      await fetch(`${baseUrl}/api/admin/provider-settings`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": "admin@company.local" },
        body: JSON.stringify({
          provider: "openai",
          mode: "live-ready",
          endpointUrl: "https://api.openai.example/v1/images",
          secretName: "OPENAI_API_KEY",
          secretValue: "sk-admin-secret"
        })
      });
      const response = await fetch(`${baseUrl}/api/generations`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "http-live-provider", "x-user-id": "alice@company.local" },
        body: JSON.stringify(request({ outputCount: 1, providerSettings: { size: "1536x1024", quality: "high" } }))
      });
      const result = (await response.json()) as GenerationResult;
      const profile = (await (await fetch(`${baseUrl}/api/profile`, { headers: { "x-user-id": "alice@company.local" } })).json()) as Profile;
      const jobs = (await (await fetch(`${baseUrl}/api/admin/jobs`, { headers: { "x-user-id": "admin@company.local" } })).json()) as Array<Record<string, unknown>>;

      expect(response.status).toBe(200);
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toBe("https://api.openai.example/v1/images");
      expect(JSON.parse(fetchCalls[0].body ?? "{}")).toMatchObject({ model: "gpt-image-2-low", n: 1, size: "1536x1024", quality: "high" });
      expect(result.outputs[0]).toMatchObject({ source: "https://cdn.example/http-live.png", width: 1536, height: 1024 });
      expect(profile.creditBalance).toBe(8);
      expect(jobs[0]).toMatchObject({ status: "succeeded", providerPayload: { endpointUrl: "https://api.openai.example/v1/images" } });
      expect(JSON.stringify(jobs[0])).not.toContain("sk-admin-secret");
      expect(JSON.stringify(jobs[0])).not.toContain("sk-http-live");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps live provider progress snapshots in admin jobs over HTTP", async () => {
    const state = createServerState({ creditBalance: 20 });
    const server = createApiHttpServer({
      state,
      resolveProviderSecret: (name) => (name === "OPENAI_API_KEY" ? "sk-http-live" : undefined),
      providerFetchJson: async (url) => {
        if (url.endsWith("/images")) {
          return {
            ok: true,
            status: 202,
            body: { jobId: "openai-job-1", status: "running", statusUrl: "https://api.openai.example/v1/images/openai-job-1" }
          };
        }
        return {
          ok: true,
          status: 200,
          body: {
            status: "succeeded",
            data: [{ url: "https://cdn.example/http-progress.png", width: 1024, height: 1024 }]
          }
        };
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server failed to bind a port");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      await fetch(`${baseUrl}/api/admin/provider-settings`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": "admin@company.local" },
        body: JSON.stringify({
          provider: "openai",
          mode: "live-ready",
          endpointUrl: "https://api.openai.example/v1/images",
          secretName: "OPENAI_API_KEY",
          secretValue: "sk-admin-secret"
        })
      });
      const response = await fetch(`${baseUrl}/api/generations`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "http-live-progress", "x-user-id": "alice@company.local" },
        body: JSON.stringify(request({ outputCount: 1 }))
      });
      const result = (await response.json()) as GenerationResult;
      const jobs = (await (await fetch(`${baseUrl}/api/admin/jobs`, { headers: { "x-user-id": "admin@company.local" } })).json()) as Array<Record<string, unknown>>;

      expect(response.status).toBe(200);
      expect(result).toMatchObject({
        providerProgress: {
          providerJobId: "openai-job-1",
          status: "succeeded",
          statusUrl: "https://api.openai.example/v1/images/openai-job-1",
          pollAttempts: 1
        }
      });
      expect(jobs[0]).toMatchObject({
        status: "succeeded",
        providerProgress: {
          providerJobId: "openai-job-1",
          status: "succeeded",
          statusUrl: "https://api.openai.example/v1/images/openai-job-1",
          pollAttempts: 1
        }
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("records live provider failures over HTTP without charging or writing history", async () => {
    const state = createServerState({ creditBalance: 10 });
    const server = createApiHttpServer({
      state,
      resolveProviderSecret: (name) => (name === "OPENAI_API_KEY" ? "sk-http-live" : undefined),
      providerFetchJson: async () => ({
        ok: false,
        status: 503,
        body: { error: { message: "Provider unavailable", code: "UPSTREAM_UNAVAILABLE" } }
      })
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server failed to bind a port");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      await fetch(`${baseUrl}/api/admin/provider-settings`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": "admin@company.local" },
        body: JSON.stringify({
          provider: "openai",
          mode: "live-ready",
          endpointUrl: "https://api.openai.example/v1/images",
          secretName: "OPENAI_API_KEY",
          secretValue: "sk-admin-secret"
        })
      });
      const response = await fetch(`${baseUrl}/api/generations`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "http-live-provider-fail", "x-user-id": "alice@company.local" },
        body: JSON.stringify(request({ outputCount: 1 }))
      });
      const profile = (await (await fetch(`${baseUrl}/api/profile`, { headers: { "x-user-id": "alice@company.local" } })).json()) as Profile;
      const history = (await (await fetch(`${baseUrl}/api/history`, { headers: { "x-user-id": "alice@company.local" } })).json()) as unknown[];
      const jobs = (await (await fetch(`${baseUrl}/api/admin/jobs`, { headers: { "x-user-id": "admin@company.local" } })).json()) as Array<Record<string, unknown>>;

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ status: "failed", errorMessage: "Provider unavailable (UPSTREAM_UNAVAILABLE)" });
      expect(profile.creditBalance).toBe(10);
      expect(history).toHaveLength(0);
      expect(jobs[0]).toMatchObject({ status: "failed", creditCost: 0, errorMessage: "Provider unavailable (UPSTREAM_UNAVAILABLE)" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
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
    expect(adjusted.creditBalance).toBe(25);
    expect(aliceProfile.creditBalance).toBe(25);
    expect(unauthorizedResponse.status).toBe(400);
    expect(await unauthorizedResponse.json()).toMatchObject({ status: "failed", errorMessage: "Admin role required" });
    expect(afterUnauthorized.creditBalance).toBe(25);
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
      body: JSON.stringify({ targetUserId: "alice@company.local", delta: 13 })
    });
    const pricingResponse = await fetch(`${context.baseUrl}/api/admin/model-pricing`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "admin@company.local" },
      body: JSON.stringify({ modelId: "gpt-image-2-low", cost: 5, priceCents: 250, currency: "CNY" })
    });
    const models = (await (await fetch(`${context.baseUrl}/api/models`)).json()) as Array<Record<string, unknown>>;

    expect(limitResponse.status).toBe(200);
    expect(limited).toMatchObject({ userId: "alice@company.local", creditBalance: 0, creditLimit: 12 });
    expect(overLimitResponse.status).toBe(400);
    expect(await overLimitResponse.json()).toMatchObject({ status: "failed", errorMessage: "Credit balance cannot exceed assigned limit" });
    expect(pricingResponse.status).toBe(200);
    expect(await pricingResponse.json()).toMatchObject({ id: "gpt-image-2-low", cost: 5, priceCents: 250, currency: "CNY" });
    expect(models.find((model) => model.id === "gpt-image-2-low")).toMatchObject({ cost: 5, priceCents: 250, currency: "CNY" });
  });

  it("allows admins to set operation pricing over HTTP and uses it for deductions", async () => {
    const pricingResponse = await fetch(`${context.baseUrl}/api/admin/operation-pricing`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "admin@company.local" },
      body: JSON.stringify({ modelId: "background-cleaner", operation: "removeBackground", cost: 3, priceCents: 120, currency: "CNY" })
    });
    const generationResponse = await fetch(`${context.baseUrl}/api/remove-bg`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "http-operation-priced-remove-bg" },
      body: JSON.stringify(request({ modelId: "background-cleaner", prompt: "", operation: "removeBackground", outputCount: 2 }))
    });
    const profile = (await (await fetch(`${context.baseUrl}/api/profile`)).json()) as Profile;
    const history = (await (await fetch(`${context.baseUrl}/api/history`)).json()) as Array<Record<string, unknown>>;
    const models = (await (await fetch(`${context.baseUrl}/api/models`)).json()) as Array<Record<string, unknown>>;

    expect(pricingResponse.status).toBe(200);
    expect(await pricingResponse.json()).toMatchObject({
      id: "background-cleaner",
      operationPricing: { removeBackground: { cost: 3, priceCents: 120, currency: "CNY" } }
    });
    expect(generationResponse.status).toBe(200);
    expect(await generationResponse.json()).toMatchObject({ creditCost: 6 });
    expect(profile.creditBalance).toBe(4);
    expect(history[0]).toMatchObject({ modelId: "background-cleaner", operation: "removeBackground", creditCost: 6, priceCents: 120 });
    expect(models.find((model) => model.id === "background-cleaner")).toMatchObject({
      operationPricing: { removeBackground: { cost: 3, priceCents: 120, currency: "CNY" } }
    });
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
        expect.objectContaining({ userId: "bob@company.local", creditBalance: 12, creditUsed: 0, historyCount: 0 })
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

  it("exposes team generation history with thumbnails only to admins over HTTP", async () => {
    await fetch(`${context.baseUrl}/api/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "team-history-http-alice", "x-user-id": "alice@company.local" },
      body: JSON.stringify(request({ outputCount: 1 }))
    });
    await fetch(`${context.baseUrl}/api/upscale`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "team-history-http-bob", "x-user-id": "bob@company.local" },
      body: JSON.stringify(request({ modelId: "upscale-pro", prompt: "", operation: "upscale", outputCount: 1 }))
    });

    const historyResponse = await fetch(`${context.baseUrl}/api/admin/history`, {
      headers: { "x-user-id": "admin@company.local" }
    });
    const unauthorizedResponse = await fetch(`${context.baseUrl}/api/admin/history`, {
      headers: { "x-user-id": "designer@company.local" }
    });

    expect(historyResponse.status).toBe(200);
    const history = (await historyResponse.json()) as Array<Record<string, unknown>>;
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: "alice@company.local", modelId: "gpt-image-2-low", outputCount: 1 }),
        expect.objectContaining({ userId: "bob@company.local", modelId: "upscale-pro", outputCount: 1 })
      ])
    );
    expect(JSON.stringify(history)).toContain("mock://openai/generate");
    expect(unauthorizedResponse.status).toBe(400);
    expect(await unauthorizedResponse.json()).toMatchObject({ status: "failed", errorMessage: "Admin role required" });
  });

  it("filters team generation history by designer account over HTTP", async () => {
    await fetch(`${context.baseUrl}/api/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "team-history-filter-http-alice", "x-user-id": "alice@company.local" },
      body: JSON.stringify(request({ outputCount: 1 }))
    });
    await fetch(`${context.baseUrl}/api/upscale`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "team-history-filter-http-bob", "x-user-id": "bob@company.local" },
      body: JSON.stringify(request({ modelId: "upscale-pro", prompt: "", operation: "upscale", outputCount: 1 }))
    });

    const historyResponse = await fetch(`${context.baseUrl}/api/admin/history?userId=${encodeURIComponent("bob@company.local")}`, {
      headers: { "x-user-id": "admin@company.local" }
    });

    expect(historyResponse.status).toBe(200);
    const history = (await historyResponse.json()) as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ userId: "bob@company.local", modelId: "upscale-pro", outputCount: 1 });
  });

  it("filters team generation history by project, model, operation, and date window over HTTP", async () => {
    await fetch(`${context.baseUrl}/api/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "team-history-rich-http-alice", "x-user-id": "alice@company.local" },
      body: JSON.stringify(request({ projectId: "project-http-a", outputCount: 1 }))
    });
    await fetch(`${context.baseUrl}/api/upscale`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "team-history-rich-http-bob", "x-user-id": "bob@company.local" },
      body: JSON.stringify(request({ projectId: "project-http-b", modelId: "upscale-pro", prompt: "", operation: "upscale", outputCount: 1 }))
    });

    const query = new URLSearchParams({
      userId: "bob@company.local",
      projectId: "project-http-b",
      modelId: "upscale-pro",
      operation: "upscale",
      from: "2000-01-01T00:00:00.000Z",
      to: "2999-01-01T00:00:00.000Z"
    });
    const historyResponse = await fetch(`${context.baseUrl}/api/admin/history?${query}`, {
      headers: { "x-user-id": "admin@company.local" }
    });
    const invalidDateResponse = await fetch(`${context.baseUrl}/api/admin/history?from=not-a-date`, {
      headers: { "x-user-id": "admin@company.local" }
    });

    expect(historyResponse.status).toBe(200);
    const history = (await historyResponse.json()) as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ userId: "bob@company.local", projectId: "project-http-b", modelId: "upscale-pro", operation: "upscale" });
    expect(invalidDateResponse.status).toBe(400);
    expect(await invalidDateResponse.json()).toMatchObject({ status: "failed", errorMessage: "Invalid history date filter" });
  });

  it("archives selected team generation history over HTTP without changing usage totals", async () => {
    await fetch(`${context.baseUrl}/api/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "team-history-archive-http-alice", "x-user-id": "alice@company.local" },
      body: JSON.stringify(request({ outputCount: 1 }))
    });
    await fetch(`${context.baseUrl}/api/upscale`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "team-history-archive-http-bob", "x-user-id": "bob@company.local" },
      body: JSON.stringify(request({ modelId: "upscale-pro", prompt: "", operation: "upscale", outputCount: 1 }))
    });
    const beforeUsage = (await (
      await fetch(`${context.baseUrl}/api/admin/usage`, { headers: { "x-user-id": "admin@company.local" } })
    ).json()) as Record<string, unknown>;
    const beforeHistory = (await (
      await fetch(`${context.baseUrl}/api/admin/history`, { headers: { "x-user-id": "admin@company.local" } })
    ).json()) as Array<Record<string, unknown>>;
    const bobHistoryId = String(beforeHistory.find((entry) => entry.userId === "bob@company.local")!.id);

    const archiveResponse = await fetch(`${context.baseUrl}/api/admin/history/archive`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "admin@company.local" },
      body: JSON.stringify({ historyIds: [bobHistoryId], reason: "duplicate provider test" })
    });
    const archiveResult = (await archiveResponse.json()) as Record<string, unknown>;
    const visibleHistory = (await (
      await fetch(`${context.baseUrl}/api/admin/history`, { headers: { "x-user-id": "admin@company.local" } })
    ).json()) as Array<Record<string, unknown>>;
    const bobHistory = (await (
      await fetch(`${context.baseUrl}/api/history`, { headers: { "x-user-id": "bob@company.local" } })
    ).json()) as Array<Record<string, unknown>>;
    const afterUsage = (await (
      await fetch(`${context.baseUrl}/api/admin/usage`, { headers: { "x-user-id": "admin@company.local" } })
    ).json()) as Record<string, unknown>;
    const audit = (await (
      await fetch(`${context.baseUrl}/api/admin/audit`, { headers: { "x-user-id": "admin@company.local" } })
    ).json()) as Array<Record<string, unknown>>;

    expect(archiveResponse.status).toBe(200);
    expect(archiveResult).toMatchObject({ archivedCount: 1 });
    expect(visibleHistory).toHaveLength(1);
    expect(visibleHistory[0]).toMatchObject({ userId: "alice@company.local" });
    expect(bobHistory[0]).toMatchObject({ id: bobHistoryId, archivedBy: "admin@company.local", archiveReason: "duplicate provider test" });
    expect(afterUsage.totalHistoryEntries).toBe(beforeUsage.totalHistoryEntries);
    expect(afterUsage.totalCreditsUsed).toBe(beforeUsage.totalCreditsUsed);
    expect(audit[0]).toMatchObject({ eventType: "history-archive", summary: "Archived 1 team history record" });
  });

  it("ignores workspace model registry changes across server restarts because models are server-owned", async () => {
    await new Promise<void>((resolve, reject) => {
      context.server.close((error) => (error ? reject(error) : resolve()));
    });
    const dir = mkdtempSync(join(tmpdir(), "designer-canvas-api-failed-jobs-"));
    const stateFilePath = join(dir, "server-state.json");
    try {
      const first = await startTestServer(stateFilePath);
      const workspace = createInitialWorkspace({ userId: "alice@company.local", creditBalance: 20 });
      const brokenModel = {
        id: "broken-provider-model",
        name: "Broken Provider Model",
        provider: "retired-provider",
        group: "Image",
        capability: ["generate"],
        cost: 5
      };
      await fetch(`${first.baseUrl}/api/workspace`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": "alice@company.local" },
        body: JSON.stringify({ ...workspace, modelRegistry: [...workspace.modelRegistry, brokenModel] })
      });
      const rejected = await fetch(`${first.baseUrl}/api/generations`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "failed-provider-http", "x-user-id": "alice@company.local" },
        body: JSON.stringify(request({ modelId: "broken-provider-model", outputCount: 1 }))
      });
      await new Promise<void>((resolve, reject) => {
        first.server.close((error) => (error ? reject(error) : resolve()));
      });

      const second = await startTestServer(stateFilePath);
      const profile = (await (await fetch(`${second.baseUrl}/api/profile`, { headers: { "x-user-id": "alice@company.local" } })).json()) as Profile;
      const history = (await (await fetch(`${second.baseUrl}/api/history`, { headers: { "x-user-id": "alice@company.local" } })).json()) as unknown[];
      const jobs = (await (await fetch(`${second.baseUrl}/api/admin/jobs`, { headers: { "x-user-id": "admin@company.local" } })).json()) as Array<Record<string, unknown>>;
      const models = (await (await fetch(`${second.baseUrl}/api/models`)).json()) as Array<Record<string, unknown>>;
      await new Promise<void>((resolve, reject) => {
        second.server.close((error) => (error ? reject(error) : resolve()));
      });

      expect(rejected.status).toBe(404);
      expect(profile.creditBalance).toBe(120);
      expect(history).toHaveLength(0);
      expect(jobs.some((job) => job.modelId === "broken-provider-model")).toBe(false);
      expect(models.some((model) => model.id === "broken-provider-model")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      context = await startTestServer();
    }
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
