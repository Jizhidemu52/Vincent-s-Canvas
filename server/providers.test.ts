import { afterEach, describe, expect, it, vi } from "vitest";
import { getProviderHealth, runProviderModel } from "./providers";
import type { GenerationRequest, ModelDefinition } from "../src/domain/workspace";

const openAiModel: ModelDefinition = {
  id: "gpt-image-2-low",
  name: "GPT Image 2 Low",
  provider: "openai",
  group: "Trending models",
  capability: ["generate", "edit"],
  cost: 2
};

const nanoBananaModel: ModelDefinition = {
  id: "nanobanana2",
  name: "Nano Banana 2",
  provider: "nanobanana",
  group: "Trending models",
  capability: ["generate", "edit"],
  cost: 11
};

function request(patch: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    projectId: "project-provider",
    nodeId: "node-provider",
    modelId: openAiModel.id,
    prompt: "make a clean fashion product image",
    referenceNodeIds: ["node-provider"],
    outputCount: 2,
    operation: "generate",
    ...patch
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("provider adapters", () => {
  it("reports server-hosted mock mode without exposing secrets", () => {
    const health = getProviderHealth([openAiModel]);

    expect(health[0]).toMatchObject({
      provider: "openai",
      status: "healthy",
      modelCount: 1,
      keyLocation: "server",
      mode: "mock",
      secretConfigured: false,
      adapterId: "openai-image-adapter",
      requiredSecrets: ["OPENAI_API_KEY"],
      configuredSecrets: [],
      missingSecrets: ["OPENAI_API_KEY"],
      supportedOperations: ["generate", "edit"]
    });
    expect(JSON.stringify(health)).not.toContain("apiKey");
  });

  it("switches provider health to live-ready when the server has a key", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-secret");

    const [health] = getProviderHealth([openAiModel]);

    expect(health).toMatchObject({
      provider: "openai",
      mode: "live-ready",
      secretConfigured: true,
      keyLocation: "server"
    });
    expect(JSON.stringify(health)).not.toContain("sk-test-secret");
  });

  it("uses admin provider settings without exposing stored secret values", () => {
    const [health] = getProviderHealth([openAiModel], {
      openai: {
        mode: "live-ready",
        endpointUrl: "https://api.openai.example/v1/images",
        configuredSecrets: ["OPENAI_API_KEY"],
        secretConfigured: true
      }
    });

    expect(health).toMatchObject({
      provider: "openai",
      mode: "live-ready",
      secretConfigured: true,
      endpointUrl: "https://api.openai.example/v1/images",
      configuredSecrets: ["OPENAI_API_KEY"],
      missingSecrets: []
    });
    expect(JSON.stringify(health)).not.toContain("sk-admin-secret");
  });

  it("supports provider secret aliases without requiring every alias to be configured", () => {
    vi.stubEnv("NANO_BANANA_API_KEY", "nano-secret");

    const [health] = getProviderHealth([nanoBananaModel]);

    expect(health).toMatchObject({
      provider: "nanobanana",
      mode: "live-ready",
      secretConfigured: true,
      configuredSecrets: ["NANO_BANANA_API_KEY"],
      missingSecrets: []
    });
    expect(health.requiredSecrets).toEqual(["NANOBANANA_API_KEY", "NANO_BANANA_API_KEY"]);
    expect(JSON.stringify(health)).not.toContain("nano-secret");
  });

  it("runs model requests through the provider adapter result contract", () => {
    const result = runProviderModel(request(), openAiModel, "history-provider", 4);

    expect(result).toMatchObject({
      status: "succeeded",
      creditCost: 4,
      historyId: "history-provider"
    });
    expect(result.outputs).toHaveLength(2);
    expect(result.outputs[0].source).toBe("mock://openai/generate/node-provider/1");
  });
});
