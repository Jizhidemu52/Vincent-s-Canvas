import { afterEach, expect, test } from "bun:test";
import { createPromptCompilation, getPromptCompilation, observePromptCompilation, PromptCompilationUncertainError } from "../src/services/api/prompt-compilations";
import { generationErrorDiagnostic } from "../src/lib/generation-feedback";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const input = { requestId: "compile-original", modelConfigId: "model-config", promptInput: { scene: "free-optimize" as const, userText: "衬衫换蓝色" }, sourceUrls: ["/api/assets/main/content"] };
const compilation = { id: "compilation-id", requestId: input.requestId, status: "success", prompt: "Edit the shirt color to blue.", summaryZh: "只改衣服颜色", optimized: true };

test("compiler sends public fields and source order once, returning the final prompt only", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        expect(new Headers(init?.headers).get("Prefer")).toBe("respond-async");
        return Response.json({ compilation });
    }) as typeof fetch;
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
    await expect(createPromptCompilation(input, undefined, { timeoutMs: 0 })).rejects.toBeInstanceOf(PromptCompilationUncertainError);
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

test("known unavailable recipe is a definitive 503 before admission, not a perpetual query", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (url, init) => {
        requests.push(`${init?.method || "GET"} ${url}`);
        return Response.json({ error: "PROMPT_RECIPE_UNAVAILABLE", message: "管理员尚未启用此场景的配方版本，未提交生成" }, { status: 503 });
    }) as typeof fetch;
    await expect(createPromptCompilation(input)).rejects.toMatchObject({ definitive: true, status: 503, code: "PROMPT_RECIPE_UNAVAILABLE", requestId: input.requestId });
    expect(requests).toEqual(["POST /api/prompt-compilations"]);
});

test("unknown 503 followed by missing lookup retains its original diagnostic and request ID", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (url, init) => {
        requests.push(`${init?.method || "GET"} ${url}`);
        return init?.method === "POST"
            ? Response.json({ error: "UNKNOWN_PROVIDER_STATE", message: "original 503 diagnostic" }, { status: 503 })
            : Response.json({ error: "NOT_FOUND", message: "lookup 404" }, { status: 404 });
    }) as typeof fetch;
    let failure: unknown;
    try { await createPromptCompilation(input); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(PromptCompilationUncertainError);
    expect(generationErrorDiagnostic(failure)).toContain("original 503 diagnostic");
    expect(generationErrorDiagnostic(failure)).toContain("HTTP 503");
    expect(generationErrorDiagnostic(failure)).toContain(`requestId: ${input.requestId}`);
    expect(generationErrorDiagnostic(failure)).not.toContain("lookup 404");
    expect(requests).toEqual(["POST /api/prompt-compilations", "GET /api/prompt-compilations/by-request/compile-original"]);
});

test("an accepted asynchronous optimization reaches success by GET without another POST", async () => {
    let now = 0, queries = 0;
    const requests: string[] = [];
    globalThis.fetch = (async (url, init) => {
        requests.push(`${init?.method || "GET"} ${url}`);
        if (init?.method === "POST") return Response.json({ compilation: { ...compilation, status: "optimizing", prompt: undefined } }, { status: 202 });
        return Response.json({ compilation: ++queries < 3 ? { ...compilation, status: "optimizing", prompt: undefined } : compilation });
    }) as typeof fetch;
    expect(await createPromptCompilation(input, undefined, { now: () => now, delay: async ms => { now += ms; } })).toEqual(compilation);
    expect(requests).toEqual(["POST /api/prompt-compilations", ...Array(3).fill("GET /api/prompt-compilations/by-request/compile-original")]);
    expect(now).toBe(2_000);
});

test("a lost POST observed while optimizing automatically recovers its later success with one submission", async () => {
    let now = 0, queries = 0;
    const requests: string[] = [];
    globalThis.fetch = (async (url, init) => {
        requests.push(`${init?.method || "GET"} ${url}`);
        if (init?.method === "POST") {
            now = 120_000;
            return new Response("<html>gateway connection closed</html>", { status: 504 });
        }
        return Response.json({ compilation: ++queries < 3 ? { ...compilation, status: "optimizing", prompt: undefined } : compilation });
    }) as typeof fetch;
    expect(await createPromptCompilation(input, undefined, { now: () => now, delay: async ms => { now += ms; } })).toEqual(compilation);
    expect(requests.filter(request => request.startsWith("POST"))).toHaveLength(1);
    expect(requests.slice(1)).toEqual(Array(3).fill("GET /api/prompt-compilations/by-request/compile-original"));
});

test("the automatic observation budget includes time already spent waiting for the POST", async () => {
    let now = 0, posts = 0;
    globalThis.fetch = (async (_url, init) => {
        if (init?.method === "POST") { posts++; now = 120_000; throw new TypeError("original connection lost"); }
        return Response.json({ compilation: { ...compilation, status: "optimizing", prompt: undefined } });
    }) as typeof fetch;
    let failure: unknown;
    try { await createPromptCompilation(input, undefined, { now: () => now, delay: async ms => { now += ms; } }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(PromptCompilationUncertainError);
    expect(failure).toMatchObject({ requestId: input.requestId, compilation: { status: "optimizing" } });
    expect(generationErrorDiagnostic(failure)).toContain("original connection lost");
    expect(now).toBe(210_000);
    expect(posts).toBe(1);
});

test("an observation connection failure keeps the original lost POST diagnostic and request identity", async () => {
    let now = 0, posts = 0, queries = 0;
    globalThis.fetch = (async (_url, init) => {
        if (init?.method === "POST") { posts++; throw new TypeError("original accepted response lost"); }
        if (++queries === 1) return Response.json({ compilation: { ...compilation, status: "optimizing", prompt: undefined } });
        throw new TypeError("lookup disconnected");
    }) as typeof fetch;
    let failure: unknown;
    try { await createPromptCompilation(input, undefined, { now: () => now, delay: async ms => { now += ms; } }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(PromptCompilationUncertainError);
    expect(generationErrorDiagnostic(failure)).toContain("original accepted response lost");
    expect(failure).toMatchObject({ requestId: input.requestId });
    expect(queries).toBe(4);
    expect(posts).toBe(1);
});

test("aborting an observed optimization stops GETs without discarding the submitted request", async () => {
    let posts = 0, queries = 0;
    const controller = new AbortController();
    globalThis.fetch = (async (_url, init) => {
        if (init?.method === "POST") { posts++; return Response.json({ compilation: { ...compilation, status: "optimizing", prompt: undefined } }, { status: 202 }); }
        queries++;
        return Response.json({ compilation: { ...compilation, status: "optimizing", prompt: undefined } });
    }) as typeof fetch;
    await expect(createPromptCompilation(input, controller.signal, { delay: async () => { controller.abort(); } })).rejects.toMatchObject({ name: "PromptCompilationUncertainError", requestId: input.requestId });
    expect(posts).toBe(1);
    expect(queries).toBe(1);
});

test("manual reconciliation waits for the original request and never starts a new optimization", async () => {
    let now = 0, queries = 0;
    const requests: string[] = [];
    globalThis.fetch = (async (url, init) => {
        requests.push(`${init?.method || "GET"} ${url}`);
        return Response.json({ compilation: ++queries === 1 ? { ...compilation, status: "optimizing", prompt: undefined } : compilation });
    }) as typeof fetch;
    expect(await observePromptCompilation(input.requestId, { now: () => now, delay: async ms => { now += ms; } })).toEqual(compilation);
    expect(requests).toEqual(Array(2).fill("GET /api/prompt-compilations/by-request/compile-original"));
});

test("a manual observation deadline preserves the request for a later successful lookup", async () => {
    let now = 0, ready = false;
    const methods: string[] = [];
    globalThis.fetch = (async (_url, init) => {
        methods.push(init?.method || "GET");
        return Response.json({ compilation: ready ? compilation : { ...compilation, status: "optimizing", prompt: undefined } });
    }) as typeof fetch;
    await expect(observePromptCompilation(input.requestId, { timeoutMs: 10, now: () => now, delay: async ms => { now += ms; } })).rejects.toMatchObject({ name: "PromptCompilationUncertainError", requestId: input.requestId, compilation: { status: "optimizing" } });
    ready = true;
    expect(await observePromptCompilation(input.requestId)).toEqual(compilation);
    expect(methods.every(method => method === "GET")).toBe(true);
});

test("an observed terminal failure stops immediately instead of reporting it as a connection problem", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ compilation: { ...compilation, status: "failed", message: "original preparation failed", prompt: undefined } }); }) as typeof fetch;
    const error = await observePromptCompilation(input.requestId).catch(value => value);
    expect(error.message).toBe("original preparation failed");
    expect(error).not.toBeInstanceOf(PromptCompilationUncertainError);
    expect(calls).toBe(1);
});

test("a deliberately aborted submission performs no reconciliation against a possibly changed account", async () => {
    const controller = new AbortController();
    const methods: string[] = [];
    globalThis.fetch = (async (_url, init) => {
        methods.push(init?.method || "GET");
        controller.abort();
        throw controller.signal.reason;
    }) as typeof fetch;
    await expect(createPromptCompilation(input, controller.signal)).rejects.toMatchObject({ name: "PromptCompilationUncertainError", requestId: input.requestId });
    expect(methods).toEqual(["POST"]);
});

test("an account abort racing a successful lookup does not release a stale result", async () => {
    const controller = new AbortController();
    globalThis.fetch = (async () => { controller.abort(); return Response.json({ compilation }); }) as typeof fetch;
    await expect(observePromptCompilation(input.requestId, { signal: controller.signal })).rejects.toMatchObject({ name: "PromptCompilationUncertainError", requestId: input.requestId });
});

test("a lost POST beyond the observation deadline still allows a bounded final lookup", async () => {
    let now = 0;
    const originalTimeout = AbortSignal.timeout;
    const timeouts: number[] = [];
    AbortSignal.timeout = ms => { timeouts.push(ms); return new AbortController().signal; };
    globalThis.fetch = (async (_url, init) => {
        if (init?.method === "POST") { now = 211_000; throw new TypeError("response lost at deadline"); }
        return Response.json({ compilation });
    }) as typeof fetch;
    try {
        expect(await createPromptCompilation(input, undefined, { now: () => now })).toEqual(compilation);
        expect(timeouts).toEqual([210_000, 5_000]);
    } finally { AbortSignal.timeout = originalTimeout; }
});
