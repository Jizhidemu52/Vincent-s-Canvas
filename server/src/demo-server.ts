import { authenticateDemoAccount, demoAccounts } from "./demo-accounts";
import { apiMartImageModel, buildApiMartImageRequest, runApiMartImageTask } from "./apimart-image";
import { buildGeminiRequestBody, readGeminiResponse } from "./routes/chat";

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
const apiMartApiKey = process.env.APIMART_API_KEY?.trim() || process.env.GPT_IMAGE_2_API_KEY?.trim() || "";
const gptImage2ProviderId = "30000000-0000-4000-8000-000000000002";
const gptImage2ModelId = "40000000-0000-4000-8000-000000000099";
const happyHorseModelId = "40000000-0000-4000-8000-000000000100";
const geminiProviderId = "30000000-0000-4000-8000-000000000003";
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
    enabled: true,
  }),
);
if (apiMartApiKey) {
  demoProviders.push({
    id: gptImage2ProviderId,
    name: "APIMart 图片服务",
    protocol: "apimart",
    baseUrl: apiMartBaseUrl,
    enabled: true,
    hasCredentials: true,
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
    name: "GPT-Image-2",
    modelId: "gpt-image-2",
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
  demoModels.push({
    id: happyHorseModelId,
    providerId: gptImage2ProviderId,
    providerName: "APIMart",
    workflowConfigId: "happyhorse-1.0",
    workflowName: "HappyHorse 1.0 async",
    replacementModelConfigId: null,
    name: "HappyHorse 1.0",
    modelId: "happyhorse-1.0",
    capabilities: ["video"],
    creditCost: 0,
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
    hasCredentials: true,
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
      ? happyHorseModelId
      : tool.toolKey === "image" && apiMartApiKey
        ? gptImage2ModelId
        : demoModels[index]!.id as string,
  enabled: true,
}));
type DemoAsset = {
  id: string;
  ownerUserId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  createdAt: string;
  clientReferenceId?: string;
};
type DemoTask = {
  id: string;
  requestId: string;
  ownerUserId: string;
  operationType: string;
  status: "processing" | "success" | "failed";
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
const demoTasks = new Map<string, DemoTask>();
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
    : null;
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

async function callDemoGemini(input: { input: DemoResponseInput[]; tools: DemoResponseTool[]; toolChoice?: unknown; webSearch?: boolean }) {
  const endpoint = `${apiMartBaseUrl.replace(/\/v1$/, "")}/v1beta/models/gemini-3.1-pro-preview:generateContent`;
  const body = buildGeminiRequestBody(input);
  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${apiMartApiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    if (!upstream.ok) throw new Error(`Gemini Provider ${upstream.status}: ${(await upstream.text()).slice(0, 500)}`);
    return readGeminiResponse(await upstream.json() as DemoGeminiPayload);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("socket connection was closed unexpectedly")) throw error;
    return readGeminiResponse(await callDemoGeminiWithNode(endpoint, body));
  }
}

// This is local-demo-only: Windows hosts without certificate-revocation access can make Bun fetch fail.
async function callDemoGeminiWithNode(endpoint: string, body: unknown): Promise<DemoGeminiPayload> {
  const node = Bun.which("node");
  if (!node) throw new Error("本机 Node.js 不可用，无法完成 Gemini 本地 HTTPS 回退请求");
  const script = `
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const response = await fetch(process.env.APIMART_ENDPOINT, {
      method: "POST",
      headers: { authorization: \`Bearer \${process.env.APIMART_API_KEY}\`, "content-type": "application/json" },
      body: input,
      signal: AbortSignal.timeout(180000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(\`Gemini Provider \${response.status}: \${text.slice(0, 500)}\`);
    process.stdout.write(text);
  `;
  const child = Bun.spawn([node, "--input-type=module", "-e", script], {
    stdin: new Blob([JSON.stringify(body)]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, APIMART_API_KEY: apiMartApiKey, APIMART_ENDPOINT: endpoint },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || "Gemini 本地 HTTPS 回退请求失败");
  return JSON.parse(stdout) as DemoGeminiPayload;
}

Bun.serve({
  port: 3100,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/api/health")
      return json({ status: "ok", mode: "local-demo" });
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
      );
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
    if (path === "/api/models")
      return json({
        models: demoModels
          .filter((model) => model.enabled)
          .map(({ id, name, modelId, capabilities, creditCost, rmbCost }) => ({
            id,
            name,
            modelId,
            capabilities,
            creditCost,
            rmbCost,
          })),
        prices: demoPrices
          .filter((price) => price.status === "published")
          .map(({ operationType, label, credits, rmbCost, version }) => ({
            operationType,
            label,
            credits,
            rmbCost,
            version,
          })),
        tools: demoToolConfigurations.filter((tool) => tool.enabled),
      });
    if (path === "/api/chat/responses" && request.method === "POST") {
      const input = (await request.json()) as {
        modelId?: string;
        input?: DemoResponseInput[];
        tools?: DemoResponseTool[];
        toolChoice?: unknown;
        webSearch?: boolean;
      };
      if (input.modelId !== "gemini-3.1-pro-preview")
        return json({ error: "MODEL_DISABLED", message: "管理员尚未启用该对话模型" }, 400);
      if (!apiMartApiKey)
        return json({ error: "PROVIDER_NOT_CONFIGURED", message: "本地服务端尚未配置 APIMart 密钥" }, 503);
      try {
        return json(await callDemoGemini({ input: input.input || [], tools: input.tools || [], toolChoice: input.toolChoice, webSearch: input.webSearch }));
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
      };
      if (!input.mimeType?.startsWith("image/"))
        return json(
          { error: "INVALID_ASSET", message: "无缝拼接测试只支持图片文件" },
          400,
        );
      if (
        !Number.isFinite(input.byteSize) ||
        Number(input.byteSize) <= 0 ||
        Number(input.byteSize) > 15 * 1024 * 1024
      )
        return json(
          { error: "INVALID_ASSET_SIZE", message: "图片大小必须在 15MB 以内" },
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
      if (!bytes.byteLength || bytes.byteLength > 15 * 1024 * 1024)
        return json(
          { error: "INVALID_ASSET_SIZE", message: "图片大小必须在 15MB 以内" },
          400,
        );
      asset.bytes = bytes;
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
      return new Response(Uint8Array.from(asset.bytes).buffer, {
        headers: {
          "content-type": asset.mimeType,
          "cache-control": "private, max-age=60",
        },
      });
    }
    if (path === "/api/tasks" && request.method === "POST") {
      const input = (await request
        .clone()
        .json()
        .catch(() => ({}))) as {
        requestId?: string;
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
            item.modelId === "happyhorse-1.0" &&
            item.enabled,
        );
        if (!model)
          return json(
            {
              error: "MODEL_DISABLED",
              message: "HappyHorse 1.0 is not enabled for video creation",
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
                message: "A selected video reference is unavailable",
              },
              400,
            );
          sources.push(source);
        }
        const parameters = readHappyHorseParameters(input.parameters);
        const validationError = validateHappyHorseRequest(parameters, sources);
        if (validationError)
          return json({ error: "INVALID_VIDEO_INPUT", message: validationError }, 400);
        const price = demoPrices.find(
          (item) =>
            item.operationType === "video_generation" &&
            item.status === "published",
        );
        const credits =
          Number(price?.credits || 0) + Number(model.creditCost || 0);
        if (user.creditBalance < credits)
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
          credits,
          createdAt: now(),
        };
        demoTasks.set(task.id, task);
        user.creditBalance -= credits;
        void runHappyHorseTask(task, user, input.prompt || "", parameters, sources);
        return json({ task }, 201);
      }
      if (
        ["image_generation", "inpaint", "upscale"].includes(
          input.operationType || "",
        )
      ) {
        if (!apiMartApiKey)
          return json(
            {
              error: "PROVIDER_NOT_CONFIGURED",
              message: "GPT-Image-2 service credential is not configured",
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
            apiMartImageModel(item.modelId) &&
            item.enabled,
        );
        if (!model)
          return json(
            {
              error: "MODEL_DISABLED",
              message: "所选 APIMart 图片模型未启用",
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
        if (sources.length > (imageModelId === "gpt-image-2" ? 16 : imageModelId === "midjourney" ? 0 : imageModelId === "midjourney-blend" ? 4 : 14))
          return json(
            {
              error: "TOO_MANY_REFERENCES",
              message: imageModelId === "gpt-image-2" ? "GPT-Image-2 最多支持 16 张参考图" : imageModelId === "midjourney" ? "Midjourney 文生图不支持上传参考图" : "Gemini 3.1 Flash 最多支持 14 张参考图",
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
        const credits =
          Number(price?.credits || 0) + Number(model.creditCost || 0);
        if (user.creditBalance < credits)
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
        demoTasks.set(task.id, task);
        user.creditBalance -= credits;
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
            message: "本地演示任务目前仅开放无缝拼接",
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
      const credits =
        Number(price?.credits || 0) + Number(model.creditCost || 0);
      if (user.creditBalance < credits)
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
      user.creditBalance -= credits;
      void runInternalAiSeamlessTask(task, user, source, parameters);
      return json({ task }, 201);
    }
    if (path === "/api/tasks" && request.method === "GET")
      return json({
        tasks: Array.from(demoTasks.values())
          .filter((task) => task.ownerUserId === user.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      });

    if (!user.role.includes("admin")) {
      if (path === "/api/projects") return json({ projects: [] });
      if (path === "/api/assets") return json({ assets: [] });
      if (path === "/api/history") return json({ history: [] });
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
      const provider: Record<string, unknown> = {
        ...input,
        id: crypto.randomUUID(),
        hasCredentials: Boolean(input.credentials),
        createdAt: now(),
        updatedAt: now(),
      };
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
      Object.assign(
        provider,
        input,
        input.credentials ? { hasCredentials: true } : {},
        { updatedAt: now() },
      );
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

console.log("Local demo API listening on http://127.0.0.1:3100");

async function runApiMartImageTaskForDemo(
  task: DemoTask,
  user: (typeof demoAccounts)[number]["user"],
  modelId: string,
  prompt: string,
  parameters: Record<string, unknown>,
  sources: DemoAsset[],
) {
  try {
    task.resultUrls = [await callApiMartImage(modelId, prompt, parameters, sources)];
    task.status = "success";
  } catch (error) {
    task.status = "failed";
    task.failureReason = isProviderNetworkError(error)
      ? "无法与图像服务建立安全连接。请检查服务器外网、TLS 证书策略或稍后重试；本次积分已自动退还。"
      : error instanceof Error ? error.message : "APIMart 图片任务失败";
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

type HappyHorseParameters = {
  mode: "text" | "first-frame" | "reference" | "edit";
  duration: number;
  size: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  resolution: "720P" | "1080P";
  watermark: boolean;
  audioSetting: "auto" | "origin";
};

async function runHappyHorseTask(
  task: DemoTask,
  user: (typeof demoAccounts)[number]["user"],
  prompt: string,
  parameters: HappyHorseParameters,
  sources: DemoAsset[],
) {
  try {
    task.resultUrls = [await callHappyHorse(prompt, parameters, sources)];
    task.status = "success";
  } catch (error) {
    task.status = "failed";
    task.failureReason =
      error instanceof Error ? error.message : "HappyHorse task failed";
    user.creditBalance += task.credits;
  }
}

async function callHappyHorse(
  prompt: string,
  parameters: HappyHorseParameters,
  sources: DemoAsset[],
) {
  const imageSources = sources.filter((source) => source.mimeType.startsWith("image/"));
  const videoSource = sources.find((source) => source.mimeType.startsWith("video/"));
  const uploadedImageUrls = await Promise.all(imageSources.map(uploadHappyHorseImage));
  const body: Record<string, unknown> = {
    model: "happyhorse-1.0",
    prompt,
    resolution: parameters.resolution,
    watermark: parameters.watermark,
  };
  if (parameters.mode === "first-frame") {
    body.first_frame_image = uploadedImageUrls[0];
  } else if (parameters.mode === "reference") {
    body.image_urls = uploadedImageUrls;
  } else if (parameters.mode === "edit") {
    if (!videoSource) throw new Error("A source video is required for video editing");
    // The upstream service needs a URL it can fetch. Demo assets are private to
    // this local server, so an object-storage public URL is required in production.
    throw new Error("Video editing requires a publicly reachable HTTPS source video URL. Configure company object storage before using this mode.");
  }
  if (parameters.mode === "text" || parameters.mode === "reference") {
    body.size = parameters.size;
    body.duration = parameters.duration;
  }
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
    throw new Error(
      `HappyHorse submission failed: ${submitted.status}${await providerErrorDetail(submitted)}`,
    );
  const created = (await submitted.json()) as {
    data?: Array<{ task_id?: string }>;
  };
  const taskId = created.data?.[0]?.task_id;
  if (!taskId) throw new Error("HappyHorse did not return a task ID");
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    await Bun.sleep(2_000);
    const statusResponse = await fetch(
      `${apiMartBaseUrl}/tasks/${encodeURIComponent(taskId)}?language=zh`,
      {
        headers: { authorization: `Bearer ${apiMartApiKey}` },
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!statusResponse.ok)
      throw new Error(
        `HappyHorse status check failed: ${statusResponse.status}`,
      );
    const status = (await statusResponse.json()) as {
      data?: {
        status?: string;
        result?: { videos?: unknown[] };
        error?: { message?: string };
      };
    };
    if (["failed", "cancelled"].includes(status.data?.status || ""))
      throw new Error(status.data?.error?.message || "HappyHorse generation failed");
    if (status.data?.status !== "completed") continue;
    const outputUrl = extractHappyHorseVideoUrl(status.data?.result?.videos);
    if (!outputUrl) throw new Error("HappyHorse completed without an output video");
    return outputUrl;
  }
  throw new Error("HappyHorse generation timed out");
}

function readHappyHorseParameters(
  value?: Record<string, unknown>,
): HappyHorseParameters {
  const mode = ["text", "first-frame", "reference", "edit"].includes(
    String(value?.happyHorseMode),
  )
    ? (value!.happyHorseMode as HappyHorseParameters["mode"])
    : "text";
  const duration = Math.floor(Number(value?.seconds) || 5);
  const size = String(value?.size || "16:9");
  return {
    mode,
    duration: Math.max(3, Math.min(15, duration)),
    size: (["16:9", "9:16", "1:1", "4:3", "3:4"].includes(size)
      ? size
      : "16:9") as HappyHorseParameters["size"],
    resolution: String(value?.resolution).toUpperCase() === "720P" ? "720P" : "1080P",
    watermark: value?.watermark === true,
    audioSetting: value?.audioSetting === "origin" ? "origin" : "auto",
  };
}

function validateHappyHorseRequest(
  parameters: HappyHorseParameters,
  sources: DemoAsset[],
) {
  const images = sources.filter((source) => source.mimeType.startsWith("image/"));
  const videos = sources.filter((source) => source.mimeType.startsWith("video/"));
  if (parameters.mode === "text" && sources.length) return "Text-to-video cannot include reference media";
  if (parameters.mode === "first-frame" && (images.length !== 1 || videos.length)) return "First-frame mode requires exactly one image";
  if (parameters.mode === "reference" && (images.length < 1 || images.length > 9 || videos.length)) return "Reference mode requires 1-9 images";
  if (parameters.mode === "edit" && (videos.length !== 1 || images.length > 5)) return "Edit mode requires one source video and up to five reference images";
  if (images.some((source) => source.bytes.byteLength > 10 * 1024 * 1024)) return "Each image must be 10MB or smaller";
  if (videos.some((source) => source.bytes.byteLength > 100 * 1024 * 1024)) return "The source video must be 100MB or smaller";
  return "";
}

async function uploadHappyHorseImage(source: DemoAsset) {
  const form = new FormData();
  const bytes = new Uint8Array(source.bytes.byteLength);
  bytes.set(source.bytes);
  form.set(
    "file",
    new File([bytes.buffer], source.filename, { type: source.mimeType }),
  );
  const response = await fetch(`${apiMartBaseUrl}/uploads/images`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiMartApiKey}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    throw new Error(
      `HappyHorse image upload failed: ${response.status}${await providerErrorDetail(response)}`,
    );
  const uploaded = (await response.json()) as { url?: unknown };
  if (typeof uploaded.url !== "string" || !/^https?:\/\//.test(uploaded.url))
    throw new Error("HappyHorse image upload did not return an HTTP URL");
  return uploaded.url;
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
