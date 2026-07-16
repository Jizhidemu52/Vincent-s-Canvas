import { authenticateDemoAccount, demoAccounts } from "./demo-accounts";

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
    name: "GPT-Image-2",
    protocol: "custom",
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
  modelConfigId: tool.toolKey === "video" && apiMartApiKey ? happyHorseModelId : demoModels[index]!.id as string,
  enabled: true,
}));
type DemoAsset = {
  id: string;
  ownerUserId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  createdAt: string;
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
    if (path === "/api/prompt-templates" && request.method === "GET")
      return json({ templates: [], total: 0, page: 1, pageSize: 24 });

    if (path === "/api/assets/upload-request" && request.method === "POST") {
      const input = (await request.json()) as {
        filename?: string;
        mimeType?: string;
        byteSize?: number;
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
      const assetId = crypto.randomUUID();
      demoAssets.set(assetId, {
        id: assetId,
        ownerUserId: user.id,
        filename: input.filename || "source-image",
        mimeType: input.mimeType,
        bytes: new Uint8Array(),
        createdAt: now(),
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
            item.modelId === "gpt-image-2" &&
            item.enabled,
        );
        if (!model)
          return json(
            {
              error: "MODEL_DISABLED",
              message: "GPT-Image-2 is not enabled for this tool",
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
        if (sources.length > 16)
          return json(
            {
              error: "TOO_MANY_REFERENCES",
              message: "GPT-Image-2 accepts at most 16 reference images",
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
        void runGptImage2Task(
          task,
          user,
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

async function runGptImage2Task(
  task: DemoTask,
  user: (typeof demoAccounts)[number]["user"],
  prompt: string,
  parameters: Record<string, unknown>,
  sources: DemoAsset[],
) {
  try {
    task.resultUrls = [await callGptImage2(prompt, parameters, sources)];
    task.status = "success";
  } catch (error) {
    task.status = "failed";
    task.failureReason =
      error instanceof Error ? error.message : "GPT-Image-2 task failed";
    user.creditBalance += task.credits;
  }
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
  const body: Record<string, unknown> = {
    model: "happyhorse-1.0",
    prompt,
    resolution: parameters.resolution,
    watermark: parameters.watermark,
  };
  if (parameters.mode === "first-frame") {
    body.first_frame_image = assetDataUrl(imageSources[0]!);
  } else if (parameters.mode === "reference") {
    body.image_urls = imageSources.map(assetDataUrl);
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

function assetDataUrl(source: DemoAsset) {
  return `data:${source.mimeType};base64,${Buffer.from(source.bytes).toString("base64")}`;
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
