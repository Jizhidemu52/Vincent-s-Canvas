import { describe, expect, it } from "vitest";
import { callApi, createServerState, type ApiError } from "./api";
import type { GenerationRequest, GenerationResult } from "../src/domain/workspace";
import type { AdminUsageSummary, ProviderHealth } from "./api";

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
      creditCost: 4
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

  it("rejects duplicate submissions without double charging", () => {
    const state = createServerState({ creditBalance: 30 });

    callApi(state, "/api/generations", request(), "same-request");
    const duplicate = callApi(state, "/api/generations", request(), "same-request") as ApiError;

    expect(duplicate.errorMessage).toBe("Duplicate request");
    expect(state.profile.creditBalance).toBe(26);
    expect(state.history).toHaveLength(1);
  });

  it("reports admin usage, audit, and provider health without exposing secrets", () => {
    const state = createServerState({ creditBalance: 30 });
    callApi(state, "/api/generations", request({ outputCount: 1 }), "usage-1");
    callApi(state, "/api/upscale", request({ modelId: "upscale-pro", prompt: "", operation: "upscale", outputCount: 1 }), "usage-2");

    const usage = callApi(state, "/api/admin/usage") as AdminUsageSummary;
    const audit = callApi(state, "/api/admin/audit") as ReturnType<typeof createServerState>["history"];
    const providers = callApi(state, "/api/admin/providers") as ProviderHealth[];

    expect(usage.totalCreditsUsed).toBeGreaterThan(0);
    expect(usage.modelUsage.some((item) => item.modelId === "gpt-image-2-low")).toBe(true);
    expect(audit).toHaveLength(2);
    expect(providers.every((provider) => provider.keyLocation === "server")).toBe(true);
    expect(providers.some((provider) => provider.provider === "openai" && provider.status === "healthy")).toBe(true);
  });
});
