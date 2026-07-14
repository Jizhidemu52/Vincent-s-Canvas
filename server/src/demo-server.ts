import { authenticateDemoAccount, demoAccounts } from "./demo-accounts";

const sessions = new Map<string, string>();
const modules = ["detail-enhance", "image-edit", "angle-control", "seamless-stitch", "image", "video", "prompts", "assets", "gpt-chat", "canvas", "team", "performance"];
const toolDefinitions = [
    { toolKey: "detail-enhance", label: "细节增强", operationType: "upscale", capabilities: ["upscale", "edit"] },
    { toolKey: "image-edit", label: "图片编辑", operationType: "inpaint", capabilities: ["edit"] },
    { toolKey: "angle-control", label: "角度控制", operationType: "inpaint", capabilities: ["edit"] },
    { toolKey: "seamless-stitch", label: "无缝拼接", operationType: "seamless_stitch", capabilities: ["edit"] },
    { toolKey: "image", label: "文生图", operationType: "image_generation", capabilities: ["generate"] },
    { toolKey: "video", label: "视频创作", operationType: "video_generation", capabilities: ["video"] },
] as const;
const demoProviders: Array<Record<string, unknown>> = [{ id: "30000000-0000-4000-8000-000000000001", name: "本地模拟 API", protocol: "custom", baseUrl: "http://127.0.0.1:3100/mock-provider", enabled: true, hasCredentials: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
const demoModels: Array<Record<string, unknown>> = toolDefinitions.map((tool, index) => ({ id: `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, providerId: demoProviders[0]!.id, providerName: demoProviders[0]!.name, workflowConfigId: null, workflowName: null, replacementModelConfigId: null, name: `${tool.label}模拟模型`, modelId: `demo-${tool.toolKey}`, capabilities: tool.capabilities, creditCost: tool.toolKey === "video" ? 4 : 2, rmbCost: tool.toolKey === "video" ? 0.4 : 0.2, concurrencyLimit: 5, enabled: true }));
const demoPrices: Array<Record<string, unknown>> = Array.from(new Map(toolDefinitions.map((tool) => [tool.operationType, tool])).values()).map((tool, index) => ({ id: `50000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, operationType: tool.operationType, label: tool.label, credits: tool.toolKey === "video" ? 6 : 2, rmbCost: tool.toolKey === "video" ? 0.6 : 0.2, version: 1, status: "published", publishedAt: new Date().toISOString() }));
const demoToolConfigurations = toolDefinitions.map((tool, index) => ({ toolKey: tool.toolKey, modelConfigId: demoModels[index]!.id as string, enabled: true }));
const now = () => new Date().toISOString();
const headers = { "content-type": "application/json; charset=utf-8" };
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });
const empty = (status = 204, extra: Record<string, string> = {}) => new Response(null, { status, headers: extra });

function sessionUser(request: Request) {
    const token = request.headers.get("cookie")?.match(/(?:^|; )wireless_canvas_demo_session=([^;]+)/)?.[1];
    const accountId = token ? sessions.get(token) : null;
    return accountId ? demoAccounts.find((account) => account.id === accountId)?.user || null : null;
}

function publicAccounts() {
    return demoAccounts.map(({ identifier, password, label, portal }) => ({ identifier, password, label, portal }));
}

Bun.serve({
    port: 3100,
    hostname: "127.0.0.1",
    async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        if (path === "/api/health") return json({ status: "ok", mode: "local-demo" });
        if (path === "/api/demo/accounts") return json({ accounts: publicAccounts() });
        if (path === "/api/auth/login" && request.method === "POST") {
            const input = await request.json() as { identifier?: string; password?: string; portal?: "designer" | "admin" };
            const account = authenticateDemoAccount(input.identifier || "", input.password || "", input.portal || "designer");
            if (!account) return json({ error: "INVALID_CREDENTIALS", message: "测试账号、密码或登录入口不匹配" }, 401);
            const token = crypto.randomUUID();
            sessions.set(token, account.id);
            return json({ user: account.user }, 200, { "set-cookie": `wireless_canvas_demo_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800` });
        }
        if (path === "/api/auth/session") {
            const user = sessionUser(request);
            return user ? json({ user }) : json({ error: "UNAUTHORIZED", message: "请先登录" }, 401);
        }
        if (path === "/api/auth/logout" && request.method === "POST") return empty(204, { "set-cookie": "wireless_canvas_demo_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
        if (path === "/api/auth/change-password" && request.method === "POST") return empty();
        const user = sessionUser(request);
        if (!user) return json({ error: "UNAUTHORIZED", message: "请先登录" }, 401);

        if (path === "/api/modules") return json({ modules: modules.map((moduleKey) => ({ moduleKey, enabled: true, updatedAt: now() })) });
        if (path === "/api/models") return json({
            models: demoModels.filter((model) => model.enabled).map(({ id, name, modelId, capabilities, creditCost, rmbCost }) => ({ id, name, modelId, capabilities, creditCost, rmbCost })),
            prices: demoPrices.filter((price) => price.status === "published").map(({ operationType, label, credits, rmbCost, version }) => ({ operationType, label, credits, rmbCost, version })),
            tools: demoToolConfigurations.filter((tool) => tool.enabled),
        });
        if (path === "/api/prompt-templates" && request.method === "GET") return json({ templates: [], total: 0, page: 1, pageSize: 24 });

        if (!user.role.includes("admin")) {
            if (path === "/api/projects") return json({ projects: [] });
            if (path === "/api/assets") return json({ assets: [] });
            if (path === "/api/history") return json({ history: [] });
            if (path === "/api/team" && user.groupRole === "leader") return json({ group: { id: user.groupId, name: user.groupName, code: "VIS-01", departmentName: user.departmentName, memberCount: 3 }, members: [], summary: { taskCount: 0, successCount: 0, credits: 0, rmbCost: 0 } });
            return json({ error: "NOT_FOUND", message: "本地演示接口暂未提供此数据" }, 404);
        }

        if (path === "/api/admin/accounts" && request.method === "GET") return json({ users: demoAccounts.map((account) => account.user) });
        if (/^\/api\/admin\/accounts\/[^/]+\/credits$/.test(path) && request.method === "POST") {
            const id = path.split("/")[4];
            const account = demoAccounts.find((item) => item.id === id);
            const input = await request.json() as { amount?: number };
            if (!account) return json({ message: "账号不存在" }, 404);
            account.user.creditBalance = Math.max(0, account.user.creditBalance + Number(input.amount || 0));
            account.user.temporaryCreditAdjustment += Number(input.amount || 0);
            return json({ user: account.user });
        }
        if (/^\/api\/admin\/accounts\/[^/]+$/.test(path) && request.method === "PATCH") {
            const account = demoAccounts.find((item) => item.id === path.split("/")[4]);
            if (!account) return json({ message: "账号不存在" }, 404);
            Object.assign(account.user, await request.json());
            return json({ user: account.user });
        }
        if (path === "/api/admin/departments") return json({ departments: [{ id: "10000000-0000-4000-8000-000000000001", name: "设计中心", code: "DESIGN", createdAt: now() }] });
        if (path.startsWith("/api/admin/audit-logs")) return json({ auditLogs: [] });
        if (path === "/api/admin/history") return json({ history: [], total: 0, totalCredits: 0, totalRmbCost: 0, page: 1, pageSize: 20 });
        if (path === "/api/admin/history/options") return json({ users: [], models: [], operations: [] });
        if (path === "/api/admin/tasks") return json({ tasks: [] });
        if (path === "/api/admin/tasks/batches") return json({ batches: [] });
        if (path === "/api/admin/groups") return json({ groups: [] });
        if (path === "/api/admin/workflows") return json({ workflows: [] });
        if (path === "/api/admin/model-configuration/providers" && request.method === "GET") return json({ providers: demoProviders });
        if (path === "/api/admin/model-configuration/providers" && request.method === "POST") {
            const input = await request.json() as Record<string, unknown>;
            const provider: Record<string, unknown> = { ...input, id: crypto.randomUUID(), hasCredentials: Boolean(input.credentials), createdAt: now(), updatedAt: now() };
            delete provider.credentials;
            demoProviders.push(provider);
            return json({ provider }, 201);
        }
        if (/^\/api\/admin\/model-configuration\/providers\/[^/]+$/.test(path) && request.method === "PATCH") {
            const provider = demoProviders.find((item) => item.id === path.split("/").at(-1));
            if (!provider) return json({ message: "API 服务不存在" }, 404);
            const input = await request.json() as Record<string, unknown>;
            Object.assign(provider, input, input.credentials ? { hasCredentials: true } : {}, { updatedAt: now() });
            delete provider.credentials;
            return json({ provider });
        }
        if (path === "/api/admin/model-configuration/models" && request.method === "GET") return json({ models: demoModels });
        if (path === "/api/admin/model-configuration/models" && request.method === "POST") {
            const input = await request.json() as Record<string, unknown>;
            const provider = demoProviders.find((item) => item.id === input.providerId);
            const model = { ...input, id: crypto.randomUUID(), providerName: provider?.name || "未知 API", workflowName: null };
            demoModels.push(model);
            return json({ model }, 201);
        }
        if (/^\/api\/admin\/model-configuration\/models\/[^/]+$/.test(path) && request.method === "PATCH") {
            const model = demoModels.find((item) => item.id === path.split("/").at(-1));
            if (!model) return json({ message: "模型不存在" }, 404);
            const input = await request.json() as Record<string, unknown>;
            const provider = demoProviders.find((item) => item.id === input.providerId);
            Object.assign(model, input, provider ? { providerName: provider.name } : {});
            return json({ model });
        }
        if (path === "/api/admin/model-configuration/prices" && request.method === "GET") return json({ prices: demoPrices });
        if (path === "/api/admin/model-configuration/prices" && request.method === "POST") {
            const input = await request.json() as Record<string, unknown>;
            const version = Math.max(0, ...demoPrices.filter((price) => price.operationType === input.operationType).map((price) => Number(price.version))) + 1;
            const price = { ...input, id: crypto.randomUUID(), version, status: "draft" };
            demoPrices.push(price);
            return json({ price }, 201);
        }
        if (/^\/api\/admin\/model-configuration\/prices\/[^/]+\/publish$/.test(path) && request.method === "POST") {
            const id = path.split("/")[5];
            const target = demoPrices.find((price) => price.id === id);
            if (!target) return json({ message: "价格不存在" }, 404);
            demoPrices.forEach((price) => { if (price.operationType === target.operationType && price.status === "published") price.status = "retired"; });
            target.status = "published"; target.publishedAt = now();
            return empty();
        }
        if (/^\/api\/admin\/model-configuration\/prices\/[^/]+\/test$/.test(path) && request.method === "POST") return empty();
        if (path === "/api/admin/model-configuration/tool-configurations" && request.method === "GET") return json({ tools: toolDefinitions.map((definition) => {
            const binding = demoToolConfigurations.find((item) => item.toolKey === definition.toolKey);
            const model = demoModels.find((item) => item.id === binding?.modelConfigId);
            const provider = demoProviders.find((item) => item.id === model?.providerId);
            const price = demoPrices.find((item) => item.operationType === definition.operationType && item.status === "published");
            return { ...definition, ...binding, modelName: model?.name, modelId: model?.modelId, modelCreditCost: model?.creditCost, modelRmbCost: model?.rmbCost, modelEnabled: model?.enabled, providerId: provider?.id, providerName: provider?.name, protocol: provider?.protocol, baseUrl: provider?.baseUrl, providerEnabled: provider?.enabled, hasCredentials: provider?.hasCredentials, workflowConfigId: null, workflowName: null, workflowEnabled: null, price: price ? { operationType: price.operationType, credits: price.credits, rmbCost: price.rmbCost, version: price.version } : null };
        }) });
        if (/^\/api\/admin\/model-configuration\/tool-configurations\/[^/]+$/.test(path) && request.method === "PUT") {
            const selectedTool = path.split("/").at(-1)!;
            const input = await request.json() as { modelConfigId: string; enabled: boolean };
            const existing = demoToolConfigurations.find((item) => item.toolKey === selectedTool);
            if (existing) Object.assign(existing, input); else demoToolConfigurations.push({ toolKey: selectedTool as typeof demoToolConfigurations[number]["toolKey"], ...input });
            return json({ tool: { toolKey: selectedTool, ...input, updatedAt: now() } });
        }
        if (path === "/api/admin/assets") return json({ assets: [] });
        if (path === "/api/admin/projects") return json({ projects: [] });
        if (path === "/api/admin/modules" && request.method === "PATCH") {
            const input = await request.json() as { moduleKey: string; enabled: boolean };
            return json({ module: { ...input, updatedAt: now() } });
        }
        return json({ error: "NOT_FOUND", message: "本地演示接口暂未提供此数据" }, 404);
    },
});

console.log("Local demo API listening on http://127.0.0.1:3100");
