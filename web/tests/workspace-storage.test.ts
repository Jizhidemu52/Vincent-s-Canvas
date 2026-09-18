import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const code = ts.transpileModule(readFileSync(new URL("../src/lib/workspace-storage.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;

function workspace(browser = true) {
    const state: { user: { id: string; role: string } | null } = { user: null };
    const features = { oaLoginEnabled: false };
    const databases = new Map<string, Map<string, unknown>>();
    const opened: string[] = [];
    let delay: Promise<void> | undefined;
    const dependencies: Record<string, unknown> = {
        "@/lib/deployment-features": { deploymentFeatures: features },
        "@/stores/use-user-store": { useUserStore: { getState: () => state } },
        localforage: { createInstance({ name, storeName }: { name: string; storeName: string }) {
            const databaseKey = `${name}/${storeName}`;
            opened.push(databaseKey);
            const data = databases.get(databaseKey) || new Map(); databases.set(databaseKey, data);
            return {
                async getItem(key: string) { const value = data.get(key) ?? null; await delay; return value; },
                async setItem(key: string, value: unknown) { data.set(key, value); return value; },
                async removeItem(key: string) { data.delete(key); },
                async iterate(callback: (value: unknown, key: string, index: number) => unknown) { let index = 0; for (const [key, value] of data) callback(value, key, ++index); },
            };
        } },
    };
    const module = { exports: {} as any };
    new Function("require", "module", "exports", "window", code)((name: string) => dependencies[name], module, module.exports, browser ? {} : undefined);
    return { state, features, opened, databases, delay: (value?: Promise<void>) => { delay = value; }, create: module.exports.createWorkspaceStorage as (name: string) => any };
}

test("employee photo, history, chat and creative caches never hydrate anonymous or another employee's partition", async () => {
    for (const storeName of ["image_files", "media_files", "app_state", "image_generation_logs", "video_generation_logs", "creative_scene_workspaces"]) {
        const w = workspace();
        const trial = w.create(storeName);
        await trial.setItem("same-key", "anonymous draft");
        w.features.oaLoginEnabled = true;
        w.state.user = { id: "employee/A", role: "designer" };
        const a = w.create(storeName);
        expect(await a.getItem("same-key")).toBeNull();
        await a.setItem("same-key", new Blob([new Uint8Array([1, 9, 8, 7])], { type: "image/png" }));
        w.state.user = { id: "employee/B", role: "designer" };
        const b = w.create(storeName);
        expect(await b.getItem("same-key")).toBeNull();
        expect(() => a.assertIdentity()).toThrow("员工会话已变化");
        await expect(a.getItem("same-key")).rejects.toThrow("员工会话已变化");
        await expect(a.setItem("same-key", "late A write")).rejects.toThrow("员工会话已变化");
        w.state.user = { id: "employee/A", role: "designer" };
        const reopened = w.create(storeName);
        expect([...new Uint8Array(await (await reopened.getItem("same-key") as Blob).arrayBuffer())]).toEqual([1, 9, 8, 7]);
        expect(await trial.getItem("same-key")).toBe("anonymous draft");
        expect(w.opened).toContain(`wireless-canvas:oa:user:employee%2FA/${storeName}`);
    }
});

test("unverified and administrator entry never opens a shared employee cache", async () => {
    for (const role of [null, "super_admin", "department_admin"]) {
        const w = workspace(); w.features.oaLoginEnabled = true;
        if (role) w.state.user = { id: "operator", role };
        const storage = w.create("image_files");
        expect(storage.available).toBe(false);
        expect(w.opened).toEqual([]);
        await expect(storage.getItem("image:secret")).rejects.toThrow();
        await expect(storage.setItem("image:secret", "wrong")).rejects.toThrow();
    }
});

test("server rendering and module-only tests do not initialize browser persistence", () => {
    const w = workspace(false);
    const storage = w.create("app_state");
    expect(storage.available).toBe(false);
    expect(storage.isCurrent()).toBe(false);
    expect(() => storage.assertIdentity()).not.toThrow();
    expect(w.opened).toEqual([]);
});

test("an in-flight read cannot publish old employee bytes after the identity changes", async () => {
    const w = workspace(); w.features.oaLoginEnabled = true; w.state.user = { id: "a", role: "designer" };
    const a = w.create("image_files"); await a.setItem("image", "private A image");
    const gate = Promise.withResolvers<void>(); w.delay(gate.promise);
    const reading = a.getItem("image"); w.state.user = { id: "b", role: "designer" };
    gate.resolve(); await expect(reading).rejects.toThrow("员工会话已变化");
});
