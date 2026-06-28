import type { GenerationRequest, GenerationResult, ModelDefinition, OperationType } from "../src/domain/workspace";

export type ProviderName = ModelDefinition["provider"];

export interface ProviderHealth {
  provider: ProviderName;
  status: "healthy" | "degraded";
  modelCount: number;
  keyLocation: "server";
  mode: "mock" | "live-ready";
  endpointUrl?: string;
  secretConfigured: boolean;
  adapterId: string;
  requiredSecrets: string[];
  configuredSecrets: string[];
  missingSecrets: string[];
  supportedOperations: OperationType[];
}

export interface ProviderRuntimeSettings {
  mode?: ProviderHealth["mode"];
  endpointUrl?: string;
  configuredSecrets?: string[];
  secretConfigured?: boolean;
  updatedAt?: string;
}

export type ProviderRuntimeSettingsMap = Partial<Record<ProviderName, ProviderRuntimeSettings>>;

export interface ProviderAdapter {
  provider: ProviderName;
  execute(
    request: GenerationRequest,
    model: ModelDefinition,
    historyId: string,
    creditCost: number,
    runtimeSettings?: ProviderRuntimeSettings
  ): GenerationResult;
}

export interface ProviderPayload {
  provider: ProviderName;
  adapterId: string;
  endpointUrl?: string;
  secretNames: string[];
  body: Record<string, unknown>;
}

interface ProviderConfig {
  adapterId: string;
  requiredSecrets: string[];
  supportedOperations: OperationType[];
}

const providerConfigs: Record<ProviderName, ProviderConfig> = {
  openai: {
    adapterId: "openai-image-adapter",
    requiredSecrets: ["OPENAI_API_KEY"],
    supportedOperations: ["generate", "edit"]
  },
  nanobanana: {
    adapterId: "nanobanana-image-adapter",
    requiredSecrets: ["NANOBANANA_API_KEY", "NANO_BANANA_API_KEY"],
    supportedOperations: ["generate", "edit"]
  },
  comfyui: {
    adapterId: "comfyui-workflow-adapter",
    requiredSecrets: ["COMFYUI_API_URL"],
    supportedOperations: ["generate", "edit", "upscale", "removeBackground"]
  },
  runninghub: {
    adapterId: "runninghub-workflow-adapter",
    requiredSecrets: ["RUNNINGHUB_API_KEY"],
    supportedOperations: ["generate", "edit", "upscale", "removeBackground"]
  },
  internal: {
    adapterId: "internal-operations-adapter",
    requiredSecrets: [],
    supportedOperations: ["generate", "edit", "upscale", "removeBackground"]
  }
};

export const providerNames = Object.keys(providerConfigs) as ProviderName[];

function configuredSecrets(provider: ProviderName, settings?: ProviderRuntimeSettings) {
  const envSecrets = providerConfigs[provider].requiredSecrets.filter((name) => Boolean(process.env[name]?.trim()));
  return Array.from(new Set([...(settings?.configuredSecrets ?? []), ...envSecrets]));
}

function missingSecrets(provider: ProviderName, settings?: ProviderRuntimeSettings) {
  const config = providerConfigs[provider];
  if (config.requiredSecrets.length === 0 || configuredSecrets(provider, settings).length > 0 || settings?.secretConfigured) return [];
  return config.requiredSecrets;
}

function dimensionsForRequest(request: GenerationRequest) {
  const size = request.providerSettings?.size;
  const match = typeof size === "string" ? /^(\d{2,5})x(\d{2,5})$/.exec(size.trim()) : undefined;
  if (match) {
    return {
      width: Number(match[1]),
      height: Number(match[2])
    };
  }
  const fallback = request.operation === "upscale" ? 2048 : 1024;
  return { width: fallback, height: fallback };
}

function compactObject(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function imageProviderBody(request: GenerationRequest, model: ModelDefinition) {
  return compactObject({
    model: model.id,
    operation: request.operation,
    prompt: request.prompt,
    n: request.outputCount,
    size: request.providerSettings?.size,
    quality: request.providerSettings?.quality,
    preset: request.providerSettings?.preset,
    references: request.referenceNodeIds,
    mask: request.mask,
    batchSettings: request.batchSettings
  });
}

function workflowProviderBody(request: GenerationRequest, model: ModelDefinition) {
  return {
    workflowId: model.id,
    operation: request.operation,
    inputs: compactObject({
      prompt: request.prompt,
      references: request.referenceNodeIds,
      outputCount: request.outputCount,
      providerSettings: request.providerSettings,
      mask: request.mask,
      batchSettings: request.batchSettings
    })
  };
}

export function buildProviderPayload(request: GenerationRequest, model: ModelDefinition, runtimeSettings?: ProviderRuntimeSettings): ProviderPayload {
  const config = providerConfigs[model.provider];
  const isWorkflowProvider = model.provider === "runninghub" || model.provider === "comfyui";
  return {
    provider: model.provider,
    adapterId: config.adapterId,
    endpointUrl: runtimeSettings?.endpointUrl,
    secretNames: configuredSecrets(model.provider, runtimeSettings),
    body: isWorkflowProvider ? workflowProviderBody(request, model) : imageProviderBody(request, model)
  };
}

function mockExecute(
  request: GenerationRequest,
  model: ModelDefinition,
  historyId: string,
  creditCost: number,
  runtimeSettings?: ProviderRuntimeSettings
): GenerationResult {
  buildProviderPayload(request, model, runtimeSettings);
  const dimensions = dimensionsForRequest(request);
  return {
    status: "succeeded",
    creditCost,
    historyId,
    outputs: Array.from({ length: request.outputCount }, (_, index) => ({
      name: `${model.name} output ${index + 1}.jpg`,
      source: `mock://${model.provider}/${request.operation}/${request.nodeId}/${index + 1}`,
      width: dimensions.width,
      height: dimensions.height
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

export function runProviderModel(
  request: GenerationRequest,
  model: ModelDefinition,
  historyId: string,
  creditCost: number,
  providerSettings: ProviderRuntimeSettingsMap = {}
): GenerationResult {
  const adapter = adapters.get(model.provider);
  if (!adapter) {
    throw new Error(`Provider adapter not configured for ${model.provider}`);
  }
  return adapter.execute(request, model, historyId, creditCost, providerSettings[model.provider]);
}

export function getProviderHealth(models: ModelDefinition[], settings: ProviderRuntimeSettingsMap = {}): ProviderHealth[] {
  const counts = new Map<ProviderName, number>();
  for (const model of models) {
    counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
  }
  for (const provider of Object.keys(settings) as ProviderName[]) {
    if (providerNames.includes(provider) && !counts.has(provider)) {
      counts.set(provider, 0);
    }
  }
  return Array.from(counts.entries()).map(([provider, modelCount]) => {
    const config = providerConfigs[provider];
    const providerSettings = settings[provider];
    const configured = configuredSecrets(provider, providerSettings);
    const missing = missingSecrets(provider, providerSettings);
    const secretConfigured = missing.length === 0 || Boolean(providerSettings?.secretConfigured);
    const mode = providerSettings?.mode === "mock" ? "mock" : secretConfigured ? "live-ready" : "mock";
    const status = missing.length ? "degraded" : "healthy";
    return {
      provider,
      status,
      modelCount,
      keyLocation: "server",
      mode,
      endpointUrl: providerSettings?.endpointUrl,
      secretConfigured,
      adapterId: config.adapterId,
      requiredSecrets: config.requiredSecrets,
      configuredSecrets: configured,
      missingSecrets: missing,
      supportedOperations: config.supportedOperations
    };
  });
}
