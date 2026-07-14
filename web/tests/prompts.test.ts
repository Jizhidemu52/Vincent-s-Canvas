import { afterEach, describe, expect, it, mock } from "bun:test";

import { listPromptTemplates, promptDestination, resolvePromptReuse } from "../src/services/api/prompts";

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("prompt template client", () => {
    it("routes every reusable tool to its real workbench", () => {
        expect(promptDestination("image-generation", "token one")).toBe("/image?reuseToken=token+one");
        expect(promptDestination("detail-enhance", "t")).toBe("/image?reuseToken=t&tool=detail-enhance");
        expect(promptDestination("seamless-stitch", "t")).toBe("/image?reuseToken=t&tool=seamless-stitch");
        expect(promptDestination("video", "t")).toBe("/video?reuseToken=t");
        expect(promptDestination("batch-edit", "t")).toBe("/canvas?reuseToken=t&mode=new&promptTool=batch-edit");
        expect(promptDestination("canvas", "t")).toBe("/canvas?reuseToken=t&mode=new&promptTool=canvas");
    });

    it("lists company templates through the authenticated server API", async () => {
        const fetchMock = mock(async (input: RequestInfo | URL) => new Response(JSON.stringify({ templates: [], total: 0, page: 1, pageSize: 24 }), { status: 200 }));
        globalThis.fetch = fetchMock as typeof fetch;
        await listPromptTemplates({ scope: "personal" });
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/prompt-templates?scope=personal&page=1&pageSize=24");
    });

    it("resolves fill mode without submitting a generation task", async () => {
        const fetchMock = mock(async () => new Response(JSON.stringify({ reuseToken: "reuse", expiresInSeconds: 300, mode: "fill", pricing: {} }), { status: 200 }));
        globalThis.fetch = fetchMock as typeof fetch;
        await resolvePromptReuse("template-id", "fill", "request-id");
        const [, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
        expect(init.method).toBe("POST");
        expect(JSON.parse(String(init.body))).toEqual({ mode: "fill", requestId: "prompt-reuse:request-id" });
    });
});
