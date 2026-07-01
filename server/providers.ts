import type { GenerationRequest, GenerationResult, ModelDefinition, OperationType, ProviderProgress } from "../src/domain/workspace";

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

export interface ProviderFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ProviderFetchResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

export interface LiveProviderExecutionOptions {
  fetchJson: (url: string, init: ProviderFetchInit) => Promise<ProviderFetchResponse>;
  resolveSecret: (name: string) => string | undefined;
  maxPollAttempts?: number;
  pollDelay?: () => Promise<void>;
  onProgress?: (progress: ProviderProgress) => void;
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
  recraft: {
    adapterId: "recraft-image-adapter",
    requiredSecrets: ["RECRAFT_API_KEY"],
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
  const settings = request.providerSettings;
  if (model.provider === "runninghub" && (settings?.webappId || settings?.nodeInfoList?.length)) {
    return compactObject({
      webappId: settings.webappId ?? model.id,
      nodeInfoList: settings.nodeInfoList ?? [],
      taskType: settings.taskType ?? "ASYNC",
      instanceType: settings.instanceType,
      inputs: compactObject({
        prompt: request.prompt,
        references: request.referenceNodeIds,
        outputCount: request.outputCount,
        providerSettings: request.providerSettings,
        mask: request.mask,
        batchSettings: request.batchSettings
      })
    });
  }
  if (model.provider === "comfyui" && settings?.workflow) {
    return compactObject({
      workflow: settings.workflow,
      addMetadata: settings.addMetadata ?? true,
      instanceType: settings.instanceType,
      inputs: compactObject({
        prompt: request.prompt,
        references: request.referenceNodeIds,
        outputCount: request.outputCount,
        providerSettings: request.providerSettings,
        mask: request.mask,
        batchSettings: request.batchSettings
      })
    });
  }
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

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringLikeValue(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordItems(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value.map(objectValue).filter((item) => Object.keys(item).length > 0);
}

function nestedOutputItems(value: unknown): Array<Record<string, unknown>> | undefined {
  const directItems = recordItems(value);
  if (directItems) return directItems;
  const object = objectValue(value);
  if (!Object.keys(object).length) return undefined;
  const candidates = [object.outputs, object.data, object.images, object.result, object.assets];
  for (const candidate of candidates) {
    const nestedItems = nestedOutputItems(candidate);
    if (nestedItems) return nestedItems;
  }
  return undefined;
}

function outputItems(body: unknown) {
  const object = objectValue(body);
  const candidates = [object.outputs, object.data, object.images, object.result, object.assets];
  for (const candidate of candidates) {
    const items = nestedOutputItems(candidate);
    if (items) return items;
  }
  return [];
}

function mimeExtension(mimeType: string) {
  const subtype = /^image\/([a-z0-9.+-]+)$/i.exec(mimeType)?.[1];
  if (!subtype) return undefined;
  if (subtype === "jpeg" || subtype === "pjpeg") return "jpg";
  if (subtype === "svg+xml") return "svg";
  return subtype;
}

function outputName(model: ModelDefinition, index: number, source: string, item: Record<string, unknown>) {
  const explicitName = stringValue(item.name ?? item.filename ?? item.fileName);
  if (explicitName) return explicitName;
  const dataMime = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(source)?.[1];
  const dataExtension = dataMime ? mimeExtension(dataMime) : undefined;
  if (dataExtension) return `${model.name} output ${index + 1}.${dataExtension}`;
  const extensionMatch = /(\.[a-z0-9]+)(?:[?#].*)?$/i.exec(source);
  return `${model.name} output ${index + 1}${extensionMatch?.[1] ?? ".jpg"}`;
}

function base64OutputSource(item: Record<string, unknown>) {
  const base64 = stringValue(item.b64_json ?? item.base64 ?? item.base64Data);
  if (!base64) return undefined;
  const mime = stringValue(item.mimeType ?? item.mime_type ?? item.contentType ?? item.content_type) ?? "image/png";
  return `data:${mime};base64,${base64}`;
}

function outputSource(item: Record<string, unknown>) {
  return (
    stringValue(
      item.source ??
        item.url ??
        item.imageUrl ??
        item.image_url ??
        item.outputUrl ??
        item.output_url ??
        item.fileUrl ??
        item.file_url ??
        item.downloadUrl ??
        item.download_url ??
        item.assetUrl ??
        item.asset_url ??
        item.uri ??
        item.image
    ) ?? base64OutputSource(item)
  );
}

function outputItemFailed(item: Record<string, unknown>) {
  const status = providerStatus(item);
  return status === "failed" || status === "error";
}

function normalizeProviderOutputs(body: unknown, request: GenerationRequest, model: ModelDefinition) {
  const dimensions = dimensionsForRequest(request);
  return outputItems(body)
    .filter((item) => !outputItemFailed(item))
    .map((item, index) => {
      const source = outputSource(item) ?? `provider://${model.provider}/${request.nodeId}/${index + 1}`;
      return {
        name: outputName(model, index, source, item),
        source,
        width: numberValue(item.width) ?? dimensions.width,
        height: numberValue(item.height) ?? dimensions.height
      };
    });
}

function providerStatus(body: unknown) {
  const object = objectValue(body);
  const code = numberValue(object.code);
  if (code === 0) {
    return providerJobId(body) && !outputItems(body).length ? "running" : "succeeded";
  }
  if (code === 804) return "running";
  if (code === 813) return "queued";
  if (code === 805) return "failed";
  return stringValue(object.status ?? object.state)?.toLowerCase();
}

function providerStatusUrl(body: unknown) {
  const object = objectValue(body);
  return stringValue(object.statusUrl ?? object.pollUrl ?? object.pollingUrl);
}

function messageWithCode(message: string | undefined, code: string | undefined) {
  if (!message) return undefined;
  return code ? `${message} (${code})` : message;
}

function providerErrorMessage(body: unknown) {
  const object = objectValue(body);
  const nestedError = objectValue(object.error);
  const detail = objectValue(object.detail);
  const firstArrayError = Array.isArray(object.errors) ? objectValue(object.errors[0]) : {};
  return (
    messageWithCode(stringValue(object.errorMessage), stringLikeValue(object.code)) ??
    messageWithCode(stringValue(object.failedReason), stringLikeValue(object.code)) ??
    messageWithCode(stringValue(object.msg), stringLikeValue(object.code)) ??
    messageWithCode(stringValue(object.message), stringLikeValue(object.code)) ??
    messageWithCode(stringValue(nestedError.message), stringLikeValue(nestedError.code)) ??
    messageWithCode(stringValue(detail.message), stringLikeValue(detail.code)) ??
    messageWithCode(stringValue(firstArrayError.message), stringLikeValue(firstArrayError.code))
  );
}

function providerOutputItemErrorMessage(body: unknown) {
  for (const item of outputItems(body)) {
    if (outputItemFailed(item)) {
      const message = providerErrorMessage(item);
      if (message) return message;
    }
  }
  return undefined;
}

function providerJobId(body: unknown) {
  const object = objectValue(body);
  const data = objectValue(object.data);
  return stringValue(object.providerJobId ?? object.jobId ?? object.id ?? object.taskId ?? data.taskId);
}

function mergeProgress(body: unknown, current: ProviderProgress): ProviderProgress {
  return {
    ...current,
    providerJobId: providerJobId(body) ?? current.providerJobId,
    status: providerStatus(body) ?? current.status,
    statusUrl: providerStatusUrl(body) ?? current.statusUrl
  };
}

function publishProgress(options: LiveProviderExecutionOptions, progress: ProviderProgress) {
  options.onProgress?.({ ...progress });
}

function assertProviderResponse(response: ProviderFetchResponse) {
  if (!response.ok) {
    const message = providerErrorMessage(response.body);
    throw new Error(message ?? `Provider request failed with ${response.status}`);
  }
  return response.body;
}

function resolvePayloadSecret(payload: ProviderPayload, options: LiveProviderExecutionOptions) {
  for (const name of payload.secretNames) {
    const secret = options.resolveSecret(name);
    if (secret?.trim()) return secret.trim();
  }
  if (payload.secretNames.length) {
    throw new Error(`Provider secret ${payload.secretNames[0]} is not configured`);
  }
  return undefined;
}

function isRunningHubAiAppPayload(payload: ProviderPayload) {
  const body = objectValue(payload.body);
  return payload.provider === "runninghub" && Boolean(stringValue(body.webappId));
}

function runningHubOutputsUrl(endpointUrl?: string) {
  if (!endpointUrl) return undefined;
  try {
    const url = new URL(endpointUrl);
    url.pathname = "/task/openapi/outputs";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function providerPollUrl(body: unknown, payload: ProviderPayload) {
  return providerStatusUrl(body) ?? (isRunningHubAiAppPayload(payload) && providerJobId(body) ? runningHubOutputsUrl(payload.endpointUrl) : undefined);
}

function submitBodyForPayload(payload: ProviderPayload, secret?: string) {
  return isRunningHubAiAppPayload(payload) && secret ? { ...payload.body, apiKey: secret } : payload.body;
}

function headersForPayload(payload: ProviderPayload, secret?: string) {
  return compactObject({
    "Content-Type": "application/json",
    Authorization: secret && !isRunningHubAiAppPayload(payload) ? `Bearer ${secret}` : undefined
  }) as Record<string, string>;
}

function pollInitForPayload(payload: ProviderPayload, body: unknown, headers: Record<string, string>, secret?: string): ProviderFetchInit {
  if (isRunningHubAiAppPayload(payload)) {
    return {
      method: "POST",
      headers,
      body: JSON.stringify(compactObject({ apiKey: secret, taskId: providerJobId(body) }))
    };
  }
  return {
    method: "GET",
    headers
  };
}

export async function executeLiveProviderPayload(
  payload: ProviderPayload,
  request: GenerationRequest,
  model: ModelDefinition,
  historyId: string,
  creditCost: number,
  options: LiveProviderExecutionOptions
): Promise<GenerationResult> {
  if (!payload.endpointUrl) {
    throw new Error(`Provider endpoint is not configured for ${payload.provider}`);
  }
  const secret = resolvePayloadSecret(payload, options);
  const headers = headersForPayload(payload, secret);
  let progress: ProviderProgress = { status: "submitting", pollAttempts: 0 };
  let body = assertProviderResponse(
    await options.fetchJson(payload.endpointUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(submitBodyForPayload(payload, secret))
    })
  );
  progress = mergeProgress(body, { ...progress, status: providerStatus(body) ?? "submitted" });
  progress = { ...progress, statusUrl: providerPollUrl(body, payload) ?? progress.statusUrl };
  publishProgress(options, progress);
  const maxPollAttempts = options.maxPollAttempts ?? 5;
  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    const outputs = normalizeProviderOutputs(body, request, model);
    const status = providerStatus(body);
    if (outputs.length || status === "succeeded" || status === "complete" || status === "completed") {
      const itemErrorMessage = providerOutputItemErrorMessage(body);
      progress = mergeProgress(body, { ...progress, status: "succeeded", errorMessage: itemErrorMessage ?? progress.errorMessage });
      publishProgress(options, progress);
      return {
        status: "succeeded",
        creditCost,
        historyId,
        outputs,
        providerProgress: progress
      };
    }
    if (status === "failed" || status === "error") {
      const errorMessage = providerErrorMessage(body) ?? providerOutputItemErrorMessage(body);
      progress = mergeProgress(body, { ...progress, status: "failed", errorMessage });
      publishProgress(options, progress);
      throw new Error(errorMessage ?? "Provider execution failed");
    }
    const statusUrl = providerPollUrl(body, payload);
    if (!statusUrl) break;
    if (options.pollDelay) await options.pollDelay();
    progress = { ...progress, pollAttempts: progress.pollAttempts + 1, statusUrl };
    body = assertProviderResponse(await options.fetchJson(statusUrl, pollInitForPayload(payload, body, headers, secret)));
    progress = mergeProgress(body, progress);
    progress = { ...progress, statusUrl: providerPollUrl(body, payload) ?? progress.statusUrl };
    publishProgress(options, progress);
  }
  progress = { ...progress, status: "timed_out", errorMessage: `Provider ${payload.provider} did not return outputs` };
  publishProgress(options, progress);
  throw new Error(`Provider ${payload.provider} did not return outputs`);
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
  ["recraft", createAdapter("recraft")],
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
