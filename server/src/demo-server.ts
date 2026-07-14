import { authenticateDemoAccount, demoAccounts } from "./demo-accounts";

const sessions = new Map<string, string>();
const modules = ["detail-enhance", "image-edit", "angle-control", "seamless-stitch", "image", "video", "prompts", "assets", "gpt-chat", "canvas", "team", "performance"];
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
            models: [{ id: "demo-image", name: "测试图片模型", modelId: "demo-image-v1", capabilities: ["generate", "edit", "batch"], creditCost: 2, rmbCost: 0.2 }],
            prices: [
                { operationType: "image_generation", label: "生成图片", credits: 2, rmbCost: 0.2, version: 1 },
                { operationType: "image_edit", label: "图片编辑", credits: 2, rmbCost: 0.2, version: 1 },
                { operationType: "batch_edit", label: "批量改图", credits: 2, rmbCost: 0.2, version: 1 },
                { operationType: "seamless_stitch", label: "无缝拼接", credits: 2, rmbCost: 0.2, version: 1 },
            ],
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
        if (path === "/api/admin/model-configuration/providers") return json({ providers: [] });
        if (path === "/api/admin/model-configuration/models") return json({ models: [] });
        if (path === "/api/admin/model-configuration/prices") return json({ prices: [] });
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
