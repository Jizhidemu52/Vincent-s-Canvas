import { afterEach, expect, test } from "bun:test";
import { syncProjectMetadata } from "@/services/api/projects";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("project metadata requests bind the captured owner and cancellation signal", async () => {
    const abort = new AbortController();
    let requestedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (url, init) => {
        expect(url).toBe("/api/projects/sync");
        expect(init?.method).toBe("POST");
        expect(init?.credentials).toBe("include");
        expect(new Headers(init?.headers).get("X-Canvas-Owner-Id")).toBe("employee-a");
        expect(JSON.parse(String(init?.body))).toEqual({ externalId: "canvas-a", name: "初稿" });
        requestedSignal = init?.signal || undefined;
        return Response.json({ project: { id: "server-id", externalId: "canvas-a", name: "初稿", status: "active" } });
    }) as typeof fetch;
    await syncProjectMetadata("employee-a", { id: "canvas-a", title: "初稿" }, abort.signal);
    expect(requestedSignal?.aborted).toBe(false);
    abort.abort();
    expect(requestedSignal?.aborted).toBe(true);
});

test("HTTP errors and mismatched successful responses are not reported as synchronized", async () => {
    const project = { id: "canvas-a", title: "初稿" };
    for (const response of [
        Response.json({ message: "保存失败" }, { status: 503 }),
        Response.json({ project: { externalId: "other", name: project.title } }),
        Response.json({ project: { externalId: project.id, name: "旧名称" } }),
        new Response("not JSON", { status: 200 }),
    ]) {
        globalThis.fetch = (async () => response) as typeof fetch;
        await expect(syncProjectMetadata("employee-a", project, new AbortController().signal)).rejects.toThrow();
    }
});
