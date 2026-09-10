import { authenticateDemoAccount, demoAccounts } from "./demo-accounts";
import { assetMetadataSchema } from "./asset-metadata";
import { imageParameterProfile } from "./image-parameter-profile";
import { openAiImageParameters } from "./openai-image-parameters";
import { deploymentFeatures } from "./deployment-features";
import { billedDemoCredits, resolveStandaloneDemoUser } from "./demo-standalone-mode";
import { resolveStandaloneStaticPath } from "./demo-standalone-web";
import { apiMartImageModel, buildApiMartImageRequest, runApiMartImageTask } from "./apimart-image";
import { listAvailableDemoModels, resolveDemoExternalProviders, videoModelConfigIds } from "./demo-provider-configuration";
import { applyDemoProviderCredentials } from "./demo-provider-credentials";
import { DEMO_STREAM_IDLE_TIMEOUT_SECONDS } from "./demo-server-config";
import { resolveDemoHost } from "./demo-network-config";
import { isOpenTokenImageModel, runOpenTokenImage, type OpenTokenImageModel } from "./opentoken-image";
import { ANTHROPIC_MESSAGES_VERSION, buildClaudeMessagesRequest, buildGeminiRequestBody, readClaudeResponse, readGeminiResponse, requestChatCompletion, requestClaudeStream } from "./routes/chat";
import { normalizeDemoPublicAssetOrigin } from "./demo-public-assets";
import { createDemoProviderVideoSources, resolveOwnedDemoVideoSources } from "./demo-video-sources";
import { decodeInlineImageResult } from "./demo-task-result-assets";
import { syncDemoProject } from "./demo-projects";
import { createDemoBatchTaskInputs } from "./demo-batch-tasks";
import { buildVideoProviderRequest, getVideoModelCapability, isSupportedVideoModelId, supportedVideoModelIds, type ProviderVideoSource, type SupportedVideoModelId, type VideoProviderParameters, videoTaskStatusPath } from "./video-models";
import { isPublicHttpsUrl } from "./apimart-upload";
import { preflightVideoSources, prepareVideoProviderSources } from "./video-source-preparation";
import { probeMediaBytes, type MediaMetadata } from "./media-probe";
import { readDemoRecovery } from "./demo-state-recovery";

const sessions = new Map<string, string>();
const modules = [
  "detail-enhance",
  "image-edit",
  "angle-control",
  "seamless-stitch",
  "image",
  "video",
  "prompts",
  "assets",
  "gpt-chat",
  "canvas",
  "team",
  "performance",
];
const toolDefinitions = [
  {
    toolKey: "detail-enhance",
    label: "细节增强",
    operationType: "upscale",
    capabilities: ["upscale", "edit"],
  },
  {
    toolKey: "image-edit",
    label: "图片编辑",
    operationType: "inpaint",
    capabilities: ["edit"],
  },
  {
    toolKey: "angle-control",
    label: "角度控制",
    operationType: "inpaint",
    capabilities: ["edit"],
  },
  {
    toolKey: "seamless-stitch",
    label: "无缝拼接",
    operationType: "seamless_stitch",
    capabilities: ["edit"],
  },
  {
    toolKey: "image",
    label: "文生图",
    operationType: "image_generation",
    capabilities: ["generate"],
  },
  {
    toolKey: "video",
    label: "视频创作",
    operationType: "video_generation",
    capabilities: ["video"],
  },
] as const;
const apiMartBaseUrl = (
  process.env.APIMART_BASE_URL || process.env.GPT_IMAGE_2_BASE_URL || "https://api.apimart.ai/v1"
).replace(/\/$/, "");
const demoPublicAssetOrigin = normalizeDemoPublicAssetOrigin(process.env.DEMO_PUBLIC_ASSET_ORIGIN);
let apiMartApiKey = process.env.APIMART_API_KEY?.trim() || process.env.GPT_IMAGE_2_API_KEY?.trim() || "";
const gptImage2ProviderId = "30000000-0000-4000-8000-000000000002";
const openTokenProviderId = "30000000-0000-4000-8000-000000000005";
const openTokenBaseUrl = (process.env.OPENTOKEN_BASE_URL || "https://cn2.gw.opentoken.io/v1").replace(/\/$/, "");
let openTokenApiKey = process.env.OPENTOKEN_API_KEY?.trim() || "";
const demoProviderApiKeys = new Map<string, string>();
const externalProviders = resolveDemoExternalProviders({ openTokenApiKey, apiMartApiKey });
const { hasOpenToken, hasApiMart, openTokenGptImage2ModelId, openTokenGptImage2ApiModelId, openTokenGptImage2DisplayName, openTokenGptImage25Models, openTokenGptChatModel, openTokenClaudeModel, officialNanoBanana2ModelId, openTokenGeminiDisplayName, officialNanoBanana2Capabilities, apiMartGptImage2ModelId, apiMartGptImage2PublicModelId, claudeModelIds } = externalProviders;
const gptImage2ModelId = apiMartGptImage2ModelId;
const geminiProviderId = "30000000-0000-4000-8000-000000000003";
const claudeProviderId = "30000000-0000-4000-8000-000000000006";
const openTokenClaudeProviderId = "30000000-0000-4000-8000-000000000007";
function demoChatProviderApiKey(providerId: string) {
  if ([openTokenProviderId, openTokenClaudeProviderId].includes(providerId)) return openTokenApiKey;
  return demoProviderApiKeys.get(providerId)
    || ([gptImage2ProviderId, geminiProviderId, claudeProviderId].includes(providerId) ? apiMartApiKey : "");
}
const geminiModelId = "40000000-0000-4000-8000-000000000101";
const geminiFlashImageModelId = "40000000-0000-4000-8000-000000000102";
const midjourneyModelId = "40000000-0000-4000-8000-000000000103";
const midjourneyBlendModelId = "40000000-0000-4000-8000-000000000104";
const demoProviders: Array<Record<string, unknown>> = [
  {
    id: "30000000-0000-4000-8000-000000000001",
    name: "本地模拟 API",
    protocol: "custom",
    baseUrl: "http://127.0.0.1:3100/mock-provider",
    enabled: true,
    hasCredentials: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];
const demoModels: Array<Record<string, unknown>> = toolDefinitions.map(
  (tool, index) => ({
    id: `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    providerId: demoProviders[0]!.id,
    providerName: demoProviders[0]!.name,
    workflowConfigId: null,
    workflowName: null,
    replacementModelConfigId: null,
    name: `${tool.label}模拟模型`,
    modelId: `demo-${tool.toolKey}`,
    capabilities: tool.capabilities,
    creditCost:
      tool.toolKey === "seamless-stitch" ? 0 : tool.toolKey === "video" ? 4 : 2,
    rmbCost:
      tool.toolKey === "seamless-stitch"
        ? 0
        : tool.toolKey === "video"
          ? 0.4
          : 0.2,
    concurrencyLimit: 5,
    enabled: tool.toolKey !== "video",
  }),
);
{
  demoProviders.push({
    id: openTokenProviderId,
    name: "OpenToken",
    protocol: "openai",
    baseUrl: openTokenBaseUrl,
    enabled: true,
    hasCredentials: Boolean(openTokenApiKey),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  demoModels.push({
    id: openTokenGptImage2ModelId,
    providerId: openTokenProviderId,
    providerName: "OpenToken",
    workflowConfigId: null,
    workflowName: null,
    replacementModelConfigId: null,
    name: openTokenGptImage2DisplayName,
    modelId: openTokenGptImage2ApiModelId,
    capabilities: ["generate", "edit"],
    creditCost: 4,
    rmbCost: 0,
    concurrencyLimit: 2,
    enabled: true,
  });
  for (const model of openTokenGptImage25Models) {
    demoModels.push({
      ...model,
      providerId: openTokenProviderId,
      providerName: "OpenToken",
      workflowConfigId: null,
      workflowName: null,
      replacementModelConfigId: null,
      capabilities: ["generate", "edit"],
      creditCost: 4,
      rmbCost: 0,
      concurrencyLimit: 2,
      enabled: true,
    });
  }
  demoProviders.push({
    id: openTokenClaudeProviderId,
    name: "OpenToken Claude",
    protocol: "anthropic",
    baseUrl: openTokenBaseUrl,
    enabled: true,
    hasCredentials: Boolean(openTokenApiKey),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  for (const [model, providerId, providerName] of [
    [openTokenGptChatModel, openTokenProviderId, "OpenToken"],
    [openTokenClaudeModel, openTokenClaudeProviderId, "OpenToken Claude"],
  ] as const) {
    demoModels.push({
      ...model,
      providerId,
      providerName,
      workflowConfigId: null,
      workflowName: null,
      replacementModelConfigId: null,
      capabilities: ["chat", "vision", "tools"],
      creditCost: 0,
      rmbCost: 0,
      concurrencyLimit: 2,
      enabled: true,
    });
  }
  demoModels.push({
    id: officialNanoBanana2ModelId,
    providerId: openTokenProviderId,
    providerName: "OpenToken",
    workflowConfigId: null,
    workflowName: null,
    replacementModelConfigId: null,
    name: openTokenGeminiDisplayName,
    modelId: "gemini-3.1-flash-image",
    capabilities: officialNanoBanana2Capabilities,
    creditCost: 4,
    rmbCost: 0,
    concurrencyLimit: 2,
    enabled: true,
  });
  demoProviders.push({
    id: claudeProviderId,
    name: "Anthropic Claude",
    protocol: "anthropic",
    baseUrl: apiMartBaseUrl.replace(/\/v1$/, ""),
    enabled: true,
    hasCredentials: Boolean(apiMartApiKey),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  for (const [index, modelId] of claudeModelIds.entries()) {
    demoModels.push({
      id: `40000000-0000-4000-8000-00000000012${index + 1}`,
      providerId: claudeProviderId,
      providerName: "Anthropic Claude",
      workflowConfigId: null,
      workflowName: null,
      replacementModelConfigId: null,
      name: modelId,
      modelId,
      capabilities: ["chat", "vision", "tools"],
      creditCost: 0,
      rmbCost: 0,
      concurrencyLimit: 2,
      enabled: true,
    });
  }
}
{
  demoProviders.push({
    id: gptImage2ProviderId,
    name: "APIMart 图片服务",
    protocol: "apimart",
    baseUrl: apiMartBaseUrl,
    enabled: true,
    hasCredentials: Boolean(apiMartApiKey),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  demoModels.push({
    id: gptImage2ModelId,
    providerId: gptImage2ProviderId,
    providerName: "GPT-Image-2",
    workflowConfigId: "demo-gpt-image-2",
    workflowName: "GPT-Image-2 async",
    replacementModelConfigId: null,
    name: "vcen gpt2",
    modelId: apiMartGptImage2PublicModelId,
    capabilities: ["generate", "edit", "upscale"],
    creditCost: 4,
    rmbCost: 0,
    concurrencyLimit: 2,
    enabled: true,
  });
  demoModels.push({
    id: geminiFlashImageModelId,
    providerId: gptImage2ProviderId,
    providerName: "APIMart 图片服务",
    workflowConfigId: null,
    workflowName: null,
    replacementModelConfigId: null,
    name: "Gemini 3.1 Flash 图片",
    modelId: "gemini-3.1-flash-image-preview",
    capabilities: ["generate", "edit"],
    creditCost: 4,
    rmbCost: 0,
    concurrencyLimit: 2,
    enabled: true,
  });
  demoModels.push({
    id: midjourneyModelId,
    providerId: gptImage2ProviderId,
    providerName: "APIMart 图片服务",
    workflowConfigId: null,
    workflowName: null,
    replacementModelConfigId: null,
    name: "Midjourney",
    modelId: "midjourney",
    capabilities: ["generate"],
    creditCost: 4,
    rmbCost: 0,
    concurrencyLimit: 2,
    enabled: true,
  });
  demoModels.push({
    id: midjourneyBlendModelId,
    providerId: gptImage2ProviderId,
    providerName: "APIMart image service",
    workflowConfigId: null,
    workflowName: null,
    replacementModelConfigId: null,
    name: "Midjourney Blend",
    modelId: "midjourney-blend",
    capabilities: ["generate"],
    creditCost: 4,
    rmbCost: 0,
    concurrencyLimit: 2,
    enabled: true,
  });
  demoProviders.push({
    id: geminiProviderId,
    name: "APIMart Gemini",
    protocol: "gemini",
    baseUrl: apiMartBaseUrl.replace(/\/v1$/, ""),
    enabled: true,
    hasCredentials: Boolean(apiMartApiKey),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  demoModels.push({
    id: geminiModelId,
    providerId: geminiProviderId,
    providerName: "APIMart Gemini",
    workflowConfigId: null,
    workflowName: null,
    replacementModelConfigId: null,
    name: "Gemini 3.1 Pro",
    modelId: "gemini-3.1-pro-preview",
    capabilities: ["chat"],
    creditCost: 0,
    rmbCost: 0,
    concurrencyLimit: 2,
    enabled: true,
  });
}
if (!demoProviders.some((provider) => provider.id === gptImage2ProviderId)) {
  demoProviders.push({
    id: gptImage2ProviderId,
    name: "APIMart",
    protocol: "apimart",
    baseUrl: apiMartBaseUrl,
    enabled: true,
    hasCredentials: Boolean(apiMartApiKey),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}
for (const modelId of supportedVideoModelIds) {
  demoModels.push({
    id: videoModelConfigIds[modelId],
    providerId: gptImage2ProviderId,
    providerName: "APIMart",
    workflowConfigId: modelId,
    workflowName: `${modelId} async`,
    replacementModelConfigId: null,
    name: modelId,
    modelId,
    capabilities: ["video"],
    creditCost: 0,
    rmbCost: 0,
    concurrencyLimit: 2,
    enabled: true,
  });
}
const demoPrices: Array<Record<string, unknown>> = Array.from(
  new Map(toolDefinitions.map((tool) => [tool.operationType, tool])).values(),
).map((tool, index) => ({
  id: `50000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  operationType: tool.operationType,
  label: tool.label,
  credits: tool.toolKey === "video" ? 6 : 2,
  rmbCost: tool.toolKey === "video" ? 0.6 : 0.2,
  version: 1,
  status: "published",
  publishedAt: new Date().toISOString(),
}));
const demoToolConfigurations = toolDefinitions.map((tool, index) => ({
  toolKey: tool.toolKey,
  modelConfigId:
    tool.toolKey === "video" && apiMartApiKey
      ? videoModelConfigIds["happyhorse-1.1"]
      : ["image", "image-edit", "angle-control"].includes(tool.toolKey) && hasOpenToken
        ? openTokenGptImage2ModelId
        : tool.toolKey === "image" && hasApiMart
        ? gptImage2ModelId
        : demoModels[index]!.id as string,
  enabled: true,
}));
type DemoAsset = {
  /** Set only from a provider result by this server, never from upload metadata. */
  upstreamUrl?: string;
  byteSize?: number;
  id: string;
  ownerUserId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  createdAt: string;
  clientReferenceId?: string;
  projectId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
};
type DemoTask = {
  prompt?: string;
  parameters?: Record<string, unknown>;
  sourceUrls?: string[];
  projectId?: string;
  modelConfigId?: string;
  id: string;
  requestId: string;
  ownerUserId: string;
  operationType: string;
  status: "processing" | "success" | "failed" | "paused";
  submissionStartedAt?: string;
  stage?: "preflight" | "submitted" | "polling" | "downloading" | "succeeded" | "failed";
  errorCode?: string | null;
  upstreamTaskId?: string | null;
  providerModel?: SupportedVideoModelId;
  updatedAt?: string;
  resultUrls: string[];
  failureReason: string | null;
  credits: number;
  createdAt: string;
};
type DemoInternalAiConfig = {
  seamlessUrl: string;
  appKey: string | null;
  updatedAt: string | null;
};
const demoAssets = new Map<string, DemoAsset>();
const features = deploymentFeatures({
  AUTH_ENABLED: process.env.LOCAL_STANDALONE === "true" || process.env.AUTH_ENABLED === "false" ? "false" : "true",
  CREDITS_ENABLED: process.env.CREDITS_ENABLED === "false" ? "false" : "true",
  ROLE_PORTALS_ENABLED: process.env.LOCAL_STANDALONE === "true" || process.env.ROLE_PORTALS_ENABLED === "false" ? "false" : "true",
});
const standaloneDemoUser = resolveStandaloneDemoUser(!features.authenticationEnabled);
const standaloneMode = Boolean(standaloneDemoUser);
const standaloneWebDirectory = process.env.STANDALONE_WEB_DIR?.trim() || "";
const demoPublicVideoAssetAccess = new Map<string, { assetId: string; expiresAt: number }>();
const demoTasks = new Map<string, DemoTask>();
if (process.env.DEMO_RECOVERY_FILE) {
  const recovered = readDemoRecovery(await Bun.file(process.env.DEMO_RECOVERY_FILE).json());
  for (const value of recovered.assets) { const asset = value as DemoAsset; demoAssets.set(asset.id, asset); }
  for (const value of recovered.tasks) { const task = value as DemoTask; demoTasks.set(task.id, task); }
  console.info(`Recovered ${demoAssets.size} local assets and ${demoTasks.size} tasks.`);
}
const internalAiConfig: DemoInternalAiConfig = {
  seamlessUrl: "",
  appKey: null,
  updatedAt: null,
};
const now = () => new Date().toISOString();
const headers = { "content-type": "application/json; charset=utf-8" };
const json = (
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, ...extra },
  });
const empty = (status = 204, extra: Record<string, string> = {}) =>
  new Response(null, { status, headers: extra });

function sessionUser(request: Request) {
  const token = request.headers
    .get("cookie")
    ?.match(/(?:^|; )wireless_canvas_demo_session=([^;]+)/)?.[1];
  const accountId = token ? sessions.get(token) : null;
  return accountId
    ? demoAccounts.find((account) => account.id === accountId)?.user || null
    : standaloneDemoUser;
}

function publicAccounts() {
  return demoAccounts.map(({ identifier, password, label, portal }) => ({
    identifier,
    password,
    label,
    portal,
  }));
}

type DemoResponseContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
type DemoResponseInput =
  | { role: "system" | "user" | "assistant"; content: string | DemoResponseContent[] }
  | { type: "claude_assistant"; content: Array<Record<string, unknown>> }
  | { type: "function_call"; call_id: string; name: string; arguments: string; thoughtSignature?: string }
  | { type: "function_call_output"; call_id: string; output: string };

function toGeminiDemoContents(input: DemoResponseInput[]) {
  return input
    .filter((item): item is Extract<DemoResponseInput, { role: string }> => "role" in item)
    .map((item) => ({
      role: item.role === "assistant" ? "model" : "user",
      parts: typeof item.content === "string"
        ? [{ text: item.content }]
        : item.content.map((part) => {
            if (part.type === "input_text") return { text: part.text };
            const dataUrl = /^data:([^;,]+);base64,([a-z0-9+/=]+)$/i.exec(part.image_url);
            if (!dataUrl) throw new Error("Gemini 原生对话仅支持 data URL 图片");
            return { inlineData: { mimeType: dataUrl[1], data: dataUrl[2] } };
          }),
    }));
}

type DemoGeminiPayload = { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thoughtSignature?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }> } }> };
type DemoResponseTool = { type: "function"; name: string; description?: string; parameters: Record<string, unknown>; strict?: boolean };

async function callDemoGemini(input: { input: DemoResponseInput[]; tools: DemoResponseTool[]; toolChoice?: unknown; webSearch?: boolean; gemini?: { maxOutputTokens: number } }) {
  const endpoint = `${apiMartBaseUrl.replace(/\/v1$/, "")}/v1beta/models/gemini-3.1-pro-preview:generateContent`;
  const body = buildGeminiRequestBody(input);
  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${apiMartApiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!upstream.ok) throw new Error(`Gemini Provider ${upstream.status}: ${(await upstream.text()).slice(0, 500)}`);
  // A disconnected paid POST may already have been accepted; never resubmit it automatically.
  return readGeminiResponse(await upstream.json() as DemoGeminiPayload);
}

const demoPort = Number(process.env.DEMO_PORT || 3100);
const demoHost = resolveDemoHost();

const demoSourceProbes = new WeakMap<Uint8Array, MediaMetadata>();
async function createProviderVideoSources(_model: SupportedVideoModelId, sources: DemoAsset[]) {
  const verified: DemoAsset[] = [];
  for (const source of sources) {
    const metadata = demoSourceProbes.get(source.bytes) || await probeMediaBytes(source.bytes, source.mimeType);
    demoSourceProbes.set(source.bytes, metadata);
    verified.push({ ...source, metadata });
  }
  return createDemoProviderVideoSources(verified, demoPublicAssetOrigin, demoPublicVideoAssetAccess);
}

async function callDemoClaude(modelId: string, input: { input: DemoResponseInput[]; tools: DemoResponseTool[]; toolChoice?: unknown; stream?: boolean; thinking?: boolean; maxTokens?: number }) {
  const endpoint = `${apiMartBaseUrl.replace(/\/v1$/, "")}/v1/messages`;
  const body = {
    model: modelId,
    ...buildClaudeMessagesRequest(input as never, {
      modelId,
      maxTokens: Math.max(1, Math.min(16_384, Math.floor(input.maxTokens || 2048))),
      stream: false,
      thinking: input.thinking === true,
    }),
  };
  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: { "x-api-key": apiMartApiKey, "anthropic-version": ANTHROPIC_MESSAGES_VERSION, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!upstream.ok) throw new Error(`Claude Provider ${upstream.status}: ${(await upstream.text()).slice(0, 500)}`);
  return readClaudeResponse(await upstream.json() as never);
}

async function callDemoClaudeStream(modelId: string, input: { input: DemoResponseInput[]; tools: DemoResponseTool[]; toolChoice?: unknown; thinking?: boolean; maxTokens?: number }) {
  const upstream = await fetch(`${apiMartBaseUrl.replace(/\/v1$/, "")}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": apiMartApiKey, "anthropic-version": ANTHROPIC_MESSAGES_VERSION, "content-type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      ...buildClaudeMessagesRequest(input as never, {
        modelId,
        maxTokens: Math.max(1, Math.min(16_384, Math.floor(input.maxTokens || 2048))),
        stream: true,
        thinking: input.thinking === true,
      }),
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!upstream.ok) throw new Error(`Claude Provider ${upstream.status}: ${(await upstream.text()).slice(0, 500)}`);
  if (!upstream.body) throw new Error("Claude Provider did not return a streaming body");
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

function revokeProviderVideoSources(accessTokens: string[]) {
  for (const accessToken of accessTokens) demoPublicVideoAssetAccess.delete(accessToken);
}

function publicDemoAssetResponse(asset: DemoAsset) {
  return new Response(Uint8Array.from(asset.bytes).buffer, {
    headers: {
      "content-type": asset.mimeType,
      "cache-control": "private, max-age=60",
    },
  });
}

function storeDemoTaskResult(task: DemoTask, ownerUserId: string, resultUrl: string) {
  const inlineImage = decodeInlineImageResult(resultUrl);
  if (!inlineImage) return resultUrl;

  const assetId = crypto.randomUUID();
  const extension = inlineImage.mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
  demoAssets.set(assetId, {
    id: assetId,
    ownerUserId,
    filename: `generation-${task.id}.${extension}`,
    taskId: task.id,
    projectId: task.projectId,
    mimeType: inlineImage.mimeType,
    bytes: inlineImage.bytes,
    createdAt: now(),
  });
  return `/api/assets/${assetId}/content`;
}

function completeDemoImageTask(task: DemoTask, ownerUserId: string, resultUrl: string) {
  task.resultUrls = [storeDemoTaskResult(task, ownerUserId, resultUrl)];
  task.status = "success";
  task.updatedAt = now();
}

Bun.serve({
  maxRequestBodySize: 210 * 1024 * 1024,
  port: demoPort,
  hostname: demoHost,
  idleTimeout: DEMO_STREAM_IDLE_TIMEOUT_SECONDS,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (standaloneWebDirectory && request.method === "GET" && !path.startsWith("/api/")) {
      const requestedPath = resolveStandaloneStaticPath(standaloneWebDirectory, path);
      if (requestedPath) {
        const requestedFile = Bun.file(requestedPath);
        if (await requestedFile.exists()) return new Response(requestedFile);
      }
      const indexFile = Bun.file(resolveStandaloneStaticPath(standaloneWebDirectory, "/")!);
      if (await indexFile.exists()) return new Response(indexFile);
    }
    if (path === "/api/health")
      return json({ status: "ok", mode: "local-demo" });
    if (path === "/api/deployment")
      return json(features, 200, { "cache-control": "no-store" });
    if (path === "/api/demo/accounts")
      return json({ accounts: publicAccounts() });
    if (path === "/api/auth/login" && request.method === "POST") {
      const input = (await request.json()) as {
        identifier?: string;
        password?: string;
        portal?: "designer" | "admin";
      };
      const account = authenticateDemoAccount(
        input.identifier || "",
        input.password || "",
        input.portal || "designer",
      ) || (!features.rolePortalsEnabled ? authenticateDemoAccount(input.identifier || "", input.password || "", "admin") : null);
      if (!account)
        return json(
          {
            error: "INVALID_CREDENTIALS",
            message: "测试账号、密码或登录入口不匹配",
          },
          401,
        );
      const token = crypto.randomUUID();
      sessions.set(token, account.id);
      return json({ user: account.user }, 200, {
        "set-cookie": `wireless_canvas_demo_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`,
      });
    }
    if (path === "/api/auth/session") {
      const user = sessionUser(request);
      return user
        ? json({ user })
        : json({ error: "UNAUTHORIZED", message: "请先登录" }, 401);
    }
    if (path === "/api/auth/logout" && request.method === "POST")
      return empty(204, {
        "set-cookie":
          "wireless_canvas_demo_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
      });
    if (path === "/api/auth/change-password" && request.method === "POST")
      return empty();
    if (
      /^\/api\/assets\/[^/]+\/content$/.test(path) &&
      request.method === "GET" &&
      url.searchParams.has("video_access")
    ) {
      const accessToken = url.searchParams.get("video_access") || "";
      const grant = demoPublicVideoAssetAccess.get(accessToken);
      const assetId = path.split("/")[3]!;
      if (!grant || grant.assetId !== assetId || grant.expiresAt < Date.now()) {
        demoPublicVideoAssetAccess.delete(accessToken);
        return json({ error: "NOT_FOUND", message: "素材不存在或访问已过期" }, 404);
      }
      const asset = demoAssets.get(assetId);
      if (!asset?.bytes.byteLength)
        return json({ error: "NOT_FOUND", message: "素材不存在或访问已过期" }, 404);
      return publicDemoAssetResponse(asset);
    }
    const user = sessionUser(request);
    if (!user) return json({ error: "UNAUTHORIZED", message: "请先登录" }, 401);

    if (path === "/api/modules")
      return json({
        modules: modules.map((moduleKey) => ({
          moduleKey,
          enabled: true,
          updatedAt: now(),
        })),
      });
    if (path === "/api/projects/sync" && request.method === "POST") {
      try {
        return json(syncDemoProject(await request.json()));
      } catch (error) {
        return json(
          {
            error: "INVALID_PROJECT",
            message: error instanceof Error ? error.message : "Invalid project identity",
          },
          400,
        );
      }
    }
    if (path === "/api/models")
      return json({
        models: listAvailableDemoModels(demoModels, demoProviders)
          .sort((left, right) => {
            const leftConfigured = demoProviders.find((provider) => provider.id === left.providerId)?.hasCredentials === true ? 1 : 0;
            const rightConfigured = demoProviders.find((provider) => provider.id === right.providerId)?.hasCredentials === true ? 1 : 0;
            return rightConfigured - leftConfigured;
          })
          .map(({ id, name, modelId, capabilities, creditCost, rmbCost, providerId }) => ({
            id,
            name,
            modelId,
            capabilities,
            imageParameterProfile: imageParameterProfile(demoProviders.find(provider => provider.id === providerId)?.protocol, modelId),
            creditCost: billedDemoCredits(!features.creditsEnabled, Number(creditCost || 0)),
            rmbCost,
          })),
        prices: demoPrices
          .filter((price) => price.status === "published")
          .map(({ operationType, label, credits, rmbCost, version }) => ({
            operationType,
            label,
            credits: billedDemoCredits(!features.creditsEnabled, Number(credits || 0)),
            rmbCost,
            version,
          })),
        tools: demoToolConfigurations.filter((tool) => tool.enabled && listAvailableDemoModels(demoModels, demoProviders).some((model) => model.id === tool.modelConfigId)),
      });
    if (path === "/api/chat/responses" && request.method === "POST") {
      const input = (await request.json()) as {
        modelId?: string;
        input?: DemoResponseInput[];
        tools?: DemoResponseTool[];
        toolChoice?: unknown;
        webSearch?: boolean;
        gemini?: { maxOutputTokens: number };
        claude?: { stream?: boolean; thinking?: boolean; maxTokens?: number };
      };
      const selectedModel = String(input.modelId || "");
      const openTokenChatModel = demoModels.find((model) =>
        [openTokenGptChatModel.id, openTokenClaudeModel.id].includes(String(model.id)) &&
        (model.id === selectedModel || model.modelId === selectedModel),
      );
      if (openTokenChatModel) {
        const provider = demoProviders.find((item) => item.id === openTokenChatModel.providerId && item.enabled === true);
        if (!provider || openTokenChatModel.enabled !== true || !(openTokenChatModel.capabilities as string[]).includes("chat"))
          return json({ error: "MODEL_DISABLED", message: "管理员尚未启用该对话模型" }, 400);
        const protocols = openTokenChatModel.id === openTokenClaudeModel.id ? ["anthropic"] : ["openai", "openai-chat"];
        if (!protocols.includes(String(provider.protocol)))
          return json({ error: "MODEL_PROTOCOL_MISMATCH", message: "所选 API 协议与当前对话模型不匹配" }, 400);
        const apiKey = demoChatProviderApiKey(String(provider.id));
        if (!provider.hasCredentials || !apiKey)
          return json({ error: "PROVIDER_NOT_CONFIGURED", message: "所选对话 API 服务尚未配置服务端密钥" }, 503);
        const model = {
          model_id: String(openTokenChatModel.modelId),
          base_url: String(provider.baseUrl),
          protocol: String(provider.protocol),
          encrypted_credentials: null,
        };
        const chatInput = {
          input: input.input || [],
          tools: input.tools || [],
          toolChoice: input.toolChoice,
          webSearch: input.webSearch,
          claude: input.claude ? {
            ...input.claude,
            maxTokens: Math.max(1, Math.min(16_384, Math.floor(input.claude.maxTokens || 2048))),
          } : undefined,
        };
        try {
          if (model.protocol === "anthropic" && input.claude?.stream) {
            const upstream = await requestClaudeStream(model, { apiKey }, chatInput);
            return new Response(upstream.body, {
              status: upstream.status,
              headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" },
            });
          }
          return json(await requestChatCompletion(model, { apiKey }, chatInput));
        } catch (error) {
          return json({ error: "UPSTREAM_REQUEST_FAILED", message: error instanceof Error ? error.message : "OpenToken request failed" }, 502);
        }
      }
      if (selectedModel !== "gemini-3.1-pro-preview" && !claudeModelIds.includes(selectedModel as (typeof claudeModelIds)[number]))
        return json({ error: "MODEL_DISABLED", message: "管理员尚未启用该对话模型" }, 400);
      if (!apiMartApiKey)
        return json({ error: "PROVIDER_NOT_CONFIGURED", message: "本地服务端尚未配置 APIMart 密钥" }, 503);
      try {
        if (selectedModel !== "gemini-3.1-pro-preview" && input.claude?.stream)
          return await callDemoClaudeStream(selectedModel, { input: input.input || [], tools: input.tools || [], toolChoice: input.toolChoice, thinking: input.claude.thinking, maxTokens: input.claude.maxTokens });
        return json(selectedModel === "gemini-3.1-pro-preview"
          ? await callDemoGemini({ input: input.input || [], tools: input.tools || [], toolChoice: input.toolChoice, webSearch: input.webSearch, gemini: input.gemini })
          : await callDemoClaude(selectedModel, { input: input.input || [], tools: input.tools || [], toolChoice: input.toolChoice, stream: input.claude?.stream, thinking: input.claude?.thinking, maxTokens: input.claude?.maxTokens }));
      } catch (error) {
        return json({ error: "UPSTREAM_REQUEST_FAILED", message: error instanceof Error ? error.message : "Gemini request failed" }, 502);
      }
    }
    if (path === "/api/prompt-templates" && request.method === "GET")
      return json({ templates: [], total: 0, page: 1, pageSize: 24 });

    if (path === "/api/assets/upload-request" && request.method === "POST") {
      const input = (await request.json()) as {
        filename?: string;
        mimeType?: string;
        byteSize?: number;
        clientReferenceId?: string;
        projectId?: string;
        metadata?: Record<string, unknown>;
      };
      if (!input.mimeType || !/^(image|video|audio|text)\//.test(input.mimeType))
        return json(
          { error: "INVALID_ASSET", message: "仅支持图片、视频、音频或文本素材" },
          400,
        );
      if (
        !Number.isFinite(input.byteSize) ||
        Number(input.byteSize) <= 0 ||
        Number(input.byteSize) > 200 * 1024 * 1024
      )
        return json(
          { error: "INVALID_ASSET_SIZE", message: "素材大小必须在 200MB 以内" },
          400,
        );
      const existing = input.clientReferenceId
        ? [...demoAssets.values()].find((asset) => asset.ownerUserId === user.id && asset.clientReferenceId === input.clientReferenceId)
        : undefined;
      if (existing)
        return json({ assetId: existing.id, uploadUrl: existing.bytes.byteLength ? null : `/api/assets/${existing.id}/content-upload`, reused: true }, 201);
      const assetId = crypto.randomUUID();
      demoAssets.set(assetId, {
        id: assetId,
        ownerUserId: user.id,
        filename: input.filename || "source-image",
        mimeType: input.mimeType,
        bytes: new Uint8Array(),
        createdAt: now(),
        clientReferenceId: input.clientReferenceId,
        projectId: input.projectId,
        metadata: input.metadata,
        byteSize: Number(input.byteSize),
      });
      return json(
        { assetId, uploadUrl: `/api/assets/${assetId}/content-upload` },
        201,
      );
    }
    if (
      /^\/api\/assets\/[^/]+\/content-upload$/.test(path) &&
      request.method === "PUT"
    ) {
      const assetId = path.split("/")[3]!;
      const asset = demoAssets.get(assetId);
      if (!asset || asset.ownerUserId !== user.id)
        return json({ error: "NOT_FOUND", message: "上传素材不存在" }, 404);
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (!bytes.byteLength || bytes.byteLength > 200 * 1024 * 1024 || bytes.byteLength !== asset.byteSize)
        return json(
          { error: "INVALID_ASSET_SIZE", message: "素材大小必须在 200MB 以内且与上传申请一致" },
          400,
        );
      asset.bytes = bytes;
      if (asset.mimeType.startsWith("text/")) asset.metadata = { ...asset.metadata, content: new TextDecoder().decode(bytes) };
      return empty();
    }
    if (
      /^\/api\/assets\/[^/]+\/content$/.test(path) &&
      request.method === "GET"
    ) {
      const asset = demoAssets.get(path.split("/")[3]!);
      if (!asset || asset.ownerUserId !== user.id || !asset.bytes.byteLength)
        return json(
          { error: "NOT_FOUND", message: "素材不存在或无权访问" },
          404,
        );
      return publicDemoAssetResponse(asset);
    }
    if (path === "/api/generation-capabilities" && request.method === "GET")
      return json({
        models: listAvailableDemoModels(demoModels, demoProviders)
          .filter((model) => isSupportedVideoModelId(model.modelId))
          .map((model) => {
            const modelId = model.modelId as SupportedVideoModelId;
            return {
              id: model.id,
              name: model.name,
              modelId,
              capability: getVideoModelCapability(modelId),
            };
          }),
      });
    if (path === "/api/tasks/batch" && request.method === "POST") {
      const input = (await request.json().catch(() => null)) as {
        requestId?: string;
        projectId?: string;
        operationType?: string;
        modelConfigId?: string;
        prompt?: string;
        parameters?: Record<string, unknown>;
        priority?: string;
        items?: Array<{ sourceUrls?: string[] }>;
      } | null;
      if (!input?.requestId || !input.projectId || !input.operationType || !input.modelConfigId || !Array.isArray(input.items) || !input.items.length)
        return json({ error: "INVALID_BATCH", message: "Batch task details are incomplete" }, 400);
      const batchId = crypto.randomUUID();
      const cookie = request.headers.get("cookie") || "";
      const tasks: Array<Record<string, unknown> & { itemIndex: number }> = [];
      const failures: Array<{ index: number; reason: string }> = [];
      const taskInputs = createDemoBatchTaskInputs({
        requestId: input.requestId,
        projectId: input.projectId,
        operationType: input.operationType,
        modelConfigId: input.modelConfigId,
        prompt: input.prompt || "",
        parameters: input.parameters,
        priority: input.priority,
        items: input.items.map((item) => ({ sourceUrls: item.sourceUrls || [] })),
      });
      for (const [itemIndex, taskInput] of taskInputs.entries()) {
        const response = await fetch(`http://127.0.0.1:${demoPort}/api/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify(taskInput),
        });
        const body = (await response.json().catch(() => ({}))) as { task?: Record<string, unknown>; message?: string };
        if (response.ok && body.task) tasks.push({ ...body.task, itemIndex });
        else failures.push({ index: itemIndex, reason: body.message || `Task submission failed (${response.status})` });
      }
      return json({ batchId, tasks, failures }, 201);
    }
    if (path === "/api/tasks/preflight" && request.method === "POST") {
      const input = (await request.clone().json().catch(() => ({}))) as {
        requestId?: string;
        operationType?: string;
        modelConfigId?: string;
        prompt?: string;
        parameters?: Record<string, unknown>;
        sourceUrls?: string[];
      };
      if (input.operationType !== "video_generation")
        return json({ error: "UNSUPPORTED_OPERATION", message: "Only video preflight is supported" }, 400);
      if (!apiMartApiKey)
        return json({ error: "PROVIDER_NOT_CONFIGURED", message: "Video generation provider is not configured" }, 503);
      const model = demoModels.find(
        (item) => item.id === input.modelConfigId && isSupportedVideoModelId(item.modelId) && item.enabled,
      );
      if (!model)
        return json({ error: "MODEL_DISABLED", message: "The selected video model is not enabled" }, 400);
      const sources = resolveOwnedVideoSources(input.sourceUrls || [], user);
      if (sources instanceof Response) return sources;
      const modelId = model.modelId as SupportedVideoModelId;
      let accessTokens: string[] = [];
      try {
        const providerSources = await createProviderVideoSources(modelId, sources);
        accessTokens = providerSources.accessTokens;
        const preflight = preflightVideoSources(modelId, input.prompt || "", input.parameters || {}, providerSources.sources);
        return json({ ok: true, requestId: input.requestId || crypto.randomUUID(), normalized: preflight.normalized });
      } catch (error) {
        return json({ error: "INVALID_VIDEO_INPUT", message: error instanceof Error ? error.message : "Invalid video parameters" }, 400);
      } finally {
        revokeProviderVideoSources(accessTokens);
      }
    }
    if (path === "/api/tasks" && request.method === "POST") {
      const input = (await request
        .clone()
        .json()
        .catch(() => ({}))) as {
        requestId?: string;
        projectId?: string;
        operationType?: string;
        modelConfigId?: string;
        prompt?: string;
        parameters?: Record<string, unknown>;
        sourceUrls?: string[];
      };
      if (input.operationType === "video_generation") {
        if (!apiMartApiKey)
          return json(
            {
              error: "PROVIDER_NOT_CONFIGURED",
              message: "APIMart server credential is not configured",
            },
            503,
          );
        const duplicate = input.requestId
          ? Array.from(demoTasks.values()).find(
              (task) => task.requestId === input.requestId,
            )
          : undefined;
        if (duplicate)
          return duplicate.ownerUserId === user.id
            ? json({ task: duplicate })
            : json(
                {
                  error: "DUPLICATE_REQUEST",
                  message: "Request identifier has already been used",
                },
                400,
              );
        const model = demoModels.find(
          (item) =>
            item.id === input.modelConfigId &&
            isSupportedVideoModelId(item.modelId) &&
            item.enabled,
        );
        if (!model)
          return json(
            {
              error: "MODEL_DISABLED",
              message: "The selected video model is not enabled",
            },
            400,
          );
        const sources = resolveOwnedVideoSources(input.sourceUrls || [], user);
        if (sources instanceof Response) return sources;
        const modelId = model.modelId as SupportedVideoModelId;
        const parameters = (input.parameters || {}) as VideoProviderParameters;
        let accessTokens: string[] = [];
        try {
          const providerSources = await createProviderVideoSources(modelId, sources);
          accessTokens = providerSources.accessTokens;
          const checked = preflightVideoSources(modelId, input.prompt || "", parameters, providerSources.sources);
          Object.assign(parameters, checked.normalized);
        } catch (error) {
          return json(
            {
              error: "INVALID_VIDEO_INPUT",
              message: error instanceof Error ? error.message : "Invalid video parameters",
            },
            400,
          );
        } finally {
          revokeProviderVideoSources(accessTokens);
        }
        const price = demoPrices.find(
          (item) =>
            item.operationType === "video_generation" &&
            item.status === "published",
        );
        const credits = billedDemoCredits(!features.creditsEnabled,
          Number(price?.credits || 0) + Number(model.creditCost || 0));
        if (features.creditsEnabled && user.creditBalance < credits)
          return json(
            {
              error: "INSUFFICIENT_CREDITS",
              message: `Insufficient credits: ${credits} required`,
            },
            400,
          );
        const task: DemoTask = {
          id: crypto.randomUUID(),
          requestId: input.requestId || crypto.randomUUID(),
          ownerUserId: user.id,
          operationType: "video_generation",
          status: "processing",
          resultUrls: [],
          failureReason: null,
          stage: "submitted",
          errorCode: null,
          upstreamTaskId: null,
          providerModel: modelId,
          updatedAt: now(),
          credits,
          createdAt: now(),
        };
        Object.assign(task, { prompt: input.prompt || "", parameters, sourceUrls: input.sourceUrls || [], projectId: input.projectId, modelConfigId: input.modelConfigId });
        demoTasks.set(task.id, task);
        if (features.creditsEnabled) user.creditBalance -= credits;
        void runVideoTask(task, user, modelId, input.prompt || "", parameters, sources);
        return json({ task }, 201);
      }
      if (
        ["image_generation", "inpaint", "upscale"].includes(
          input.operationType || "",
        )
      ) {
        if (!openTokenApiKey && !apiMartApiKey)
          return json(
            {
              error: "PROVIDER_NOT_CONFIGURED",
              message: "Image generation service credential is not configured",
            },
            503,
          );
        const duplicate = input.requestId
          ? Array.from(demoTasks.values()).find(
              (task) => task.requestId === input.requestId,
            )
          : undefined;
        if (duplicate)
          return duplicate.ownerUserId === user.id
            ? json({ task: duplicate })
            : json(
                {
                  error: "DUPLICATE_REQUEST",
                  message: "Request identifier has already been used",
                },
                400,
              );
        const model = demoModels.find(
          (item) =>
            item.id === input.modelConfigId &&
            typeof item.modelId === "string" &&
            ((Boolean(openTokenApiKey) &&
              item.providerId === openTokenProviderId &&
              isOpenTokenImageModel(item.modelId)) ||
              (Boolean(apiMartApiKey) &&
                item.providerId === gptImage2ProviderId &&
                apiMartImageModel(item.modelId))) &&
            item.enabled,
        );
        if (!model)
          return json(
            {
              error: "MODEL_DISABLED",
              message: "所选图片模型未启用或当前渠道未配置",
            },
            400,
          );
        const sources: DemoAsset[] = [];
        for (const sourceUrl of input.sourceUrls || []) {
          const assetId = sourceUrl.match(
            /^\/api\/assets\/([0-9a-f-]+)\/content$/i,
          )?.[1];
          const source = assetId ? demoAssets.get(assetId) : undefined;
          if (
            !source ||
            source.ownerUserId !== user.id ||
            !source.bytes.byteLength
          )
            return json(
              {
                error: "INVALID_SOURCE",
                message: "A selected reference image is unavailable",
              },
              400,
            );
          sources.push(source);
        }
        const imageModelId = String(model.modelId);
        if ((imageModelId === "midjourney" || imageModelId === "midjourney-blend") && input.operationType !== "image_generation")
          return json({ error: "MODEL_CAPABILITY_MISMATCH", message: "Midjourney 当前只支持文生图，请选择 GPT-Image-2 或 Gemini 图片模型进行编辑" }, 400);
        const apiMartModel = model.providerId === openTokenProviderId ? null : apiMartImageModel(imageModelId);
        const isGptImage2 = imageModelId.startsWith("gpt-image-2") || apiMartModel === "gpt-image-2";
        if (sources.length > (isGptImage2 ? 16 : imageModelId === "midjourney" ? 0 : imageModelId === "midjourney-blend" ? 4 : 14))
          return json(
            {
              error: "TOO_MANY_REFERENCES",
              message: isGptImage2 ? "GPT-Image-2 最多支持 16 张参考图" : imageModelId === "midjourney" ? "Midjourney 文生图不支持上传参考图" : "Gemini 3.1 Flash 最多支持 14 张参考图",
            },
            400,
          );
        if (imageModelId === "midjourney-blend" && sources.length < 2)
          return json(
            {
              error: "INSUFFICIENT_REFERENCES",
              message: "Midjourney Blend requires two to four reference images",
            },
            400,
          );
        const price = demoPrices.find(
          (item) =>
            item.operationType === input.operationType &&
            item.status === "published",
        );
        const credits = billedDemoCredits(!features.creditsEnabled,
          Number(price?.credits || 0) + Number(model.creditCost || 0));
        if (features.creditsEnabled && user.creditBalance < credits)
          return json(
            {
              error: "INSUFFICIENT_CREDITS",
              message: `Insufficient credits: ${credits} required`,
            },
            400,
          );
        const task: DemoTask = {
          id: crypto.randomUUID(),
          requestId: input.requestId || crypto.randomUUID(),
          ownerUserId: user.id,
          operationType: input.operationType!,
          status: "processing",
          resultUrls: [],
          failureReason: null,
          credits,
          createdAt: now(),
        };
        Object.assign(task, { prompt: input.prompt || "", parameters: input.parameters || {}, sourceUrls: input.sourceUrls || [], projectId: input.projectId, modelConfigId: input.modelConfigId });
        demoTasks.set(task.id, task);
        if (features.creditsEnabled) user.creditBalance -= credits;
        if (model.providerId === openTokenProviderId)
          void runOpenTokenImageTaskForDemo(
            task,
            user,
            imageModelId as OpenTokenImageModel,
            input.prompt || "",
            input.parameters || {},
            sources,
          );
        else
          void runApiMartImageTaskForDemo(
            task,
            user,
            imageModelId,
            input.prompt || "",
            input.parameters || {},
            sources,
          );
        return json({ task }, 201);
      }
      if (input.operationType !== "seamless_stitch")
        return json(
          {
            error: "DEMO_OPERATION_UNAVAILABLE",
            message: "当前服务未配置此任务类型的可用模型，请先在后台配置；图像与视频可使用已启用的模型。",
          },
          400,
        );
      const duplicate = input.requestId
        ? Array.from(demoTasks.values()).find(
            (task) => task.requestId === input.requestId,
          )
        : undefined;
      if (duplicate) {
        if (duplicate.ownerUserId !== user.id)
          return json(
            { error: "DUPLICATE_REQUEST", message: "任务请求标识已被使用" },
            400,
          );
        return json({ task: duplicate });
      }
      const model = demoModels.find(
        (item) => item.id === input.modelConfigId && item.enabled,
      );
      const binding = demoToolConfigurations.find(
        (item) =>
          item.toolKey === "seamless-stitch" &&
          item.enabled &&
          item.modelConfigId === model?.id,
      );
      if (!model || !binding)
        return json(
          { error: "MODEL_DISABLED", message: "管理员尚未启用无缝拼接模型" },
          400,
        );
      const sourceMatch = input.sourceUrls?.[0]?.match(
        /^\/api\/assets\/([0-9a-f-]+)\/content$/i,
      );
      const source = sourceMatch ? demoAssets.get(sourceMatch[1]!) : undefined;
      if (!source || source.ownerUserId !== user.id || !source.bytes.byteLength)
        return json(
          { error: "INVALID_SOURCE", message: "请先上传一张有效的源图片" },
          400,
        );
      const parameters = readSeamlessParameters(input.parameters);
      if (!parameters)
        return json(
          {
            error: "INVALID_SEAMLESS_PARAMETERS",
            message: "请检查切割宽度、重绘宽度、羽化、重绘强度和步数",
          },
          400,
        );
      const price = demoPrices.find(
        (item) =>
          item.operationType === "seamless_stitch" &&
          item.status === "published",
      );
      const credits = billedDemoCredits(!features.creditsEnabled,
        Number(price?.credits || 0) + Number(model.creditCost || 0));
      if (features.creditsEnabled && user.creditBalance < credits)
        return json(
          {
            error: "INSUFFICIENT_CREDITS",
            message: `额度不足：本次需要 ${credits} 积分`,
          },
          400,
        );
      const task: DemoTask = {
        id: crypto.randomUUID(),
        requestId: input.requestId || crypto.randomUUID(),
        ownerUserId: user.id,
        operationType: input.operationType,
        status: "processing",
        resultUrls: [],
        failureReason: null,
        credits,
        createdAt: now(),
      };
      demoTasks.set(task.id, task);
      if (features.creditsEnabled) user.creditBalance -= credits;
      void runInternalAiSeamlessTask(task, user, source, parameters);
      return json({ task }, 201);
    }
    if (path === "/api/tasks" && request.method === "GET")
      return json({
        tasks: Array.from(demoTasks.values())
          .filter((task) => task.ownerUserId === user.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      });
    const taskId = path.match(/^\/api\/tasks\/([0-9a-f-]+)$/i)?.[1];
    if (taskId && request.method === "GET") {
      const task = demoTasks.get(taskId);
      return task && task.ownerUserId === user.id
        ? json({ task })
        : json({ error: "NOT_FOUND", message: "Task not found" }, 404);
    }
    const recoverTaskId = path.match(/^\/api\/tasks\/([0-9a-f-]+)\/recover$/i)?.[1];
    if (recoverTaskId && request.method === "POST") {
      const task = demoTasks.get(recoverTaskId);
      if (!task || task.ownerUserId !== user.id)
        return json({ error: "NOT_FOUND", message: "Task not found" }, 404);
      if (task.status === "success")
        return json({ task, recovered: false, message: "Task has already completed" });
      if (!task.upstreamTaskId || !task.providerModel)
        return json({ task, recovered: false, message: "No upstream task is available to query" });
      if (task.status === "processing")
        return json({ task, recovered: false, message: "Task is already being queried" });
      task.status = "processing";
      task.stage = "polling";
      task.errorCode = null;
      task.failureReason = null;
      task.updatedAt = now();
      void recoverVideoTask(task, task.providerModel, task.upstreamTaskId);
      return json({ task, recovered: true, message: "Task status is being queried without a new generation submission" });
    }

    if (/^\/api\/assets\/[^/]+\/metadata$/.test(path) && request.method === "PATCH") {
      const asset = demoAssets.get(path.split("/")[3]!);
      if (!asset || asset.ownerUserId !== user.id) return json({ error: "NOT_FOUND", message: "素材不存在或无权编辑" }, 404);
      const parsed = assetMetadataSchema.safeParse(await request.json());
      if (!parsed.success) return json({ error: "INVALID_INPUT", message: "素材名称、标签或备注格式不正确" }, 400);
      asset.metadata = { ...asset.metadata, ...parsed.data };
      return new Response(null, { status: 204 });
    }

    if (path === "/api/assets" && request.method === "GET") {
      return json({ assets: [...demoAssets.values()].filter((asset) => asset.ownerUserId === user.id && asset.bytes.byteLength).map((asset) => {
        const task = asset.taskId ? demoTasks.get(asset.taskId) : undefined;
        return { id: asset.id, ownerUserId: asset.ownerUserId, ownerName: user.displayName, departmentId: user.departmentId || null,
          departmentName: user.departmentName || null, projectId: asset.projectId || null, projectName: null, taskId: asset.taskId || null,
          filename: asset.filename, mimeType: asset.mimeType, byteSize: asset.bytes.byteLength, kind: asset.mimeType.startsWith("image/") ? "image" : asset.mimeType.startsWith("video/") ? "video" : asset.mimeType.startsWith("text/") ? "text" : "other",
          source: task ? "generation" : "upload", operationType: task?.operationType || null, prompt: task?.prompt || null,
          modelName: demoModels.find((model) => model.id === task?.modelConfigId)?.name || null, status: "ready", visibilityScope: "private",
          metadata: asset.metadata || {}, createdAt: asset.createdAt, resultStatus: "unused", usabilityScore: 0, downloadCount: 0, firstDownloadedAt: null, eventCount: 0 };
      }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
    }
    if (path === "/api/history" && request.method === "GET") {
      return json({ history: [...demoTasks.values()].filter((task) => task.ownerUserId === user.id).map((task) => ({
        ...task, taskId: task.id, userId: user.id, userName: user.displayName, departmentId: user.departmentId || null,
        departmentName: user.departmentName || null, modelName: demoModels.find((model) => model.id === task.modelConfigId)?.name || "",
        prompt: task.prompt || "", parameters: task.parameters || {}, sourceUrls: task.sourceUrls || [], credits: task.status === "success" ? task.credits : 0, rmbCost: 0,
      })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
    }
    if (!user.role.includes("admin")) {
      if (path === "/api/projects") return json({ projects: [] });
      if (path === "/api/team" && user.groupRole === "leader")
        return json({
          group: {
            id: user.groupId,
            name: user.groupName,
            code: "VIS-01",
            departmentName: user.departmentName,
            memberCount: 3,
          },
          members: [],
          summary: { taskCount: 0, successCount: 0, credits: 0, rmbCost: 0 },
        });
      return json(
        { error: "NOT_FOUND", message: "本地演示接口暂未提供此数据" },
        404,
      );
    }

    if (path === "/api/admin/accounts" && request.method === "GET")
      return json({ users: demoAccounts.map((account) => account.user) });
    if (path === "/api/admin/internal-ai" && request.method === "GET")
      return json(internalAiStatus());
    if (path === "/api/admin/internal-ai" && request.method === "PUT") {
      const input = (await request.json()) as {
        seamlessUrl?: string;
        appKey?: string;
        clearAppKey?: boolean;
      };
      const seamlessUrl = input.seamlessUrl?.trim();
      if (!seamlessUrl || !/^https?:\/\//i.test(seamlessUrl))
        return json(
          { error: { message: "请输入有效的内部 AI HTTP 地址" } },
          400,
        );
      internalAiConfig.seamlessUrl = seamlessUrl;
      if (input.clearAppKey) internalAiConfig.appKey = null;
      else if (input.appKey?.trim())
        internalAiConfig.appKey = input.appKey.trim();
      internalAiConfig.updatedAt = now();
      return json(internalAiStatus());
    }
    if (path === "/api/admin/internal-ai/test" && request.method === "POST") {
      if (!internalAiConfig.seamlessUrl || !internalAiConfig.appKey)
        return json(
          { error: { message: "请先保存内部 AI 地址和 App Key" } },
          400,
        );
      try {
        await callInternalAiSeamless(
          { id: crypto.randomUUID() },
          tinyTestImage,
          {
            cutWidth: 100,
            redrawWidth: 100,
            blurAmount: 50,
            redrawStrength: 0.5,
            steps: 12,
          },
        );
        return json({ ok: true, message: "真实内部 AI 已返回图片结果" });
      } catch (error) {
        return json(
          {
            error: {
              message:
                error instanceof Error ? error.message : "内部 AI 测试失败",
            },
          },
          502,
        );
      }
    }
    if (
      /^\/api\/admin\/accounts\/[^/]+\/credits$/.test(path) &&
      request.method === "POST"
    ) {
      const id = path.split("/")[4];
      const account = demoAccounts.find((item) => item.id === id);
      const input = (await request.json()) as { amount?: number };
      if (!account) return json({ message: "账号不存在" }, 404);
      account.user.creditBalance = Math.max(
        0,
        account.user.creditBalance + Number(input.amount || 0),
      );
      account.user.temporaryCreditAdjustment += Number(input.amount || 0);
      return json({ user: account.user });
    }
    if (
      /^\/api\/admin\/accounts\/[^/]+$/.test(path) &&
      request.method === "PATCH"
    ) {
      const account = demoAccounts.find(
        (item) => item.id === path.split("/")[4],
      );
      if (!account) return json({ message: "账号不存在" }, 404);
      Object.assign(account.user, await request.json());
      return json({ user: account.user });
    }
    if (path === "/api/admin/departments")
      return json({
        departments: [
          {
            id: "10000000-0000-4000-8000-000000000001",
            name: "设计中心",
            code: "DESIGN",
            createdAt: now(),
          },
        ],
      });
    if (path.startsWith("/api/admin/audit-logs"))
      return json({ auditLogs: [] });
    if (path === "/api/admin/history")
      return json({
        history: [],
        total: 0,
        totalCredits: 0,
        totalRmbCost: 0,
        page: 1,
        pageSize: 20,
      });
    if (path === "/api/admin/history/options")
      return json({ users: [], models: [], operations: [] });
    if (path === "/api/admin/tasks") return json({ tasks: [] });
    if (path === "/api/admin/tasks/batches") return json({ batches: [] });
    if (path === "/api/admin/groups") return json({ groups: [] });
    if (path === "/api/admin/workflows") return json({ workflows: [] });
    if (
      path === "/api/admin/model-configuration/providers" &&
      request.method === "GET"
    )
      return json({ providers: demoProviders });
    if (
      path === "/api/admin/model-configuration/providers" &&
      request.method === "POST"
    ) {
      const input = (await request.json()) as Record<string, unknown>;
      const credentials = input.credentials as Record<string, unknown> | undefined;
      const apiKey = typeof credentials?.apiKey === "string" ? credentials.apiKey.trim() : "";
      const provider: Record<string, unknown> = {
        ...input,
        id: crypto.randomUUID(),
        hasCredentials: ["openai", "openai-chat", "anthropic"].includes(String(input.protocol)) ? Boolean(apiKey) : Boolean(input.credentials),
        createdAt: now(),
        updatedAt: now(),
      };
      if (apiKey) demoProviderApiKeys.set(String(provider.id), apiKey);
      delete provider.credentials;
      demoProviders.push(provider);
      return json({ provider }, 201);
    }
    if (
      /^\/api\/admin\/model-configuration\/providers\/[^/]+$/.test(path) &&
      request.method === "PATCH"
    ) {
      const provider = demoProviders.find(
        (item) => item.id === path.split("/").at(-1),
      );
      if (!provider) return json({ message: "API 服务不存在" }, 404);
      const input = (await request.json()) as Record<string, unknown>;
      const credentials = input.credentials as Record<string, unknown> | undefined;
      const apiKey = typeof credentials?.apiKey === "string" ? credentials.apiKey.trim() : "";
      if (apiKey) demoProviderApiKeys.set(String(provider.id), apiKey);
      Object.assign(
        provider,
        input,
        input.credentials ? { hasCredentials: true } : {},
        { updatedAt: now() },
      );
      const updatedCredentials = applyDemoProviderCredentials(
        { apiMartApiKey, openTokenApiKey },
        String(provider.id),
        input.credentials as Record<string, unknown> | undefined,
        { apiMartProviderId: gptImage2ProviderId, openTokenProviderId, openTokenClaudeProviderId },
      );
      apiMartApiKey = updatedCredentials.apiMartApiKey;
      openTokenApiKey = updatedCredentials.openTokenApiKey;
      if ([openTokenProviderId, openTokenClaudeProviderId].includes(String(provider.id))) {
        for (const sharedProvider of demoProviders.filter((item) => [openTokenProviderId, openTokenClaudeProviderId].includes(String(item.id)))) {
          sharedProvider.hasCredentials = Boolean(openTokenApiKey);
          sharedProvider.updatedAt = provider.updatedAt;
        }
      } else if (["openai", "openai-chat", "anthropic"].includes(String(provider.protocol))) {
        provider.hasCredentials = Boolean(demoChatProviderApiKey(String(provider.id)));
      }
      delete provider.credentials;
      return json({ provider });
    }
    if (
      path === "/api/admin/model-configuration/models" &&
      request.method === "GET"
    )
      return json({ models: demoModels });
    if (
      path === "/api/admin/model-configuration/models" &&
      request.method === "POST"
    ) {
      const input = (await request.json()) as Record<string, unknown>;
      const provider = demoProviders.find(
        (item) => item.id === input.providerId,
      );
      const model = {
        ...input,
        id: crypto.randomUUID(),
        providerName: provider?.name || "未知 API",
        workflowName: null,
      };
      demoModels.push(model);
      return json({ model }, 201);
    }
    if (
      /^\/api\/admin\/model-configuration\/models\/[^/]+$/.test(path) &&
      request.method === "PATCH"
    ) {
      const model = demoModels.find(
        (item) => item.id === path.split("/").at(-1),
      );
      if (!model) return json({ message: "模型不存在" }, 404);
      const input = (await request.json()) as Record<string, unknown>;
      const provider = demoProviders.find(
        (item) => item.id === input.providerId,
      );
      Object.assign(
        model,
        input,
        provider ? { providerName: provider.name } : {},
      );
      return json({ model });
    }
    if (
      path === "/api/admin/model-configuration/prices" &&
      request.method === "GET"
    )
      return json({ prices: demoPrices });
    if (
      path === "/api/admin/model-configuration/prices" &&
      request.method === "POST"
    ) {
      const input = (await request.json()) as Record<string, unknown>;
      const version =
        Math.max(
          0,
          ...demoPrices
            .filter((price) => price.operationType === input.operationType)
            .map((price) => Number(price.version)),
        ) + 1;
      const price = {
        ...input,
        id: crypto.randomUUID(),
        version,
        status: "draft",
      };
      demoPrices.push(price);
      return json({ price }, 201);
    }
    if (
      /^\/api\/admin\/model-configuration\/prices\/[^/]+\/publish$/.test(
        path,
      ) &&
      request.method === "POST"
    ) {
      const id = path.split("/")[5];
      const target = demoPrices.find((price) => price.id === id);
      if (!target) return json({ message: "价格不存在" }, 404);
      demoPrices.forEach((price) => {
        if (
          price.operationType === target.operationType &&
          price.status === "published"
        )
          price.status = "retired";
      });
      target.status = "published";
      target.publishedAt = now();
      return empty();
    }
    if (
      /^\/api\/admin\/model-configuration\/prices\/[^/]+\/test$/.test(path) &&
      request.method === "POST"
    )
      return empty();
    if (
      path === "/api/admin/model-configuration/tool-configurations" &&
      request.method === "GET"
    )
      return json({
        tools: toolDefinitions.map((definition) => {
          const binding = demoToolConfigurations.find(
            (item) => item.toolKey === definition.toolKey,
          );
          const model = demoModels.find(
            (item) => item.id === binding?.modelConfigId,
          );
          const provider = demoProviders.find(
            (item) => item.id === model?.providerId,
          );
          const price = demoPrices.find(
            (item) =>
              item.operationType === definition.operationType &&
              item.status === "published",
          );
          return {
            ...definition,
            ...binding,
            modelName: model?.name,
            modelId: model?.modelId,
            modelCreditCost: model?.creditCost,
            modelRmbCost: model?.rmbCost,
            modelEnabled: model?.enabled,
            providerId: provider?.id,
            providerName: provider?.name,
            protocol: provider?.protocol,
            baseUrl: provider?.baseUrl,
            providerEnabled: provider?.enabled,
            hasCredentials: provider?.hasCredentials,
            workflowConfigId: null,
            workflowName: null,
            workflowEnabled: null,
            price: price
              ? {
                  operationType: price.operationType,
                  credits: price.credits,
                  rmbCost: price.rmbCost,
                  version: price.version,
                }
              : null,
          };
        }),
      });
    if (
      /^\/api\/admin\/model-configuration\/tool-configurations\/[^/]+$/.test(
        path,
      ) &&
      request.method === "PUT"
    ) {
      const selectedTool = path.split("/").at(-1)!;
      const input = (await request.json()) as {
        modelConfigId: string;
        enabled: boolean;
      };
      const existing = demoToolConfigurations.find(
        (item) => item.toolKey === selectedTool,
      );
      if (existing) Object.assign(existing, input);
      else
        demoToolConfigurations.push({
          toolKey:
            selectedTool as (typeof demoToolConfigurations)[number]["toolKey"],
          ...input,
        });
      return json({
        tool: { toolKey: selectedTool, ...input, updatedAt: now() },
      });
    }
    if (path === "/api/admin/assets") return json({ assets: [] });
    if (path === "/api/admin/projects") return json({ projects: [] });
    if (path === "/api/admin/modules" && request.method === "PATCH") {
      const input = (await request.json()) as {
        moduleKey: string;
        enabled: boolean;
      };
      return json({ module: { ...input, updatedAt: now() } });
    }
    return json(
      { error: "NOT_FOUND", message: "本地演示接口暂未提供此数据" },
      404,
    );
  },
});

console.log(`Local demo API listening on http://${demoHost}:${demoPort}`);

async function runApiMartImageTaskForDemo(
  task: DemoTask,
  user: (typeof demoAccounts)[number]["user"],
  modelId: string,
  prompt: string,
  parameters: Record<string, unknown>,
  sources: DemoAsset[],
) {
  try {
    completeDemoImageTask(task, user.id, await callApiMartImage(modelId, prompt, parameters, sources));
  } catch (error) {
    task.status = "failed";
    task.failureReason = isProviderNetworkError(error)
      ? "无法与图像服务建立安全连接。请检查服务器外网、TLS 证书策略或稍后重试；本次积分已自动退还。"
      : error instanceof Error ? error.message : "APIMart 图片任务失败";
    user.creditBalance += task.credits;
  }
}

async function runOpenTokenImageTaskForDemo(
  task: DemoTask,
  user: (typeof demoAccounts)[number]["user"],
  modelId: OpenTokenImageModel,
  prompt: string,
  parameters: Record<string, unknown>,
  sources: DemoAsset[],
) {
  try {
    completeDemoImageTask(task, user.id, await runOpenTokenImage({
      baseUrl: openTokenBaseUrl,
      apiKey: openTokenApiKey,
      modelId,
      prompt,
      ...openAiImageParameters(parameters, modelId),
      references: sources.map((source) => ({ filename: source.filename, mimeType: source.mimeType, bytes: source.bytes })),
    }));
  } catch (error) {
    task.status = "failed";
    task.failureReason = error instanceof Error ? error.message : "OpenToken image task failed";
    user.creditBalance += task.credits;
  }
}

async function callApiMartImage(
  modelId: string,
  prompt: string,
  parameters: Record<string, unknown>,
  sources: DemoAsset[],
) {
  try {
    const urls = await runApiMartImageTask({
      baseUrl: apiMartBaseUrl,
      apiKey: apiMartApiKey,
      modelId,
      prompt,
      parameters,
      sourceDataUrls: sources.map((source) => `data:${source.mimeType};base64,${Buffer.from(source.bytes).toString("base64")}`),
    });
    const first = urls[0];
    if (!first) throw new Error("APIMart 图片任务完成但没有结果图片");
    return downloadApiMartImage(first);
  } catch (error) {
    if (!isLocalCertificateError(error)) throw error;
    return callApiMartImageWithNode(modelId, prompt, parameters, sources);
  }
}

// The fallback keeps the exact APIMart request contract when Bun cannot
// validate the provider certificate on a Windows development machine.
async function callApiMartImageWithNode(
  modelId: string,
  prompt: string,
  parameters: Record<string, unknown>,
  sources: DemoAsset[],
) {
  const node = Bun.which("node");
  if (!node) throw new Error("Node.js is unavailable, so the APIMart HTTPS fallback cannot run");
  const request = buildApiMartImageRequest({
    modelId,
    prompt,
    parameters,
    sourceDataUrls: sources.map(
      (source) => `data:${source.mimeType};base64,${Buffer.from(source.bytes).toString("base64")}`,
    ),
  });
  const script = `
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw);
    const request = (path, init = {}) => fetch(process.env.APIMART_BASE_URL + path, {
      ...init,
      headers: { authorization: \`Bearer \${process.env.APIMART_API_KEY}\`, ...(init.headers || {}) },
    });
    const submitted = await request(input.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.payload),
      signal: AbortSignal.timeout(180000),
    });
    const createdText = await submitted.text();
    if (!submitted.ok) throw new Error(\`APIMart image submission failed: \${submitted.status}: \${createdText.slice(0, 500)}\`);
    const created = JSON.parse(createdText);
    const first = Array.isArray(created.data) ? created.data[0] : created.data;
    const taskId = first?.task_id || first?.id || created.task_id || created.id;
    if (!taskId) throw new Error("APIMart did not return a task ID");
    const deadline = Date.now() + input.timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, input.pollIntervalMs));
      const statusResponse = await request(\`/tasks/\${encodeURIComponent(taskId)}\`, { signal: AbortSignal.timeout(60000) });
      const statusText = await statusResponse.text();
      if (!statusResponse.ok) throw new Error(\`APIMart task status failed: \${statusResponse.status}\`);
      const status = JSON.parse(statusText);
      const data = status.data || status;
      const state = String(data.status || status.status || "").toLowerCase();
      const images = Array.isArray((data.result || status.result || {}).images) ? (data.result || status.result).images : [];
      const outputUrl = images.flatMap((image) => Array.isArray(image?.url) ? image.url : typeof image?.url === "string" ? [image.url] : [])[0];
      if (outputUrl) {
        const image = await fetch(outputUrl, { signal: AbortSignal.timeout(120000) });
        if (!image.ok) throw new Error(\`APIMart image download failed: \${image.status}\`);
        const mimeType = image.headers.get("content-type")?.split(";")[0] || "image/png";
        const data = Buffer.from(await image.arrayBuffer()).toString("base64");
        process.stdout.write(JSON.stringify({ mimeType, data }));
        process.exit(0);
      }
      if (["failed", "cancelled", "canceled"].includes(state)) throw new Error(data.error?.message || data.message || "APIMart image generation failed");
    }
    throw new Error("APIMart image generation timed out");
  `;
  const child = Bun.spawn([node, "--input-type=module", "-e", script], {
    stdin: new Blob([JSON.stringify(request)]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, APIMART_API_KEY: apiMartApiKey, APIMART_BASE_URL: apiMartBaseUrl },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || "APIMart local HTTPS fallback failed");
  const output = JSON.parse(stdout) as { mimeType?: string; data?: string };
  if (!output.mimeType || !output.data) throw new Error("APIMart local HTTPS fallback returned no image");
  return `data:${output.mimeType};base64,${output.data}`;
}

async function downloadApiMartImage(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`APIMart 图片下载失败：${response.status}`);
  const mimeType = response.headers.get("content-type")?.split(";")[0] || "image/png";
  return `data:${mimeType};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
}

async function runVideoTask(
  task: DemoTask,
  user: (typeof demoAccounts)[number]["user"],
  model: SupportedVideoModelId,
  prompt: string,
  parameters: VideoProviderParameters,
  sources: DemoAsset[],
) {
  try {
    task.stage = "polling";
    task.updatedAt = now();
    const outputUrl = await callVideoProvider(model, prompt, parameters, sources, (upstreamTaskId) => {
      task.upstreamTaskId = upstreamTaskId;
      task.updatedAt = now();
    }, () => { task.submissionStartedAt = now(); });
    task.stage = "downloading";
    task.updatedAt = now();
    task.resultUrls = [await storeDemoVideoResult(task, outputUrl)];
    task.status = "success";
    task.stage = "succeeded";
    task.updatedAt = now();
  } catch (error) {
    const paused = Boolean(task.submissionStartedAt) && !(error instanceof DemoVideoTerminalError);
    task.status = paused ? "paused" : "failed";
    task.stage = "failed";
    task.errorCode = classifyVideoTaskError(error);
    task.failureReason =
      error instanceof Error ? error.message : "Video task failed";
    task.updatedAt = now();
    if (!paused) user.creditBalance += task.credits;
  }
}

async function recoverVideoTask(
  task: DemoTask,
  model: SupportedVideoModelId,
  upstreamTaskId: string,
) {
  try {
    const outputUrl = await pollVideoProviderTask(model, upstreamTaskId);
    task.stage = "downloading";
    task.updatedAt = now();
    task.resultUrls = [await storeDemoVideoResult(task, outputUrl)];
    task.status = "success";
    task.stage = "succeeded";
    task.updatedAt = now();
  } catch (error) {
    task.status = error instanceof DemoVideoTerminalError ? "failed" : "paused";
    if (task.status === "failed") {
      const owner = demoAccounts.find((account) => account.user.id === task.ownerUserId)?.user;
      if (owner) owner.creditBalance += task.credits;
    }
    task.stage = "failed";
    task.errorCode = classifyVideoTaskError(error);
    task.failureReason = error instanceof Error ? error.message : "Video task status query failed";
    task.updatedAt = now();
  }
}

function resolveOwnedVideoSources(sourceUrls: string[], user: { id: string }): DemoAsset[] | Response {
  try { return resolveOwnedDemoVideoSources(sourceUrls, user.id, demoAssets); }
  catch (error) { return json({ error: "INVALID_SOURCE", message: error instanceof Error ? error.message : "参考素材不可用" }, 400); }
}

function classifyVideoTaskError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/balance|credit|quota/i.test(message)) return "INSUFFICIENT_CREDITS";
  if (/401|403|permission|unauthori[sz]ed/i.test(message)) return "PROVIDER_AUTHORIZATION";
  if (/status check|timeout|network|fetch/i.test(message)) return "RECOVERABLE_PROVIDER_STATUS";
  return "PROVIDER_FAILURE";
}

async function callVideoProvider(
  model: SupportedVideoModelId,
  prompt: string,
  parameters: VideoProviderParameters,
  sources: DemoAsset[],
  onSubmitted?: (upstreamTaskId: string) => void,
  onSubmissionStarting?: () => void,
) {
  const resolved = await createProviderVideoSources(model, sources);
  try {
  const uploadedSources = await prepareVideoProviderSources({ model, prompt, parameters, sources: resolved.sources, baseUrl: apiMartBaseUrl, apiKey: apiMartApiKey });
  const { body } = buildVideoProviderRequest(model, prompt, parameters, uploadedSources);
  onSubmissionStarting?.();
  const submitted = await fetch(`${apiMartBaseUrl}/videos/generations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiMartApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!submitted.ok)
    throw new (submitted.status < 500 ? DemoVideoTerminalError : Error)(
      `${model} submission failed: ${submitted.status}${await providerErrorDetail(submitted)}`,
    );
  const created = (await submitted.json()) as {
    data?: Array<{ task_id?: string }>;
  };
  const taskId = created.data?.[0]?.task_id;
  if (!taskId) throw new Error(`${model} did not return a task ID`);
  onSubmitted?.(taskId);
  return await pollVideoProviderTask(model, taskId);
  } finally {
    revokeProviderVideoSources(resolved.accessTokens);
  }
}

class DemoVideoTerminalError extends Error {}

async function storeDemoVideoResult(task: DemoTask, url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`视频下载失败（${response.status}），可恢复查询原任务`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength) throw new Error("视频结果为空，可恢复查询原任务");
  const id = crypto.randomUUID();
  demoAssets.set(id, { id, ownerUserId: task.ownerUserId, filename: `video-${task.id}.mp4`, mimeType: "video/mp4", bytes, createdAt: now(), projectId: task.projectId, taskId: task.id, upstreamUrl: isPublicHttpsUrl(url) ? url : undefined });
  return `/api/assets/${id}/content`;
}

async function pollVideoProviderTask(model: SupportedVideoModelId, taskId: string) {
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    await Bun.sleep(2_000);
    const statusResponse = await fetch(
      `${apiMartBaseUrl}${videoTaskStatusPath(taskId)}`,
      {
        headers: { authorization: `Bearer ${apiMartApiKey}` },
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!statusResponse.ok)
      throw new Error(
        `${model} status check failed: ${statusResponse.status}`,
      );
    const status = (await statusResponse.json()) as {
      data?: {
        status?: string;
        result?: { videos?: unknown[] };
        error?: { message?: string };
      };
    };
    if (["failed", "cancelled"].includes(status.data?.status || ""))
      throw new DemoVideoTerminalError(status.data?.error?.message || `${model} generation failed`);
    if (status.data?.status !== "completed") continue;
    const outputUrl = extractHappyHorseVideoUrl(status.data?.result?.videos);
    if (!outputUrl) throw new Error(`${model} completed without an output video`);
    return outputUrl;
  }
  throw new Error(`${model} generation timed out`);
}

function extractHappyHorseVideoUrl(items: unknown[] | undefined) {
  for (const item of items || []) {
    if (typeof item === "string" && /^https?:\/\//.test(item)) return item;
    if (item && typeof item === "object") {
      const value = item as { url?: string | string[]; video_url?: string; output_url?: string };
      if (typeof value.url === "string") return value.url;
      if (Array.isArray(value.url) && typeof value.url[0] === "string") return value.url[0];
      if (typeof value.video_url === "string") return value.video_url;
      if (typeof value.output_url === "string") return value.output_url;
    }
  }
  return "";
}

async function providerErrorDetail(response: Response) {
  const text = (await response.text()).trim();
  if (!text) return "";
  try {
    const payload = JSON.parse(text) as {
      message?: unknown;
      error?: { message?: unknown } | unknown;
      detail?: unknown;
      code?: unknown;
    };
    const message =
      typeof payload.message === "string"
        ? payload.message
        : payload.error && typeof payload.error === "object" &&
            typeof (payload.error as { message?: unknown }).message === "string"
          ? (payload.error as { message: string }).message
          : typeof payload.detail === "string"
            ? payload.detail
            : "";
    const code = typeof payload.code === "string" || typeof payload.code === "number" ? ` (${payload.code})` : "";
    return message ? `${code}: ${message}` : code;
  } catch {
    return `: ${text.slice(0, 500)}`;
  }
}

async function callGptImage2(
  prompt: string,
  parameters: Record<string, unknown>,
  sources: DemoAsset[],
) {
  try {
    return await callGptImage2WithBun(prompt, parameters, sources);
  } catch (error) {
    if (!isLocalCertificateError(error)) throw error;
    return callGptImage2WithNode(prompt, parameters, sources);
  }
}

async function callGptImage2WithBun(
  prompt: string,
  parameters: Record<string, unknown>,
  sources: DemoAsset[],
) {
  const size = normalizeGptImageSize(parameters.size);
  const resolution = normalizeGptImageResolution(parameters.resolution);
  const submitted = await fetch(`${apiMartBaseUrl}/images/generations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiMartApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-2",
      prompt,
      n: 1,
      size,
      resolution,
      ...(sources.length
        ? {
            image_urls: sources.map(
              (source) =>
                `data:${source.mimeType};base64,${Buffer.from(source.bytes).toString("base64")}`,
            ),
          }
        : {}),
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!submitted.ok)
    throw new Error(`GPT-Image-2 submission failed: ${submitted.status}`);
  const created = (await submitted.json()) as {
    data?: Array<{ task_id?: string }>;
  };
  const taskId = created.data?.[0]?.task_id;
  if (!taskId) throw new Error("GPT-Image-2 did not return a task ID");
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    await Bun.sleep(2_000);
    const statusResponse = await fetch(
      `${apiMartBaseUrl}/tasks/${encodeURIComponent(taskId)}`,
      {
        headers: { authorization: `Bearer ${apiMartApiKey}` },
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!statusResponse.ok)
      throw new Error(
        `GPT-Image-2 status check failed: ${statusResponse.status}`,
      );
    const status = (await statusResponse.json()) as {
      data?: {
        status?: string;
        result?: { images?: Array<{ url?: string[] }> };
        error?: { message?: string };
      };
    };
    if (status.data?.status === "failed")
      throw new Error(
        status.data.error?.message || "GPT-Image-2 generation failed",
      );
    if (status.data?.status !== "completed") continue;
    const outputUrl = status.data.result?.images?.[0]?.url?.[0];
    if (!outputUrl)
      throw new Error("GPT-Image-2 completed without an output image");
    const image = await fetch(outputUrl, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!image.ok)
      throw new Error(`GPT-Image-2 image download failed: ${image.status}`);
    const mimeType =
      image.headers.get("content-type")?.split(";")[0] || "image/png";
    return `data:${mimeType};base64,${Buffer.from(await image.arrayBuffer()).toString("base64")}`;
  }
  throw new Error("GPT-Image-2 generation timed out");
}

function isLocalCertificateError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /unknown certificate|certificate verification|certificate verify|unable to verify|socket connection was closed unexpectedly|secure TLS connection|TLS handshake/i.test(message);
}

function isProviderNetworkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return isLocalCertificateError(error) || /ECONNRESET|secure TLS connection|fetch failed|TLS handshake/i.test(message);
}

// Local-demo-only fallback for Windows machines where Bun cannot reach a TLS
// endpoint because certificate-revocation lookup is unavailable on the host.
async function callGptImage2WithNode(
  prompt: string,
  parameters: Record<string, unknown>,
  sources: DemoAsset[],
) {
  const node = Bun.which("node");
  if (!node) throw new Error("本机 Node.js 不可用，无法完成 GPT-Image-2 本地 HTTPS 回退请求");
  const script = `
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw);
    const request = (path, init = {}) => fetch(process.env.APIMART_BASE_URL + path, {
      ...init,
      headers: { authorization: \`Bearer \${process.env.APIMART_API_KEY}\`, ...(init.headers || {}) },
    });
    const submitted = await request("/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-image-2", prompt: input.prompt, n: 1,
        size: input.size, resolution: input.resolution,
        ...(input.imageUrls.length ? { image_urls: input.imageUrls } : {}),
      }),
      signal: AbortSignal.timeout(180000),
    });
    const createdText = await submitted.text();
    if (!submitted.ok) throw new Error(\`GPT-Image-2 submission failed: \${submitted.status}: \${createdText.slice(0, 500)}\`);
    const taskId = JSON.parse(createdText).data?.[0]?.task_id;
    if (!taskId) throw new Error("GPT-Image-2 did not return a task ID");
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const statusResponse = await request(\`/tasks/\${encodeURIComponent(taskId)}\`, { signal: AbortSignal.timeout(60000) });
      const statusText = await statusResponse.text();
      if (!statusResponse.ok) throw new Error(\`GPT-Image-2 status check failed: \${statusResponse.status}\`);
      const status = JSON.parse(statusText);
      if (status.data?.status === "failed") throw new Error(status.data?.error?.message || "GPT-Image-2 generation failed");
      if (status.data?.status !== "completed") continue;
      const outputUrl = status.data?.result?.images?.[0]?.url?.[0];
      if (!outputUrl) throw new Error("GPT-Image-2 completed without an output image");
      const image = await fetch(outputUrl, { signal: AbortSignal.timeout(120000) });
      if (!image.ok) throw new Error(\`GPT-Image-2 image download failed: \${image.status}\`);
      const mimeType = image.headers.get("content-type")?.split(";")[0] || "image/png";
      const data = Buffer.from(await image.arrayBuffer()).toString("base64");
      process.stdout.write(JSON.stringify({ mimeType, data }));
      process.exit(0);
    }
    throw new Error("GPT-Image-2 generation timed out");
  `;
  const input = {
    prompt,
    size: normalizeGptImageSize(parameters.size),
    resolution: normalizeGptImageResolution(parameters.resolution),
    imageUrls: sources.map((source) => `data:${source.mimeType};base64,${Buffer.from(source.bytes).toString("base64")}`),
  };
  const child = Bun.spawn([node, "--input-type=module", "-e", script], {
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, APIMART_API_KEY: apiMartApiKey, APIMART_BASE_URL: apiMartBaseUrl },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || "GPT-Image-2 本地 HTTPS 回退请求失败");
  const output = JSON.parse(stdout) as { mimeType?: string; data?: string };
  if (!output.mimeType || !output.data) throw new Error("GPT-Image-2 本地 HTTPS 回退没有返回图片");
  return `data:${output.mimeType};base64,${output.data}`;
}

function normalizeGptImageSize(value: unknown) {
  const size = String(value || "1:1").toLowerCase();
  if (size.includes("16:9") || /^(1824x1024|2048x1152|3840x2160)$/.test(size))
    return "16:9";
  if (size.includes("9:16") || /^(1024x1824|1152x2048|2160x3840)$/.test(size))
    return "9:16";
  if (size.includes("3:2") || size === "1536x1024") return "3:2";
  if (size.includes("2:3") || size === "1024x1536") return "2:3";
  if (size.includes("4:3") || size === "1360x1024") return "4:3";
  if (size.includes("3:4") || size === "1024x1360") return "3:4";
  return "1:1";
}

function normalizeGptImageResolution(value: unknown) {
  const resolution = String(value || "1k").toLowerCase();
  return resolution === "2k" || resolution === "4k" ? resolution : "1k";
}

function readSeamlessParameters(value?: Record<string, unknown>) {
  const readInteger = (key: "cutWidth" | "redrawWidth" | "blurAmount") =>
    Number(value?.[key]);
  const cutWidth = readInteger("cutWidth");
  const redrawWidth = readInteger("redrawWidth");
  const blurAmount = readInteger("blurAmount");
  const redrawStrength = Number(value?.redrawStrength);
  const steps = Number(value?.steps);
  const validInteger = (item: number, max = 2_000) =>
    Number.isInteger(item) && item >= 1 && item <= max;
  if (
    !validInteger(cutWidth) ||
    !validInteger(redrawWidth) ||
    !validInteger(blurAmount) ||
    !Number.isFinite(redrawStrength) ||
    redrawStrength < 0 ||
    redrawStrength > 1 ||
    !validInteger(steps, 100)
  )
    return null;
  return { cutWidth, redrawWidth, blurAmount, redrawStrength, steps };
}

function internalAiStatus() {
  const preview = internalAiConfig.appKey
    ? `${internalAiConfig.appKey.slice(0, 4)}...${internalAiConfig.appKey.slice(-4)}`
    : "";
  return {
    seamlessUrl: internalAiConfig.seamlessUrl,
    hasAppKey: Boolean(internalAiConfig.appKey),
    appKeyPreview: preview,
    updatedAt: internalAiConfig.updatedAt,
    protocol: "app-key-json" as const,
  };
}

async function runInternalAiSeamlessTask(
  task: DemoTask,
  user: DemoTask extends never ? never : (typeof demoAccounts)[number]["user"],
  source: DemoAsset,
  parameters: NonNullable<ReturnType<typeof readSeamlessParameters>>,
) {
  try {
    task.resultUrls = [await callInternalAiSeamless(task, source, parameters)];
    task.status = "success";
  } catch (error) {
    task.status = "failed";
    task.failureReason =
      error instanceof Error ? error.message : "内部 AI 无缝拼接失败";
    user.creditBalance += task.credits;
  }
}

async function callInternalAiSeamless(
  task: Pick<DemoTask, "id">,
  source: Pick<DemoAsset, "bytes">,
  parameters: NonNullable<ReturnType<typeof readSeamlessParameters>>,
) {
  if (!internalAiConfig.seamlessUrl || !internalAiConfig.appKey)
    throw new Error("管理员尚未在服务端配置内部 AI App Key");
  const response = await fetch(internalAiConfig.seamlessUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model_code: "sflxjj",
      task_id: task.id,
      app_key: internalAiConfig.appKey,
      input_image: Buffer.from(source.bytes).toString("base64"),
      ...parameters,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`内部 AI 返回 ${response.status}`);
  const payload = (await response.json()) as {
    data?: { data?: { list?: unknown[] } };
  };
  const output = payload.data?.data?.list?.[0];
  if (typeof output !== "string" || !output.trim())
    throw new Error("内部 AI 未返回图片结果");
  if (/^https?:\/\//i.test(output) || output.startsWith("data:image/"))
    return output;
  const bytes = Buffer.from(output.replace(/^data:[^,]+,/, ""), "base64");
  const mimeType = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : "image/jpeg";
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

const tinyTestImage = {
  bytes: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0VQAAAABJRU5ErkJggg==",
    "base64",
  ),
};
