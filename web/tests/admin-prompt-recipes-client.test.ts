import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as contracts from "../../shared/prompt-contracts";
import * as tasks from "../../shared/task-contracts";
import type * as Client from "../src/services/api/admin-prompt-recipes";

const code = ts.transpileModule(readFileSync(new URL("../src/services/api/admin-prompt-recipes.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS } }).outputText;
const ok = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const options = { expectedOwnerId: "admin-1" };
function harness(handler: (path: string, init: RequestInit) => Response | Promise<Response> = () => ok({ recipes: [], models: [] })) {
    const state = { status: "authenticated", user: { id: "admin-1", role: "super_admin", status: "active" } };
    const listeners = new Set<() => void>();
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const dependencies: Record<string, unknown> = {
        "@/stores/use-user-store": {
            useUserStore: {
                getState: () => state,
                subscribe: (listener: () => void) => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
            },
        },
        "../../../../shared/prompt-contracts": contracts,
        "../../../../shared/task-contracts": tasks,
    };
    const module = { exports: {} as typeof Client };
    new Function("require", "module", "exports", "fetch", code)(
        (name: string) => dependencies[name],
        module,
        module.exports,
        (path: string, init: RequestInit) => {
            calls.push({ path, init });
            return handler(path, init);
        },
    );
    return { api: module.exports, state, calls, listeners, notify: () => listeners.forEach((listener) => listener()) };
}

test("admin recipe transport is no-store, session bound, raw JSON, and never writes local storage", async () => {
    const h = harness();
    expect(await h.api.listAdminPromptRecipes(options)).toEqual({ recipes: [], models: [] });
    expect(h.calls[0].init.credentials).toBe("include");
    expect(h.calls[0].init.cache).toBe("no-store");
    expect(new Headers(h.calls[0].init.headers).get("X-Canvas-Owner-Id")).toBe("admin-1");
    expect(h.listeners.size).toBe(0);
    expect(code).not.toContain("localforage");
    expect(code).not.toContain("localStorage");
});

test("designer, department admin, guest, inactive and stale-owner reads cannot send a request", async () => {
    for (const role of ["designer", "department_admin"]) {
        const h = harness();
        h.state.user.role = role;
        await expect(h.api.listAdminPromptRecipes(options)).rejects.toThrow("超级管理员");
        expect(h.calls).toHaveLength(0);
    }
    const h = harness();
    h.state.status = "guest";
    await expect(h.api.listAdminPromptRecipes(options)).rejects.toThrow("超级管理员");
    h.state.status = "authenticated";
    h.state.user.status = "disabled";
    await expect(h.api.listAdminPromptRecipes(options)).rejects.toThrow("超级管理员");
    h.state.user.status = "active";
    await expect(h.api.listAdminPromptRecipes({ expectedOwnerId: "admin-2" })).rejects.toThrow("超级管理员");
    expect(h.calls).toHaveLength(0);
});

test("ABA identity changes and response-body changes reject private content and unsubscribe", async () => {
    const gate = Promise.withResolvers<Response>(),
        h = harness(() => gate.promise);
    const pending = h.api.listAdminPromptRecipes(options);
    h.state.user.id = "admin-2";
    h.notify();
    h.state.user.id = "admin-1";
    h.notify();
    gate.resolve(ok({ recipes: [{ systemPrompt: "private" }], models: [] }));
    await expect(pending).rejects.toThrow("会话已变化");
    expect(h.calls[0].init.signal!.aborted).toBe(true);
    expect(h.listeners.size).toBe(0);
    const body = Promise.withResolvers<unknown>();
    const response = ok({});
    response.json = () => body.promise;
    const b = harness(() => response),
        read = b.api.listAdminPromptRecipes(options);
    await Promise.resolve();
    b.state.user.role = "designer";
    b.notify();
    body.resolve({ recipes: ["private"] });
    await expect(read).rejects.toThrow("超级管理员");
    expect(b.listeners.size).toBe(0);
});

test("saving a version does not activate it and settings are schema-filtered", async () => {
    const h = harness(() => ok({ version: { id: "version-2" } }));
    await h.api.createAdminPromptVersion("field/key", { systemPrompt: "system", fieldTemplate: "", modelOverrides: {}, fallbackPrompt: "", outputLanguage: "en", changeNote: "note" }, options);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].path).toBe("/api/admin/prompt-recipes/field%2Fkey/versions");
    await h.api.activateAdminPromptVersion("field/key", "version-1", options);
    expect(h.calls[1].path).toEndWith("/activate");
    expect(JSON.parse(String(h.calls[1].init.body))).toEqual({ versionId: "version-1" });
    await h.api.updateAdminPromptRecipe("field/key", { name: "recipe", enabled: true, modelConfigId: "chat-2", failurePolicy: "stop", systemPrompt: "must not be posted" } as any, options);
    expect(h.calls[2].init.method).toBe("PATCH");
    expect(JSON.parse(String(h.calls[2].init.body))).not.toHaveProperty("systemPrompt");
});

test("network uncertainty never replays POST; by-request lookup is GET and a 404 is distinct from rejection", async () => {
    const h = harness(() => {
        throw new TypeError("offline");
    });
    const testInput = { requestId: "original-request", modelConfigId: "image", versionId: "v1", promptInput: { scene: "free-optimize", fields: {}, userText: "test", referenceRoles: [], mode: "edit", hasMask: false }, sourceUrls: [] } as const;
    await expect(h.api.testAdminPromptRecipe("free-optimize", testInput as any, options)).rejects.toThrow("查询原请求");
    expect(h.calls).toHaveLength(1);
    const missing = harness(() => new Response(JSON.stringify({ message: "not found" }), { status: 404 }));
    expect(await missing.api.findAdminPromptCompilation("original/request", options)).toBeNull();
    expect(missing.calls[0].path).toEndWith("original%2Frequest");
    expect(missing.calls[0].init.method).toBeUndefined();
    const forbidden = harness(() => new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 }));
    await expect(forbidden.api.findAdminPromptCompilation("original", options)).rejects.toThrow("Forbidden");
});
