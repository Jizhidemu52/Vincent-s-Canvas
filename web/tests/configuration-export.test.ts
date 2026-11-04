import { afterEach, expect, test } from "bun:test";
import { exportConfigurationSnapshot } from "../src/services/api/model-configuration";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("configuration download requests a fresh authenticated snapshot", async () => {
    const snapshot = { schemaVersion: 1, providers: [], models: [], toolConfigurations: [], modules: [], promptRecipes: [] };
    globalThis.fetch = (async (url, init) => {
        expect(url).toBe("/api/admin/model-configuration/export");
        expect(init).toEqual({ credentials: "include", cache: "no-store" });
        return Response.json(snapshot);
    }) as typeof fetch;
    const blob = await exportConfigurationSnapshot();
    expect(blob.type).toBe("application/json;charset=utf-8");
    expect(JSON.parse(await blob.text())).toEqual(snapshot);
});

test("failed authorization and malformed responses do not produce download files", async () => {
    for (const status of [401, 403, 500]) {
        globalThis.fetch = (async () => new Response("failure", { status })) as typeof fetch;
        await expect(exportConfigurationSnapshot()).rejects.toThrow(status === 401 ? "登录已失效" : status === 403 ? "仅超级管理员" : "配置导出失败");
    }
    globalThis.fetch = (async () => Response.json({ schemaVersion: 1, providers: [] })) as typeof fetch;
    await expect(exportConfigurationSnapshot()).rejects.toThrow("配置快照格式无效");
});
