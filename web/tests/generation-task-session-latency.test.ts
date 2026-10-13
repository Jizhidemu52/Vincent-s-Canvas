import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { deploymentFeatures } from "../src/lib/deployment-features";
import type { ApiUser } from "../src/services/api/auth";
import { QueuedTaskFailedError, recoverQueuedMedia, requestQueuedImageBatch, requestQueuedImages, type QueuedTask } from "../src/services/api/generation-tasks";
import { useUserStore } from "../src/stores/use-user-store";

const originalFetch = globalThis.fetch;
const globals = globalThis as unknown as Record<string, unknown>;
const originalWindow = globals.window;
const originalUserState = useUserStore.getState();
const originalFeatures = { ...deploymentFeatures };
const employee: ApiUser = {
    id: "employee-a", username: "employee-a", displayName: "Designer", role: "designer", status: "active",
    email: null, employeeNo: null, departmentId: null, departmentName: null, groupId: null, groupName: null, groupRole: null,
    mustChangePassword: false, mfaEnabled: false, creditBalance: 0, creditLimit: 0, monthlyCreditLimit: 0,
    temporaryCreditAdjustment: 0, creditPeriodStart: "", creditResetAt: "",
};
const model = { id: "model-1", name: "Test model", modelId: "test-model", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 };
const completedTask: QueuedTask = { id: "task-1", requestId: "request-1:0", status: "success", resultUrls: ["/api/assets/result/content"], failureReason: null };
const paths = ["image", "batch", "recovery"] as const;
type Path = typeof paths[number];

beforeEach(() => {
    globals.window = { location: { pathname: "/canvas/project-1" }, setTimeout, clearTimeout };
    Object.assign(deploymentFeatures, { oaLoginEnabled: true, creditsEnabled: false });
    useUserStore.getState().updateUser(employee);
});
afterEach(() => {
    // Invalidate pending hydration before restoring globals so late responses cannot affect another test.
    useUserStore.getState().updateUser(employee);
    useUserStore.setState(originalUserState);
    Object.assign(deploymentFeatures, originalFeatures);
    globalThis.fetch = originalFetch;
    globals.window = originalWindow;
});

function controlledNetwork(phase: "initial" | "final", options: { task?: QueuedTask; pollError?: Error; abort?: AbortController } = {}) {
    const sessions: ReturnType<typeof Promise.withResolvers<Response>>[] = [];
    const cancellations: string[] = [];
    const task = options.task || completedTask;
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        const method = init?.method || "GET";
        if (path === "/api/models") return Response.json({ models: [model] });
        if (path === "/api/assets/upload-request") return Response.json({ assetId: "reference-1", uploadUrl: null });
        if (path === "/api/tasks" && method === "POST") return Response.json({ task: { id: task.id } });
        if (path === "/api/tasks/batch") return Response.json({ batchId: "batch-1", tasks: [{ id: task.id, itemIndex: 0 }], failures: [] });
        if (path === `/api/tasks/${task.id}/recover`) return Response.json({ task: { ...task, status: "running" }, recovered: true });
        if (path.endsWith("/cancel")) {
            cancellations.push(path);
            return Response.json({ changed: 1 });
        }
        if (path === "/api/auth/session") {
            const pending = Promise.withResolvers<Response>();
            sessions.push(pending);
            if (phase === "final" && sessions.length === 1) pending.resolve(Response.json({ user: employee }));
            return pending.promise;
        }
        if (path === `/api/tasks/${task.id}` || (path === "/api/tasks" && method === "GET")) {
            // Let the first real hydration finish, so finally must start a distinct final refresh.
            if (phase === "final") await useUserStore.getState().hydrateSession();
            if (options.abort) {
                options.abort.abort();
                throw new DOMException("请求已取消", "AbortError");
            }
            if (options.pollError) throw options.pollError;
            return Response.json(path === "/api/tasks" ? { tasks: [task] } : { task });
        }
        throw new Error(`Unexpected HTTP ${method} ${path}`);
    }) as typeof fetch;
    return { sessions, cancellations };
}

function run(path: Path, signal?: AbortSignal) {
    if (path === "batch") return requestQueuedImageBatch({ modelId: model.id, prompt: "test", files: [{ file: new File(["reference"], "reference.png", { type: "image/png" }), title: "reference" }], signal });
    if (path === "recovery") return recoverQueuedMedia(completedTask.id, signal);
    return requestQueuedImages({ modelId: model.id, prompt: "test", count: 1, operationType: "image_generation", requestId: "request-1", signal });
}

async function promptly<T>(pending: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            pending,
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Task completion is blocked by session refresh")), 500); }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

describe("generation results do not wait for session refresh", () => {
    for (const phase of ["initial", "final"] as const) {
        test.each(paths)(`%s completes while the ${phase} session request never resolves`, async path => {
            const network = controlledNetwork(phase);
            // Recovery has no submission-time refresh; seed the in-flight one for that case.
            if (path === "recovery" && phase === "initial") void useUserStore.getState().hydrateSession();
            const result = await promptly(run(path));
            if (path === "batch") expect(result).toMatchObject({ batchId: "batch-1", tasks: [{ ...completedTask, itemIndex: 0 }], failures: [] });
            else if (path === "recovery") expect(result).toEqual(["/api/assets/result/content"]);
            else expect(result).toMatchObject([{ dataUrl: "/api/assets/result/content", sourceTaskId: "task-1" }]);
            expect(network.sessions).toHaveLength(phase === "final" ? 2 : 1);
            expect(network.cancellations).toEqual([]);
        });
    }

    test.each(paths)("%s preserves the original query error while session refresh is pending", async path => {
        const originalError = new Error("original task query failed");
        controlledNetwork("initial", { pollError: originalError });
        await expect(promptly(run(path))).rejects.toBe(originalError);
    });

    test.each(paths)("%s still cancels on abort without waiting for session refresh", async path => {
        const controller = new AbortController();
        const network = controlledNetwork("initial", { abort: controller });
        await expect(promptly(run(path, controller.signal))).rejects.toMatchObject({ name: "AbortError" });
        expect(network.cancellations).toEqual([path === "batch" ? "/api/tasks/batches/batch-1/cancel" : "/api/tasks/task-1/cancel"]);
    });

    test.each(["image", "recovery"] as const)("%s preserves a failed task and its reason while session refresh is pending", async path => {
        const task = { ...completedTask, status: "failed", resultUrls: [], failureReason: "provider failed" };
        controlledNetwork("initial", { task });
        const error = await promptly(run(path)).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(QueuedTaskFailedError);
        expect((error as QueuedTaskFailedError).task).toEqual(task);
        expect((error as Error).message).toBe("provider failed");
    });

    test("batch still returns failed item records instead of converting them to a request error", async () => {
        const task = { ...completedTask, status: "failed", resultUrls: [], failureReason: "provider failed" };
        controlledNetwork("initial", { task });
        expect(await promptly(run("batch"))).toMatchObject({ tasks: [{ ...task, itemIndex: 0 }], failures: [] });
    });

    test.each(["updated", "unauthorized", "offline"] as const)("background refresh still handles %s sessions with credits disabled", async outcome => {
        const network = controlledNetwork("initial");
        await promptly(run("image"));
        const refresh = useUserStore.getState().hydrateSession();
        if (outcome === "offline") network.sessions[0]!.reject(new TypeError("offline"));
        else network.sessions[0]!.resolve(outcome === "unauthorized"
            ? Response.json({}, { status: 401 })
            : Response.json({ user: { ...employee, displayName: "Updated designer", creditBalance: 42 } }));
        await refresh;
        if (outcome === "unauthorized") {
            expect(useUserStore.getState().user).toBeNull();
            expect(useUserStore.getState().status).toBe("guest");
        } else {
            expect(useUserStore.getState().user).toMatchObject({ id: "employee-a", displayName: outcome === "updated" ? "Updated designer" : "Designer", creditBalance: outcome === "updated" ? 42 : 0 });
            expect(useUserStore.getState().status).toBe("authenticated");
        }
    });
});
