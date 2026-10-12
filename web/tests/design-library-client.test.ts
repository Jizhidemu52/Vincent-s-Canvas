import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type * as Client from "../src/services/api/design-library";

const code = ts.transpileModule(readFileSync(new URL("../src/services/api/design-library.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
}).outputText;
const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, data, msg: "" }), { headers: { "content-type": "application/json" } });
const publication = { title: "靛蓝提花", thought: "织物层次", prompt: "indigo jacquard", tags: ["提花"], assetIds: ["asset-1"], requestId: "publish-1" };

function harness(handler: (path: string, init: RequestInit) => Promise<Response> | Response = () => ok({})) {
    const state = { status: "authenticated", user: { id: "employee-1", role: "designer", status: "active" } };
    const features = { oaLoginEnabled: true };
    const calls: { path: string; init: RequestInit }[] = [];
    const dependencies: Record<string, unknown> = {
        "@/lib/deployment-features": { deploymentFeatures: features },
        "@/stores/use-user-store": { useUserStore: { getState: () => state }, isAdminRole: (role: string) => ["super_admin", "department_admin"].includes(role) },
    };
    const module = { exports: {} as typeof Client };
    new Function("require", "module", "exports", "fetch", code)(
        (name: string) => dependencies[name], module, module.exports,
        (path: string, init: RequestInit) => { calls.push({ path, init }); return handler(path, init); },
    );
    return { api: module.exports, state, features, calls };
}

test("design library requests encode filters, use employee-bound no-store transport, and unwrap the envelope", async () => {
    const h = harness(path => path.includes("?") ? ok({ items: [], total: 0, page: 2, pageSize: 24 }) : ok({ entry: { id: "entry-1" } }));
    expect(await h.api.listDesignLibrary({ scope: "company", q: "蓝色 & 纹理", page: 2 })).toEqual({ items: [], total: 0, page: 2, pageSize: 24 });
    expect(new URL(h.calls[0].path, "https://canvas.test").searchParams.get("q")).toBe("蓝色 & 纹理");
    expect((await h.api.publishDesignLibrary(publication)).id).toBe("entry-1");
    for (const { init } of h.calls) {
        expect(new Headers(init.headers).get("X-Canvas-Owner-Id")).toBe("employee-1");
        expect(init.credentials).toBe("include"); expect(init.cache).toBe("no-store"); expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(JSON.parse(String(h.calls[1].init.body))).toEqual(publication);
});

test("trial, guest, inactive, wrong-role, and stale expected-owner requests never leave the browser", async () => {
    const h = harness(); h.features.oaLoginEnabled = false;
    await expect(h.api.publishDesignLibrary(publication)).rejects.toThrow("企业模式");
    h.features.oaLoginEnabled = true; h.state.status = "guest";
    await expect(h.api.publishDesignLibrary(publication)).rejects.toThrow("员工会话");
    h.state.status = "authenticated"; h.state.user.status = "disabled";
    await expect(h.api.publishDesignLibrary(publication)).rejects.toThrow("员工会话");
    h.state.user.status = "active"; h.state.user.role = "super_admin";
    await expect(h.api.publishDesignLibrary(publication)).rejects.toThrow("员工会话");
    h.state.user.role = "designer";
    await expect(h.api.publishDesignLibrary(publication, { expectedOwnerId: "employee-2" })).rejects.toThrow("员工会话");
    expect(h.calls).toHaveLength(0);
});

test("moderation and administrator reads use strict administrator endpoints and owner binding", async () => {
    const h = harness(() => ok({ entry: { id: "entry/1" } }));
    await expect(h.api.moderateDesignLibrary("entry/1", "侵权风险")).rejects.toThrow("管理员");
    h.state.user.role = "department_admin";
    expect((await h.api.moderateDesignLibrary("entry/1", "侵权风险")).id).toBe("entry/1");
    expect(h.calls[0].path).toBe("/api/admin/design-library/entry%2F1/moderate");
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({ reason: "侵权风险" });
    await h.api.getDesignLibraryEntry("entry/1", true);
    expect(h.calls[1].path).toBe("/api/admin/design-library/entry%2F1");
});

test("HTTP, semantic, malformed, and nonstandard error responses stay failures with useful messages", async () => {
    for (const [status, body, message] of [
        [409, { code: 409, msg: "请求编号已被不同内容使用" }, "请求编号"],
        [403, { error: "作品已撤回" }, "作品已撤回"],
        [401, { message: "员工会话已失效" }, "员工会话"],
        [200, { code: 9, data: null, msg: "不允许发布" }, "不允许发布"],
        [200, { data: {} }, "无效响应"],
    ] as const) {
        const h = harness(() => new Response(JSON.stringify(body), { status }));
        await expect(h.api.getDesignLibraryEntry("one")).rejects.toThrow(message);
    }
    await expect(harness(() => new Response("<html>error</html>", { status: 502 })).api.getDesignLibraryEntry("one")).rejects.toThrow("502");
    await expect(harness(() => { throw new TypeError("Failed to fetch"); }).api.getDesignLibraryEntry("one")).rejects.toThrow("检查网络");
});

test("identity changes during response or original-byte reading cannot return another employee's result", async () => {
    const fetchGate = Promise.withResolvers<Response>();
    const h = harness(() => fetchGate.promise);
    const pending = h.api.publishDesignLibrary(publication);
    h.state.user.id = "employee-2"; fetchGate.resolve(ok({ entry: { id: "one" } }));
    await expect(pending).rejects.toThrow("员工会话");

    const bodyGate = Promise.withResolvers<Blob>();
    const response = new Response(new Uint8Array([1, 2, 3]));
    response.blob = () => bodyGate.promise;
    const b = harness(() => response);
    const bytes = b.api.downloadDesignLibraryImage("one", "image-1", "download-1");
    await Promise.resolve(); b.state.user.id = "employee-2"; bodyGate.resolve(new Blob(["abc"]));
    await expect(bytes).rejects.toThrow("员工会话");
});

test("download preserves original binary data, never adds a receipt, and reused media uses only the private asset route", async () => {
    const original = new Uint8Array([137, 80, 78, 71, 0, 255, 10]);
    const h = harness(() => new Response(original, { headers: { "content-type": "image/png" } }));
    const result = await h.api.downloadDesignLibraryImage("one", "image/1", "download-1");
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(original);
    expect(h.calls).toHaveLength(1); expect(h.calls[0].path).toBe("/api/design-library/one/images/image%2F1/download");
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({ requestId: "download-1" });
    await h.api.fetchDesignLibraryReusedImage("asset/1");
    expect(h.calls[1].path).toBe("/api/assets/asset%2F1/content");
    await expect(harness(() => new Response()).api.downloadDesignLibraryImage("one", "image", "request")).rejects.toThrow("内容为空");
});

test("caller cancellation is retained instead of turned into a success or generic API error", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    const h = harness((_path, init) => { controller.abort(reason); throw init.signal!.reason; });
    await expect(h.api.getDesignLibraryEntry("one", false, controller.signal)).rejects.toBe(reason);
});
