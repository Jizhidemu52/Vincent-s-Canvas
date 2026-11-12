import { afterEach, beforeEach, expect, test } from "bun:test";
import { deploymentFeatures } from "@/lib/deployment-features";
import { useUserStore, type LocalUser } from "@/stores/use-user-store";
import { historyAssetPath, listGenerationHistory, readHistoryOriginal } from "@/services/api/generation-task-history";

const originalFetch = globalThis.fetch, originalState = useUserStore.getState(), originalFeatures = { ...deploymentFeatures };
const user = { id: "owner", role: "designer" } as LocalUser;
const page = { tasks: [{ id: "task", userId: "owner", prompt: "保留原图和完整设计要求" }], nextCursor: null, hasMore: false };
beforeEach(() => { Object.assign(deploymentFeatures, { authenticationEnabled: true }); useUserStore.setState({ user, status: "authenticated" }); });
afterEach(() => { globalThis.fetch = originalFetch; useUserStore.setState(originalState); Object.assign(deploymentFeatures, originalFeatures); });

test("read-only page request preserves cursor and owner with no cache or redirect", async () => {
    let called = 0;
    globalThis.fetch = (async (input, init) => {
        called++; expect(String(input)).toBe("/api/tasks/history?board=image-edit&limit=30&cursor=saved%2Bcursor");
        expect(init).toMatchObject({ credentials: "include", cache: "no-store", redirect: "error", headers: { "X-Canvas-Owner-Id": "owner" } });
        expect(init?.method).toBeUndefined(); expect(init?.body).toBeUndefined(); return Response.json(page);
    }) as typeof fetch;
    expect(await listGenerationHistory("image-edit", "owner", "saved+cursor")).toEqual(page); expect(called).toBe(1);
});

test("foreign or malformed page data never reaches the account history", async () => {
    for (const payload of [{ ...page, tasks: [{ ...page.tasks[0], userId: "other" }] }, { ...page, tasks: undefined }, { ...page, hasMore: true }, { ...page, nextCursor: 23 }]) {
        globalThis.fetch = (async () => Response.json(payload)) as typeof fetch;
        await expect(listGenerationHistory("image-generation", "owner")).rejects.toThrow("归属或分页信息异常");
    }
});

test("account change or expiry during the HTTP request rejects its late response", async () => {
    for (const changed of [{ user: { ...user, id: "other" }, status: "authenticated" as const }, { user, status: "expired" as const }]) {
        useUserStore.setState({ user, status: "authenticated" });
        globalThis.fetch = (async () => { useUserStore.setState(changed); return Response.json(page); }) as typeof fetch;
        await expect(listGenerationHistory("image-generation", "owner")).rejects.toThrow("员工会话已变化");
    }
});

test("account changes during body parsing also reject before display", async () => {
    globalThis.fetch = (async () => ({ ok: true, json: async () => { useUserStore.setState({ user: { ...user, id: "other" } }); return page; } })) as typeof fetch;
    await expect(listGenerationHistory("image-generation", "owner")).rejects.toThrow("员工会话已变化");
});

test("unsafe original URLs are rejected before any fetch", async () => {
    let called = 0; globalThis.fetch = (async () => { called++; throw new Error("must not fetch"); }) as typeof fetch;
    for (const path of ["https://upstream.invalid/file", "//upstream.invalid/file", "data:image/png;base64,x", "blob:unsafe", "/api/assets/id/content?token=secret", "/api/assets/../content", "/api/assets/id/thumb", "/api/assets/id/content#x"]) {
        expect(historyAssetPath(path)).toBeNull(); await expect(readHistoryOriginal(path, "owner")).rejects.toThrow("未保存本站原件");
    }
    expect(called).toBe(0);
});

test("original download preserves bytes and refuses late aborted reads", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 0, 255, 13]); const controller = new AbortController();
    globalThis.fetch = (async (input, init) => {
        expect(input).toBe("/api/assets/original/content"); expect(init).toMatchObject({ redirect: "error", credentials: "include", headers: { "X-Canvas-Owner-Id": "owner" } });
        return new Response(bytes, { headers: { "content-type": "image/png" } });
    }) as typeof fetch;
    const blob = await readHistoryOriginal("/api/assets/original/content", "owner");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes); expect(blob.type).toBe("image/png");
    controller.abort(); await expect(readHistoryOriginal("/api/assets/original/content", "owner", controller.signal)).rejects.toThrow();
});
