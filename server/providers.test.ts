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

    expect(health).toEqual([
      {
        provider: "openai",
        status: "healthy",
        modelCount: 1,
        keyLocation: "server",
        mode: "mock",
        secretConfigured: false
      }
    ]);
    expect(JSON.stringify(health)).not.toContain("OPENAI_API_KEY");
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
