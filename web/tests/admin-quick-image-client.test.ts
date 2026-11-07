import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { generationSubmissionRejected } from "../src/lib/generation-feedback";
import { isQuickImageAction } from "../../shared/quick-image-tools";
import { classifyTaskRecovery } from "../src/services/api/task-result-reconciliation";
import type * as Client from "../src/services/api/admin-quick-image";

const code = ts.transpileModule(readFileSync(new URL("../src/services/api/admin-quick-image.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS } }).outputText;
const options = { expectedOwnerId: "admin-1" };
const configuration = { action: "remove-background", modelConfigId: "model-1", modelId: "test-model", modelName: "Test", prompt: "只提取主体", parameters: {}, configurationVersion: 2, isDefault: false };
const catalog = { configurations: [configuration, { ...configuration, action: "hd-upscale" }, { ...configuration, action: "item-extract" }], models: [{ id: "model-1", name: "Test", modelId: "test-model", providerName: "API", protocol: "openai", capabilities: ["edit"] }] };
const ok = (value: unknown) => Response.json(value);
function harness(handler: (path: string, init: RequestInit) => Response | Promise<Response> = () => ok(catalog)) {
    const state = { status: "authenticated", user: { id: "admin-1", role: "super_admin", status: "active" } };
    const listeners = new Set<() => void>(), calls: Array<{ path: string; init: RequestInit }> = [];
    const requireAdmin = (expectedOwner?: string) => {
        if (state.status !== "authenticated" || state.user.status !== "active" || state.user.role !== "super_admin" || (expectedOwner && expectedOwner !== state.user.id)) throw new Error("超级管理员会话已变化");
        return state.user.id;
    };
    const deps: Record<string, unknown> = {
        "../../../../shared/quick-image-tools": { isQuickImageAction }, "@/lib/generation-feedback": { generationSubmissionRejected },
        "@/stores/use-user-store": { useUserStore: { subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } } },
        "./admin-prompt-recipes": { requirePromptAdmin: requireAdmin },
        "./task-result-reconciliation": { classifyTaskRecovery },
    };
    const module = { exports: {} as typeof Client };
    new Function("require", "module", "exports", "fetch", code)((name: string) => deps[name], module, module.exports, (path: string, init: RequestInit) => { calls.push({ path, init }); return handler(path, init); });
    return { api: module.exports, calls, state, listeners, notify: () => listeners.forEach(listener => listener()) };
}

test("quick-image configuration reads raw owner-bound admin data without frontend persistence", async () => {
    const h = harness();
    expect(await h.api.getAdminQuickImageConfigurations(options)).toEqual(catalog);
    expect(h.calls[0].path).toBe("/api/admin/model-configuration/quick-images");
    expect(h.calls[0].init).toMatchObject({ credentials: "include", cache: "no-store" });
    expect(new Headers(h.calls[0].init.headers).get("X-Canvas-Owner-Id")).toBe("admin-1");
    expect(h.listeners.size).toBe(0);
    expect(code).not.toMatch(/localStorage|sessionStorage|localforage/);
});

test("malformed catalogs and wrapped responses cannot be treated as an empty fallback", async () => {
    for (const value of [{ code: 0, data: catalog }, { ...catalog, configurations: [] }, { ...catalog, configurations: catalog.configurations.slice(0, 2) }, { ...catalog, configurations: [configuration, configuration, catalog.configurations[2]] }, { ...catalog, models: [{}] }]) {
        const h = harness(() => ok(value));
        await expect(h.api.getAdminQuickImageConfigurations(options)).rejects.toThrow("响应无效");
    }
});

test("role, active session and expected owner guard every API before any request", async () => {
    for (const change of [(s: ReturnType<typeof harness>["state"]) => { s.user.role = "designer"; }, (s: ReturnType<typeof harness>["state"]) => { s.user.status = "disabled"; }, (s: ReturnType<typeof harness>["state"]) => { s.status = "guest"; }, (s: ReturnType<typeof harness>["state"]) => { s.user.id = "other"; }]) {
        const h = harness(); change(h.state);
        await expect(h.api.getAdminQuickImageConfigurations(options)).rejects.toThrow("会话已变化");
        expect(h.calls).toHaveLength(0);
    }
});

test("an ABA owner change aborts in-flight private responses", async () => {
    const gate = Promise.withResolvers<Response>(), h = harness(() => gate.promise);
    const pending = h.api.getAdminQuickImageConfigurations(options);
    h.state.user.id = "other"; h.notify(); h.state.user.id = "admin-1"; h.notify();
    gate.resolve(ok(catalog));
    await expect(pending).rejects.toThrow("会话已变化");
    expect(h.calls[0].init.signal?.aborted).toBe(true);
    expect(h.listeners.size).toBe(0);
});

test("saving only PUTs the selected configuration and optimistic version", async () => {
    const h = harness(() => ok({ configuration: { ...configuration, configurationVersion: 3 } }));
    const input = { modelConfigId: "model-1", prompt: "只保留毛线帽", parameters: { quality: "high" }, expectedVersion: 2 };
    await h.api.saveAdminQuickImageConfiguration("remove-background", input, options);
    expect(h.calls.map(call => [call.path, call.init.method, JSON.parse(String(call.init.body))])).toEqual([["/api/admin/model-configuration/quick-images/remove-background", "PUT", input]]);
});

test("draft test sends exactly one POST without save and safely normalizes task acceptance", async () => {
    const accepted = { id: "task-1", requestId: "test-1", status: "waiting" };
    const h = harness(() => ok({ task: accepted }));
    const input = { requestId: "test-1", sourceUrl: "/api/assets/own-source/content", configuration: { modelConfigId: "model-1", prompt: "未保存的主体要求", parameters: { size: "auto" } } };
    expect(await h.api.testAdminQuickImageConfiguration("remove-background", input, options)).toEqual({ task: { ...accepted, resultUrls: [], failureReason: null } });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].path).toEndWith("/remove-background/test");
    expect(h.calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual(input);
});

test("unknown writes never replay and missing lookup remains distinguishable from definitive rejection", async () => {
    const h = harness(() => { throw new TypeError("network lost"); });
    const input = { requestId: "test-1", sourceUrl: "/api/assets/own/content", configuration: { modelConfigId: "model-1", prompt: "test", parameters: {} } };
    await expect(h.api.testAdminQuickImageConfiguration("hd-upscale", input, options)).rejects.toThrow("查询原请求");
    expect(h.calls).toHaveLength(1);
    const missing = harness(() => new Response(JSON.stringify({ message: "not found" }), { status: 404 }));
    expect(await missing.api.findAdminQuickImageTest("original/request", options)).toBeNull();
    expect(missing.calls[0].path).toEndWith("/original%2Frequest");
    expect(missing.calls[0].init.method).toBeUndefined();
    expect(new h.api.AdminQuickImageRequestError("uncertain", 408).definitive).toBe(false);
    expect(new h.api.AdminQuickImageRequestError("failed", 503).definitive).toBe(false);
    expect(new h.api.AdminQuickImageRequestError("bad config", 422).definitive).toBe(true);
});

test("a task from another request cannot replace the original recovery receipt", async () => {
    const h = harness(() => ok({ task: { id: "task-other", requestId: "other", status: "success", resultUrls: [] } }));
    await expect(h.api.findAdminQuickImageTest("original", options)).rejects.toThrow("响应无效");
    expect(h.calls).toHaveLength(1);
});

test("recovery only resumes the same paused task with a known upstream receipt", async () => {
    const original = { id: "task-1", requestId: "request-1", status: "paused", upstreamTaskId: "upstream-1", resultUrls: [], failureReason: null };
    const h = harness(() => ok({ task: { ...original, status: "waiting" }, recovered: true }));
    expect((await h.api.recoverAdminQuickImageTest(original, options)).id).toBe(original.id);
    expect(h.calls.map(call => [call.path, call.init.method])).toEqual([["/api/tasks/task-1/recover", "POST"]]);
    for (const task of [{ ...original, upstreamTaskId: null }, { ...original, status: "success" }, { ...original, status: "waiting" }]) await expect(h.api.recoverAdminQuickImageTest(task, options)).rejects.toThrow("只查询原任务");
    expect(h.calls).toHaveLength(1);
});
