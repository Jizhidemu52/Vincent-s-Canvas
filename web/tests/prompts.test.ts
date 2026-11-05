import { afterEach, describe, expect, it, mock } from "bun:test";

import { fetchPrompts, listPromptTemplates, promptDestination, resolvePromptReuse, type PromptTemplate } from "../src/services/api/prompts";

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("prompt template client", () => {
    it("module library includes private, authorized team and public scopes without truncating later pages", async () => {
        const requested: URL[] = [];
        globalThis.fetch = mock(async (input: RequestInfo | URL) => {
            const url = new URL(String(input), "http://localhost"); requested.push(url);
            const scope = url.searchParams.get("scope")!;
            const page = Number(url.searchParams.get("page"));
            const template = { id: `${scope}-${page}`, title: scope, scope, prompt: "reusable text", tags: [], category: "", notes: "", modelSnapshot: {}, targetTool: "image-generation" } as PromptTemplate;
            return Response.json({ templates: [template], total: 140, page, pageSize: 20 });
        }) as typeof fetch;
        const result = await fetchPrompts({ page: 6, pageSize: 20 });
        expect(requested.map(url => url.searchParams.get("scope")).sort()).toEqual(["personal", "public", "team"]);
        expect(requested.every(url => url.searchParams.get("page") === "6" && url.searchParams.get("pageSize") === "20")).toBe(true);
        expect(result.items.map(item => item.id)).toEqual(["personal-6", "team-6", "public-6"]);
        expect(result.total).toBe(420);
    });

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
