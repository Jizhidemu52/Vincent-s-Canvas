import { afterEach, expect, test } from "bun:test";
import { getUsageTaskDetail, getUsageTaskPrompt, getUsageTaskThumbnail } from "../src/services/api/usage-task-detail";
const originalFetch = globalThis.fetch;
const person = "00000000-0000-4000-8000-000000000001",
    task = "00000000-0000-4000-8000-000000000002",
    asset = "00000000-0000-4000-8000-000000000003";
afterEach(() => {
    globalThis.fetch = originalFetch;
});
const detail = () => ({
    userId: person,
    taskId: task,
    asOf: "2026-11-04T01:00:00Z",
    status: "success",
    operationType: "image_generation",
    boardKey: "image",
    modelName: "synthetic",
    queuedAt: "2026-11-01T01:00:00Z",
    startedAt: null,
    completedAt: null,
    timing: { waitMs: null, runMs: null, totalMs: null },
    bookedCny: "0.123456",
    parameters: { size: "1024x1024" },
    submittedReferenceCount: 0,
    results: {
        items: [
            {
                position: 1,
                assetId: asset,
                kind: "image",
                thumbnailAvailable: true,
                previewAvailable: true,
                evidence: [],
            },
        ],
        pagination: { page: 1, pageSize: 12, total: 1 },
        available: true,
    },
});
test("detail binds person/task/page before display and never accepts arbitrary thumbnail URLs or private extra fields", async () => {
    const calls: string[] = [];
    let value: any = detail();
    globalThis.fetch = (async (input, options) => {
        calls.push(String(input));
        expect(options?.credentials).toBe("include");
        expect(options?.cache).toBe("no-store");
        return Response.json({ code: 0, data: value });
    }) as typeof fetch;
    expect((await getUsageTaskDetail(person, task, 1)).results.items[0]?.assetId).toBe(asset);
    expect(calls[0]).toBe(`/api/admin/usage/people/${person}/tasks/${task}?page=1&pageSize=12`);
    for (const change of [
        { userId: asset },
        { taskId: asset },
        { prompt: "PRIVATE_PROMPT" },
        { parameters: { prompt: "PRIVATE_PROMPT" } },
        {
            results: {
                ...detail().results,
                items: [{ ...detail().results.items[0], thumbnailUrl: "https://private.invalid/secret" }],
            },
        },
        { results: { ...detail().results, pagination: { page: 2, pageSize: 12, total: 1 } } },
    ]) {
        value = { ...detail(), ...change };
        await expect(getUsageTaskDetail(person, task, 1)).rejects.toThrow("详情响应");
    }
});
test("prompt requires separate explicit POST and errors never echo arbitrary server text", async () => {
    let calls = 0;
    globalThis.fetch = (async (_input, options) => {
        calls++;
        expect(options?.method).toBe("POST");
        expect(options?.body).toBe('{"confirm":true}');
        return Response.json({
            code: 0,
            data: {
                userId: person,
                taskId: task,
                prompt: "private explicitly requested",
                userInput: null,
                promptLength: 28,
                userInputLength: null,
                truncated: false,
            },
        });
    }) as typeof fetch;
    expect((await getUsageTaskPrompt(person, task)).prompt).toBe("private explicitly requested");
    expect(calls).toBe(1);
    globalThis.fetch = (async () => new Response("PRIVATE_SERVER_SECRET", { status: 404 })) as typeof fetch;
    await expect(getUsageTaskPrompt(person, task)).rejects.toThrow("不存在或无权访问");
});
test("thumbnails use only the protected scoped derivative path and pending is not retried or replaced with original bytes", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input, options) => {
        calls.push(String(input));
        expect(options?.redirect).toBe("error");
        return new Response(null, { status: 202 });
    }) as typeof fetch;
    await expect(getUsageTaskThumbnail(person, task, asset, 256)).rejects.toThrow("暂不可用");
    expect(calls).toEqual([`/api/assets/${asset}/thumb?w=256&pending=1&usageUserId=${person}&usageTaskId=${task}`]);
    globalThis.fetch = (async () =>
        new Response("<svg>PRIVATE</svg>", { headers: { "content-type": "image/svg+xml" } })) as typeof fetch;
    await expect(getUsageTaskThumbnail(person, task, asset, 1024)).rejects.toThrow("图片响应");
    globalThis.fetch = (async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/webp" } })) as typeof fetch;
    expect((await getUsageTaskThumbnail(person, task, asset, 1024)).type).toBe("image/webp");
});
