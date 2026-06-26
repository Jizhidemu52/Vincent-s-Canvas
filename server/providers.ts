import type { GenerationRequest, GenerationResult, ModelDefinition } from "../src/domain/workspace";

export type ProviderName = ModelDefinition["provider"];

export interface ProviderHealth {
  provider: ProviderName;
  status: "healthy" | "degraded";
  modelCount: number;
  keyLocation: "server";
  mode: "mock" | "live-ready";
  secretConfigured: boolean;
}

export interface ProviderAdapter {
  provider: ProviderName;
  execute(request: GenerationRequest, model: ModelDefinition, historyId: string, creditCost: number): GenerationResult;
}

const providerSecretNames: Record<ProviderName, string[]> = {
  openai: ["OPENAI_API_KEY"],
  nanobanana: ["NANOBANANA_API_KEY", "NANO_BANANA_API_KEY"],
  comfyui: ["COMFYUI_API_URL", "COMFYUI_API_KEY"],
  runninghub: ["RUNNINGHUB_API_KEY"],
  internal: []
};

function hasServerSecret(provider: ProviderName) {
  const names = providerSecretNames[provider];
  return names.length === 0 || names.some((name) => Boolean(process.env[name]?.trim()));
}

function sizeForOperation(operation: GenerationRequest["operation"]) {
  return operation === "upscale" ? 2048 : 1024;
}

function mockExecute(request: GenerationRequest, model: ModelDefinition, historyId: string, creditCost: number): GenerationResult {
  const size = sizeForOperation(request.operation);
  return {
    status: "succeeded",
    creditCost,
    historyId,
    outputs: Array.from({ length: request.outputCount }, (_, index) => ({
      name: `${model.name} output ${index + 1}.jpg`,
      source: `mock://${model.provider}/${request.operation}/${request.nodeId}/${index + 1}`,
      width: size,
      height: size
    }))
  };
}

function createAdapter(provider: ProviderName): ProviderAdapter {
  return {
    provider,
    execute: mockExecute
  };
}

const adapters = new Map<ProviderName, ProviderAdapter>([
  ["openai", createAdapter("openai")],
  ["nanobanana", createAdapter("nanobanana")],
  ["comfyui", createAdapter("comfyui")],
  ["runninghub", createAdapter("runninghub")],
  ["internal", createAdapter("internal")]
]);

export function runProviderModel(request: GenerationRequest, model: ModelDefinition, historyId: string, creditCost: number): GenerationResult {
  const adapter = adapters.get(model.provider);
  if (!adapter) {
    throw new Error(`Provider adapter not configured for ${model.provider}`);
  }
  return adapter.execute(request, model, historyId, creditCost);
}

export function getProviderHealth(models: ModelDefinition[]): ProviderHealth[] {
  const counts = new Map<ProviderName, number>();
  for (const model of models) {
    counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([provider, modelCount]) => {
    const secretConfigured = hasServerSecret(provider);
    return {
      provider,
      status: "healthy",
      modelCount,
      keyLocation: "server",
      mode: secretConfigured ? "live-ready" : "mock",
      secretConfigured
    };
  });
}
