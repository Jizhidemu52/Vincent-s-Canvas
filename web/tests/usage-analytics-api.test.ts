import { afterEach, expect, test } from "bun:test";
import { analyzeUsage, exportUsageRecords, getUsagePerson, listUsageAnalysisModels, listUsagePeople, previewUsageAnalysis, UsageAnalyticsError } from "../src/services/api/usage-analytics";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const coverage = { collectionStartedAt: null, historicalTasksAvailable: true, historicalClicksAvailable: false, historicalChatAvailable: false, notes: [] };
const manifest = { type: "manifest", filters: { userIds: ["user-1"] }, coverage, exportedAt: "2026-10-15T00:00:00.000Z" };
const record = { type: "record", record: { id: "1", kind: "generation", prompt: "保留针织纹理，修改颜色", parameters: { quality: "high" } } };
const lines = (values: unknown[]) => values.map(value => JSON.stringify(value)).join("\n") + "\n";
const streamResponse = (text: string, chunkSize = 13) => {
    const bytes = new TextEncoder().encode(text);
    return new Response(new ReadableStream({ start(controller) {
        for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
        controller.close();
    } }), { headers: { "content-type": "application/x-ndjson" } });
};

test("usage API sends credentialed scoped reads and only frozen preview identifiers for analysis", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => { calls.push({ url: String(url), init }); return Response.json({ code: 0, data: { ok: true }, msg: "ok" }); }) as typeof fetch;
    await listUsagePeople({ search: "姓名 & 部门", from: "2026-10-01T00:00:00Z", to: "2026-10-16T00:00:00Z", page: 2, pageSize: 20 });
    await getUsagePerson("id /?", { page: 3, pageSize: 20 });
    await previewUsageAnalysis({ userIds: ["user-1"], includePromptSamples: false });
    await analyzeUsage({ previewId: "preview-1", previewHash: "frozen-hash", modelConfigId: "configured-text", confirm: true });
    expect(calls).toHaveLength(4);
    expect(new URL(calls[0]!.url, "http://localhost").searchParams.get("search")).toBe("姓名 & 部门");
    expect(calls[1]!.url).toBe("/api/admin/usage/people/id%20%2F%3F?page=3&pageSize=20");
    expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({ userIds: ["user-1"], includePromptSamples: false });
    expect(JSON.parse(String(calls[3]!.init?.body))).toEqual({ previewId: "preview-1", previewHash: "frozen-hash", modelConfigId: "configured-text", confirm: true });
    expect(calls.every(call => call.init?.credentials === "include" && call.init.cache === "no-store")).toBe(true);
});

test("OA admin text model choices use the dedicated authenticated usage endpoint, never creative model APIs", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const expected = { models: [{ id: "configured-model-uuid", name: "文字模型", description: "流程汇总" }] };
    const controller = new AbortController();
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => { calls.push({ url: String(url), init }); return Response.json({ code: 0, data: expected, msg: "ok" }); }) as typeof fetch;
    expect(await listUsageAnalysisModels(controller.signal)).toEqual(expected);
    expect(calls).toHaveLength(1); expect(calls[0]!.url).toBe("/api/admin/usage/analysis-models");
    expect(calls[0]!.init).toMatchObject({ method: "GET", credentials: "include", cache: "no-store", signal: controller.signal });
});

test("malformed model-list envelopes become a recoverable load error instead of crashing option rendering", async () => {
    for (const data of [{}, { models: null }, { models: [{ id: "model-without-name" }] }]) {
        globalThis.fetch = (async () => Response.json({ code: 0, data, msg: "ok" })) as typeof fetch;
        await expect(listUsageAnalysisModels()).rejects.toThrow("文字模型列表响应不完整");
    }
});

test("export preserves every UTF-8 byte across chunks and requires its complete record count", async () => {
    const contents = lines([manifest, record, record, { type: "complete", recordCount: 2 }]);
    let body: unknown; const progress: number[] = [];
    globalThis.fetch = (async (_: unknown, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return streamResponse(contents, 1); }) as typeof fetch;
    const result = await exportUsageRecords({ userIds: ["user-1"] }, { onProgress: count => progress.push(count) });
    expect(body).toEqual({ userIds: ["user-1"] });
    expect(result.recordCount).toBe(2);
    expect(await result.blob?.text()).toBe(contents);
    expect(result.manifest).toEqual(manifest);
    expect(progress.at(-1)).toBe(2);
});

test("large-export writable sink receives original bytes without buffering a second blob", async () => {
    const contents = lines([manifest, ...Array.from({ length: 1200 }, (_, index) => ({ ...record, record: { ...record.record, id: String(index) } })), { type: "complete", recordCount: 1200 }]);
    const chunks: Uint8Array[] = [];
    globalThis.fetch = (async () => streamResponse(contents, 1024)) as typeof fetch;
    const result = await exportUsageRecords({}, { writeChunk: async chunk => { chunks.push(chunk); } });
    expect(result.blob).toBeNull();
    expect(result.recordCount).toBe(1200);
    expect(Buffer.concat(chunks).toString("utf8")).toBe(contents);
});

for (const [label, values] of Object.entries({
    "missing completion": [manifest, record],
    "incorrect total": [manifest, record, { type: "complete", recordCount: 2 }],
    "record after completion": [manifest, { type: "complete", recordCount: 0 }, record],
    "missing manifest": [record, { type: "complete", recordCount: 1 }],
    "duplicate manifest": [manifest, manifest, { type: "complete", recordCount: 0 }],
})) test(`export rejects ${label} instead of producing a partial file`, async () => {
    globalThis.fetch = (async () => streamResponse(lines(values))) as typeof fetch;
    await expect(exportUsageRecords({})).rejects.toBeInstanceOf(UsageAnalyticsError);
});

test("cancelled exports and API reads preserve AbortError and never return a completed result", async () => {
    const controller = new AbortController(); controller.abort();
    globalThis.fetch = (async () => streamResponse(lines([manifest, record, { type: "complete", recordCount: 1 }]))) as typeof fetch;
    await expect(exportUsageRecords({}, { signal: controller.signal })).rejects.toHaveProperty("name", "AbortError");
    globalThis.fetch = (async () => Response.json({ code: 0, data: {}, msg: "ok" })) as typeof fetch;
    await expect(listUsagePeople({}, controller.signal)).rejects.toHaveProperty("name", "AbortError");
});

test("HTTP and unexpected network errors never expose upstream secrets or raw response text", async () => {
    for (const status of [400, 401, 403, 404, 409, 410, 429, 500]) {
        globalThis.fetch = (async () => Response.json({ code: "DENIED", msg: "secret-api-key" }, { status })) as typeof fetch;
        try { await listUsagePeople({}); throw new Error("expected rejection"); }
        catch (error) { expect(error).toBeInstanceOf(UsageAnalyticsError); expect((error as Error).message).not.toContain("secret-api-key"); }
    }
    globalThis.fetch = (async () => { throw new Error("secret-api-key"); }) as typeof fetch;
    await expect(listUsagePeople({})).rejects.toThrow("网络连接或响应格式异常");
    globalThis.fetch = (async () => new Response("secret-api-key", { headers: { "content-type": "application/x-ndjson" } })) as typeof fetch;
    await expect(exportUsageRecords({})).rejects.toThrow("网络连接或响应格式异常");
});
