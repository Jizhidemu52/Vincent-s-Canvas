import { afterEach, expect, test } from "bun:test";
import { deploymentFeatures } from "@/lib/deployment-features";
import { getQueuedTask, listQueuedTasks } from "@/services/api/generation-tasks";
import { requestImageQuestion } from "@/services/api/image";
import { defaultConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { workspaceOwnerHeaders } from "@/services/api/workspace-owner";

const originalFetch = globalThis.fetch;
const originalFeatures = { ...deploymentFeatures };
const originalSession = { user: useUserStore.getState().user, status: useUserStore.getState().status };

test("personal super-admin requests carry only their own owner while department admins remain blocked", () => {
    deploymentFeatures.authenticationEnabled = true;
    useUserStore.setState({ user: { id: "admin-owner", role: "super_admin" } as never, status: "authenticated" });
    expect(workspaceOwnerHeaders()).toEqual({ "X-Canvas-Owner-Id": "admin-owner" });
    useUserStore.setState({ user: { id: "department-owner", role: "department_admin" } as never, status: "authenticated" });
    expect(() => workspaceOwnerHeaders()).toThrow();
});
afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.assign(deploymentFeatures, originalFeatures);
    useUserStore.setState(originalSession);
});

test("task and chat HTTP requests bind the displayed employee instead of trusting only a shared cookie", async () => {
    deploymentFeatures.authenticationEnabled = true;
    deploymentFeatures.oaLoginEnabled = false;
    useUserStore.setState({ user: { id: "employee-a", role: "designer" } as never, status: "authenticated" });
    const requests: Array<{ path: string; owner: string | null }> = [];
    globalThis.fetch = (async (path, init) => {
        requests.push({ path: String(path), owner: new Headers(init?.headers).get("X-Canvas-Owner-Id") });
        if (path === "/api/models") return Response.json({ models: [{ id: "chat-model", modelId: "test-model", name: "Test chat", capabilities: ["chat"], creditCost: 0, rmbCost: 0 }], tools: [{ toolKey: "gpt-chat", modelConfigId: "chat-model", enabled: true }], prices: [] });
        return Response.json({ task: { id: "task-a" }, tasks: [], content: "verified", toolCalls: [] });
    }) as typeof fetch;
    await getQueuedTask("task-a");
    await listQueuedTasks();
    await requestImageQuestion({ ...defaultConfig, model: "test-model" }, [{ role: "user", content: "test" }], () => undefined);
    expect(requests).toEqual([
        { path: "/api/tasks/task-a", owner: "employee-a" },
        { path: "/api/tasks?limit=60", owner: "employee-a" },
        { path: "/api/models", owner: null },
        { path: "/api/chat/responses", owner: "employee-a" },
    ]);
    useUserStore.setState({ user: null, status: "guest" });
    await expect(getQueuedTask("task-a")).rejects.toThrow("员工会话已变化");
    expect(requests).toHaveLength(4);
});
