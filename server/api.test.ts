import { describe, expect, it } from "vitest";
import {
  adjustAccountCredits,
  callApi,
  configureModelPricing,
  configureModelRegistry,
  configureProviderSettings,
  listAdminAccounts,
  saveWorkspaceSnapshot,
  setAccountCreditLimit,
  createServerState,
  type ApiError
} from "./api";
import { createInitialWorkspace, createProject } from "../src/domain/workspace";
import type { GenerationRequest, GenerationResult, ModelDefinition, Profile } from "../src/domain/workspace";
import type { AdminAccountSummary, AdminAuditEntry, AdminUsageSummary, ProviderHealth } from "./api";

function request(patch: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    projectId: "project-1",
    nodeId: "node-1",
    modelId: "gpt-image-2-low",
    prompt: "make a clean fashion product image",
    referenceNodeIds: ["node-1"],
    outputCount: 2,
    operation: "generate",
    ...patch
  };
}

describe("backend hosted mock API", () => {
  it("returns model/profile endpoints without exposing provider keys", () => {
    const state = createServerState({ creditBalance: 30 });

    const models = callApi(state, "/api/models") as ReturnType<typeof createServerState>["models"];
    const profile = callApi(state, "/api/profile") as ReturnType<typeof createServerState>["profile"];

    expect(models.some((model) => model.id === "nanobanana2")).toBe(true);
    expect(models.every((model) => !("apiKey" in model))).toBe(true);
    expect(profile.creditBalance).toBe(30);
  });

  it("generates mock outputs, deducts credits, and writes history", () => {
    const state = createServerState({ creditBalance: 30 });

    const result = callApi(state, "/api/generations", request(), "req-1") as GenerationResult;

    expect(result.status).toBe("succeeded");
    expect(result.outputs).toHaveLength(2);
    expect(result.creditCost).toBe(4);
    expect(state.profile.creditBalance).toBe(26);
    expect(state.profile.creditUsed).toBe(4);
    expect(state.history[0]).toMatchObject({
      projectId: "project-1",
      nodeId: "node-1",
      modelId: "gpt-image-2-low",
      outputCount: 2,
      creditCost: 4,
      outputs: result.outputs
    });
  });

  it("rejects invalid prompt before spending credits or writing history", () => {
    const state = createServerState({ creditBalance: 30 });

    const result = callApi(state, "/api/generations", request({ prompt: " " }), "req-empty") as ApiError;

    expect(result).toMatchObject({ status: "failed", errorMessage: "Prompt is required" });
    expect(state.profile.creditBalance).toBe(30);
    expect(state.history).toHaveLength(0);
  });

  it("rejects insufficient credits without dirty side effects", () => {
    const state = createServerState({ creditBalance: 1 });

    const result = callApi(state, "/api/generations", request({ outputCount: 2 }), "req-credit") as ApiError;

    expect(result.errorMessage).toBe("Not enough credits");
    expect(state.profile.creditBalance).toBe(1);
    expect(state.history).toHaveLength(0);
  });

  it("rejects models that do not support the requested operation before charging credits", () => {
    const state = createServerState({ creditBalance: 30 });

    const result = callApi(
      state,
      "/api/upscale",
      request({ modelId: "gpt-image-2-low", prompt: "", operation: "upscale", outputCount: 1 }),
      "unsupported-upscale"
    ) as ApiError;
    const profile = callApi(state, "/api/profile") as Profile;

    expect(result).toMatchObject({ status: "failed", errorMessage: "Model gpt-image-2-low does not support upscale" });
    expect(profile.creditBalance).toBe(30);
    expect(state.history).toHaveLength(0);
    expect(state.submittedRequestIds.has("unsupported-upscale")).toBe(false);
  });

  it("records provider execution failures as failed jobs without charging credits or writing history", () => {
    const state = createServerState({ creditBalance: 30 });
    state.models = [
      ...state.models,
      {
        id: "broken-provider-model",
        name: "Broken Provider Model",
        provider: "retired-provider" as never,
        group: "Image",
        capability: ["generate"],
        cost: 5
      }
    ];

    const result = callApi(
      state,
      "/api/generations",
      request({ modelId: "broken-provider-model", outputCount: 1 }),
      "provider-failure",
      "alice@company.local"
    ) as ApiError;
    const profile = callApi(state, "/api/profile", undefined, undefined, "alice@company.local") as Profile;
    const jobs = callApi(state, "/api/admin/jobs", undefined, undefined, "admin@company.local") as ReturnType<typeof createServerState>["generationJobs"];

    expect(result).toMatchObject({ status: "failed", errorMessage: "Provider adapter not configured for retired-provider" });
    expect(profile.creditBalance).toBe(30);
    expect(callApi(state, "/api/history", undefined, undefined, "alice@company.local")).toHaveLength(0);
    expect(state.submittedRequestIds.has("alice@company.local:provider-failure")).toBe(false);
    expect(jobs[0]).toMatchObject({
      userId: "alice@company.local",
      modelId: "broken-provider-model",
      operation: "generate",
      status: "failed",
      creditCost: 0,
      errorMessage: "Provider adapter not configured for retired-provider"
    });
  });

  it("rejects duplicate submissions without double charging", () => {
    const state = createServerState({ creditBalance: 30 });

    callApi(state, "/api/generations", request(), "same-request");
    const duplicate = callApi(state, "/api/generations", request(), "same-request") as ApiError;

    expect(duplicate.errorMessage).toBe("Duplicate request");
    expect(state.profile.creditBalance).toBe(26);
    expect(state.history).toHaveLength(1);
  });

  it("scopes duplicate request protection by designer account", () => {
    const state = createServerState({ creditBalance: 30 });

    const alice = callApi(state, "/api/generations", request({ outputCount: 1 }), "shared-client-id", "alice@company.local") as GenerationResult;
    const bob = callApi(state, "/api/generations", request({ outputCount: 1 }), "shared-client-id", "bob@company.local") as GenerationResult;

    const aliceProfile = callApi(state, "/api/profile", undefined, undefined, "alice@company.local") as Profile;
    const bobProfile = callApi(state, "/api/profile", undefined, undefined, "bob@company.local") as Profile;

    expect(alice.status).toBe("succeeded");
    expect(bob.status).toBe("succeeded");
    expect(aliceProfile.creditBalance).toBe(28);
    expect(bobProfile.creditBalance).toBe(28);
    expect(callApi(state, "/api/history", undefined, undefined, "alice@company.local")).toHaveLength(1);
    expect(callApi(state, "/api/history", undefined, undefined, "bob@company.local")).toHaveLength(1);
  });

  it("reports admin usage, audit, and provider health without exposing secrets", () => {
    const state = createServerState({ creditBalance: 30 });
    configureModelPricing(state, { modelId: "gpt-image-2-low", cost: 2, priceCents: 150, currency: "CNY" }, "admin@company.local");
    configureModelPricing(state, { modelId: "upscale-pro", cost: 4, priceCents: 320, currency: "CNY" }, "admin@company.local");
    callApi(state, "/api/generations", request({ outputCount: 1 }), "usage-1");
    callApi(state, "/api/upscale", request({ modelId: "upscale-pro", prompt: "", operation: "upscale", outputCount: 1 }), "usage-2");

    const usage = callApi(state, "/api/admin/usage", undefined, undefined, "admin@company.local") as AdminUsageSummary;
    const audit = callApi(state, "/api/admin/audit", undefined, undefined, "admin@company.local") as AdminAuditEntry[];
    const providers = callApi(state, "/api/admin/providers", undefined, undefined, "admin@company.local") as ProviderHealth[];

    expect(usage.totalCreditsUsed).toBeGreaterThan(0);
    expect(usage.modelUsage.some((item) => item.modelId === "gpt-image-2-low")).toBe(true);
    expect(usage.totalPriceCents).toBe(470);
    expect(usage.currency).toBe("CNY");
    expect(usage.modelUsage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelId: "gpt-image-2-low", priceCents: 150, currency: "CNY" }),
        expect.objectContaining({ modelId: "upscale-pro", priceCents: 320, currency: "CNY" })
      ])
    );
    expect(audit.filter((entry) => (entry.eventType ?? "generation") === "generation")).toHaveLength(2);
    expect(providers.every((provider) => provider.keyLocation === "server")).toBe(true);
    expect(providers.some((provider) => provider.provider === "openai" && provider.status === "degraded")).toBe(true);
    expect(providers.some((provider) => provider.provider === "openai" && provider.adapterId === "openai-image-adapter")).toBe(true);
    expect(providers.some((provider) => provider.provider === "openai" && provider.missingSecrets.includes("OPENAI_API_KEY"))).toBe(true);
    expect(JSON.stringify(providers)).not.toContain("sk-");
  });

  it("rejects non-admin reads of team usage, audit, and provider status", () => {
    const state = createServerState({ creditBalance: 30 });
    callApi(state, "/api/generations", request({ outputCount: 1 }), "admin-read-guard", "alice@company.local");

    const usage = callApi(state, "/api/admin/usage", undefined, undefined, "designer@company.local") as ApiError;
    const audit = callApi(state, "/api/admin/audit", undefined, undefined, "designer@company.local") as ApiError;
    const providers = callApi(state, "/api/admin/providers", undefined, undefined, "designer@company.local") as ApiError;

    expect(usage).toMatchObject({ status: "failed", errorMessage: "Admin role required" });
    expect(audit).toMatchObject({ status: "failed", errorMessage: "Admin role required" });
    expect(providers).toMatchObject({ status: "failed", errorMessage: "Admin role required" });
  });

  it("adds designer and project context to admin audit history", () => {
    const state = createServerState({ userId: "admin@company.local", role: "admin", creditBalance: 30 });
    const created = createProject(createInitialWorkspace({ userId: "alice@company.local", designerName: "Alice Designer", creditBalance: 30 }), "Alice launch board");
    saveWorkspaceSnapshot(state, created.workspace, "alice@company.local");

    callApi(state, "/api/generations", request({ projectId: created.project.id, outputCount: 1 }), "alice-context-1", "alice@company.local");

    const audit = callApi(state, "/api/admin/audit", undefined, undefined, "admin@company.local") as ReturnType<typeof createServerState>["history"];
    expect(audit[0]).toMatchObject({
      userId: "alice@company.local",
      designerName: "Alice Designer",
      projectName: "Alice launch board"
    });
  });

  it("keeps designer credits and history isolated by user id", () => {
    const state = createServerState({ creditBalance: 30 });

    callApi(state, "/api/generations", request({ outputCount: 1 }), "alice-1", "alice@company.local");
    callApi(state, "/api/upscale", request({ modelId: "upscale-pro", prompt: "", operation: "upscale", outputCount: 1 }), "bob-1", "bob@company.local");

    const aliceProfile = callApi(state, "/api/profile", undefined, undefined, "alice@company.local") as Profile;
    const bobProfile = callApi(state, "/api/profile", undefined, undefined, "bob@company.local") as Profile;
    const aliceHistory = callApi(state, "/api/history", undefined, undefined, "alice@company.local") as ReturnType<typeof createServerState>["history"];
    const bobHistory = callApi(state, "/api/history", undefined, undefined, "bob@company.local") as ReturnType<typeof createServerState>["history"];
    const usage = callApi(state, "/api/admin/usage", undefined, undefined, "admin@company.local") as AdminUsageSummary;

    expect(aliceProfile.creditBalance).toBe(28);
    expect(bobProfile.creditBalance).toBe(26);
    expect(aliceHistory).toHaveLength(1);
    expect(bobHistory).toHaveLength(1);
    expect(aliceHistory[0].modelId).toBe("gpt-image-2-low");
    expect(bobHistory[0].modelId).toBe("upscale-pro");
    expect(usage.totalHistoryEntries).toBe(2);
    expect(state.history).toHaveLength(0);
  });

  it("lets admins adjust designer credit balances without exposing account state", () => {
    const state = createServerState({ creditBalance: 30 });

    const adjusted = adjustAccountCredits(
      state,
      { targetUserId: "alice@company.local", delta: 15, reason: "monthly allocation" },
      "admin@company.local"
    ) as Profile;
    const aliceProfile = callApi(state, "/api/profile", undefined, undefined, "alice@company.local") as Profile;

    expect(adjusted.creditBalance).toBe(45);
    expect(aliceProfile.creditBalance).toBe(45);
    expect(aliceProfile.creditUsed).toBe(0);
  });

  it("keeps stale workspace snapshots from overwriting server-owned credit balances", () => {
    const state = createServerState({ userId: "admin@company.local", role: "admin", creditBalance: 180 });
    adjustAccountCredits(state, { targetUserId: "admin@company.local", delta: 20 }, "admin@company.local");

    const staleSnapshot = {
      ...state,
      profile: { ...state.profile, creditBalance: 180, credits: 180, creditUsed: 0 }
    };
    const saved = saveWorkspaceSnapshot(state, staleSnapshot, "admin@company.local");

    expect(saved.profile.creditBalance).toBe(200);
    expect(saved.profile.credits).toBe(200);
  });

  it("lets admins cap designer credits and rejects adjustments above the limit", () => {
    const state = createServerState({ creditBalance: 30 });

    const limited = setAccountCreditLimit(
      state,
      { targetUserId: "alice@company.local", creditLimit: 40, reason: "trial designer cap" },
      "admin@company.local"
    ) as Profile;
    const overLimit = adjustAccountCredits(state, { targetUserId: "alice@company.local", delta: 20 }, "admin@company.local") as ApiError;
    const withinLimit = adjustAccountCredits(state, { targetUserId: "alice@company.local", delta: 10 }, "admin@company.local") as Profile;

    expect(limited.creditLimit).toBe(40);
    expect(overLimit).toMatchObject({ status: "failed", errorMessage: "Credit balance cannot exceed assigned limit" });
    expect(withinLimit.creditBalance).toBe(40);
    expect(withinLimit.creditLimit).toBe(40);
  });

  it("lets admins list all designer accounts with balances, usage, limits, and activity", () => {
    const state = createServerState({ userId: "admin@company.local", designerName: "Admin Ops", role: "admin", creditBalance: 100 });

    callApi(state, "/api/generations", request({ outputCount: 1 }), "alice-admin-list", "alice@company.local");
    setAccountCreditLimit(state, { targetUserId: "alice@company.local", creditLimit: 45 }, "admin@company.local");
    adjustAccountCredits(state, { targetUserId: "bob@company.local", delta: 12 }, "admin@company.local");

    const accounts = listAdminAccounts(state, "admin@company.local") as AdminAccountSummary[];
    const unauthorized = listAdminAccounts(state, "designer@company.local") as ApiError;

    expect(accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: "admin@company.local", designerName: "Admin Ops", role: "admin", creditBalance: 100, projectCount: 0 }),
        expect.objectContaining({
          userId: "alice@company.local",
          designerName: "alice",
          role: "designer",
          creditBalance: 45,
          creditUsed: 2,
          creditLimit: 45,
          historyCount: 1
        }),
        expect.objectContaining({ userId: "bob@company.local", role: "designer", creditBalance: 112, creditUsed: 0, historyCount: 0 })
      ])
    );
    expect(accounts.map((account) => account.userId)).toEqual(["admin@company.local", "alice@company.local", "bob@company.local"]);
    expect(unauthorized).toMatchObject({ status: "failed", errorMessage: "Admin role required" });
  });

  it("lets admins configure model credit cost and displayed money price used for later generations", () => {
    const state = createServerState({ creditBalance: 30 });

    const priced = configureModelPricing(
      state,
      { modelId: "gpt-image-2-low", cost: 5, priceCents: 250, currency: "CNY" },
      "admin@company.local"
    ) as ModelDefinition;
    const result = callApi(state, "/api/generations", request({ outputCount: 2 }), "priced-generation") as GenerationResult;
    const profile = callApi(state, "/api/profile") as Profile;
    const models = callApi(state, "/api/models") as ModelDefinition[];

    expect(priced).toMatchObject({ id: "gpt-image-2-low", cost: 5, priceCents: 250, currency: "CNY" });
    expect(result.creditCost).toBe(10);
    expect(profile.creditBalance).toBe(20);
    expect(models.find((model) => model.id === "gpt-image-2-low")).toMatchObject({ cost: 5, priceCents: 250, currency: "CNY" });
  });

  it("lets admins register provider models used by later generations", () => {
    const state = createServerState({ creditBalance: 40 });

    const registered = configureModelRegistry(
      state,
      {
        modelId: "custom-fashion-v1",
        name: "Custom Fashion V1",
        provider: "runninghub",
        group: "Image",
        capability: ["generate", "edit"],
        cost: 6,
        priceCents: 399,
        currency: "CNY"
      },
      "admin@company.local"
    ) as ModelDefinition;
    const result = callApi(
      state,
      "/api/generations",
      request({ modelId: "custom-fashion-v1", outputCount: 2 }),
      "custom-fashion-generation"
    ) as GenerationResult;
    const models = callApi(state, "/api/models") as ModelDefinition[];
    const audit = callApi(state, "/api/admin/audit", undefined, undefined, "admin@company.local") as AdminAuditEntry[];

    expect(registered).toMatchObject({
      id: "custom-fashion-v1",
      name: "Custom Fashion V1",
      provider: "runninghub",
      capability: ["generate", "edit"],
      cost: 6,
      priceCents: 399,
      currency: "CNY"
    });
    expect(result.creditCost).toBe(12);
    expect(models.find((model) => model.id === "custom-fashion-v1")).toMatchObject({ provider: "runninghub", cost: 6 });
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "model-registry", modelId: "custom-fashion-v1", provider: "runninghub" })
      ])
    );
  });

  it("rejects unauthorized or invalid model registry changes without dirty side effects", () => {
    const state = createServerState({ creditBalance: 30 });

    const unauthorized = configureModelRegistry(
      state,
      {
        modelId: "designer-model",
        name: "Designer Model",
        provider: "openai",
        group: "Image",
        capability: ["generate"],
        cost: 4
      },
      "designer@company.local"
    ) as ApiError;
    const invalidCapability = configureModelRegistry(
      state,
      {
        modelId: "bad-capability",
        name: "Bad Capability",
        provider: "openai",
        group: "Image",
        capability: ["download" as never],
        cost: 4
      },
      "admin@company.local"
    ) as ApiError;
    const models = callApi(state, "/api/models") as ModelDefinition[];

    expect(unauthorized).toMatchObject({ status: "failed", errorMessage: "Admin role required" });
    expect(invalidCapability).toMatchObject({ status: "failed", errorMessage: "Model capability must contain supported operations" });
    expect(models.some((model) => model.id === "designer-model" || model.id === "bad-capability")).toBe(false);
    expect(state.adminAudit).toHaveLength(0);
  });

  it("lets admins configure provider runtime settings without exposing secrets", () => {
    const state = createServerState({ userId: "admin@company.local", role: "admin", creditBalance: 30 });

    const configured = configureProviderSettings(
      state,
      {
        provider: "openai",
        mode: "live-ready",
        endpointUrl: "https://api.openai.example/v1/images",
        secretName: "OPENAI_API_KEY",
        secretValue: "sk-admin-secret"
      },
      "admin@company.local"
    ) as ProviderHealth;
    const health = callApi(state, "/api/admin/providers", undefined, undefined, "admin@company.local") as ProviderHealth[];
    const unauthorized = configureProviderSettings(
      state,
      { provider: "runninghub", mode: "live-ready", secretName: "RUNNINGHUB_API_KEY", secretValue: "rh-secret" },
      "designer@company.local"
    ) as ApiError;

    expect(configured).toMatchObject({
      provider: "openai",
      mode: "live-ready",
      secretConfigured: true,
      endpointUrl: "https://api.openai.example/v1/images",
      configuredSecrets: ["OPENAI_API_KEY"]
    });
    expect(health.find((provider) => provider.provider === "openai")).toMatchObject({
      mode: "live-ready",
      secretConfigured: true,
      configuredSecrets: ["OPENAI_API_KEY"],
      missingSecrets: []
    });
    expect(unauthorized).toMatchObject({ status: "failed", errorMessage: "Admin role required" });
    expect(JSON.stringify(configured)).not.toContain("sk-admin-secret");
    expect(JSON.stringify(state.providerSettings)).not.toContain("sk-admin-secret");
  });

  it("writes admin account, pricing, and provider changes into audit without secret values", () => {
    const state = createServerState({ userId: "admin@company.local", role: "admin", creditBalance: 30 });

    adjustAccountCredits(state, { targetUserId: "alice@company.local", delta: 15, reason: "monthly allocation" }, "admin@company.local");
    setAccountCreditLimit(state, { targetUserId: "alice@company.local", creditLimit: 80, reason: "team cap" }, "admin@company.local");
    configureModelPricing(state, { modelId: "gpt-image-2-low", cost: 5, priceCents: 250, currency: "CNY" }, "admin@company.local");
    configureProviderSettings(
      state,
      {
        provider: "openai",
        mode: "live-ready",
        endpointUrl: "https://api.openai.example/v1/images",
        secretName: "OPENAI_API_KEY",
        secretValue: "sk-admin-secret"
      },
      "admin@company.local"
    );
    adjustAccountCredits(state, { targetUserId: "bob@company.local", delta: 5 }, "designer@company.local");

    const audit = callApi(state, "/api/admin/audit", undefined, undefined, "admin@company.local") as AdminAuditEntry[];

    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "credit-adjustment",
          actorUserId: "admin@company.local",
          targetUserId: "alice@company.local",
          creditDelta: 15,
          summary: expect.stringContaining("monthly allocation")
        }),
        expect.objectContaining({
          eventType: "credit-limit",
          targetUserId: "alice@company.local",
          creditLimit: 80
        }),
        expect.objectContaining({
          eventType: "model-pricing",
          modelId: "gpt-image-2-low",
          creditCost: 5
        }),
        expect.objectContaining({
          eventType: "provider-settings",
          provider: "openai",
          summary: expect.stringContaining("OPENAI_API_KEY")
        })
      ])
    );
    expect(audit.filter((entry) => entry.eventType !== "generation")).toHaveLength(4);
    expect(JSON.stringify(audit)).not.toContain("sk-admin-secret");
    expect(JSON.stringify(audit)).not.toContain("bob@company.local");
  });

  it("rejects unauthorized or invalid credit adjustments without dirty side effects", () => {
    const state = createServerState({ creditBalance: 30 });
    const before = callApi(state, "/api/profile", undefined, undefined, "alice@company.local") as Profile;

    const unauthorized = adjustAccountCredits(state, { targetUserId: "alice@company.local", delta: 10 }, "designer@company.local") as ApiError;
    const negative = adjustAccountCredits(state, { targetUserId: "alice@company.local", delta: -31 }, "admin@company.local") as ApiError;
    const after = callApi(state, "/api/profile", undefined, undefined, "alice@company.local") as Profile;

    expect(unauthorized).toMatchObject({ status: "failed", errorMessage: "Admin role required" });
    expect(negative).toMatchObject({ status: "failed", errorMessage: "Credit balance cannot be negative" });
    expect(after.creditBalance).toBe(before.creditBalance);
  });
});
