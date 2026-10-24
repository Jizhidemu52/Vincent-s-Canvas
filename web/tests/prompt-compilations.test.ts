import { afterEach, expect, test } from "bun:test";
import { createPromptCompilation, getPromptCompilation, PromptCompilationUncertainError } from "../src/services/api/prompt-compilations";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const input = { requestId: "compile-original", modelConfigId: "model-config", promptInput: { scene: "free-optimize" as const, userText: "衬衫换蓝色" }, sourceUrls: ["/api/assets/main/content"] };
const compilation = { id: "compilation-id", requestId: input.requestId, status: "success", prompt: "Edit the shirt color to blue.", summaryZh: "只改衣服颜色", optimized: true };

test("compiler sends public fields and source order once, returning the final prompt only", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url, init) => { requests.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return Response.json({ compilation }); }) as typeof fetch;
    expect(await createPromptCompilation(input)).toEqual(compilation);
    expect(requests).toEqual([{ url: "/api/prompt-compilations", body: input }]);
    expect(JSON.stringify(requests)).not.toMatch(/systemPrompt|fieldTemplate|apiKey/);
});

test("lost compiler POST reconciles by the original ID without a second POST", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (url, init) => {
        requests.push(`${init?.method || "GET"} ${url}`);
        if (init?.method === "POST") throw new TypeError("connection lost after acceptance");
        return Response.json({ compilation });
    }) as typeof fetch;
    expect((await createPromptCompilation(input)).prompt).toBe(compilation.prompt);
    expect(requests).toEqual(["POST /api/prompt-compilations", "GET /api/prompt-compilations/by-request/compile-original"]);
});

test("an optimizing or missing original remains uncertain, never silently resubmitted", async () => {
    let posts = 0;
    globalThis.fetch = (async (_url, init) => {
        if (init?.method === "POST") { posts++; throw new TypeError("lost"); }
        return Response.json({ compilation: { ...compilation, status: "optimizing", prompt: undefined } });
    }) as typeof fetch;
    await expect(createPromptCompilation(input)).rejects.toBeInstanceOf(PromptCompilationUncertainError);
    expect(posts).toBe(1);
    expect((await getPromptCompilation(input.requestId))?.status).toBe("optimizing");
    expect(posts).toBe(1);
});

test("definitive rejection does not query or retry and disabled fallback does not fabricate a prompt", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ message: "场景优化未启用" }, { status: 422 }); }) as typeof fetch;
    await expect(createPromptCompilation(input)).rejects.toThrow("场景优化未启用");
    expect(calls).toBe(1);
});

test("explicit server fallback remains visibly unoptimized", async () => {
    globalThis.fetch = (async () => Response.json({ code: 0, data: { compilation: { ...compilation, optimized: false } } })) as typeof fetch;
    expect((await createPromptCompilation(input)).optimized).toBe(false);
});
