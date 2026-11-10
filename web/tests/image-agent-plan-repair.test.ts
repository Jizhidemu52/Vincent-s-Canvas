import { afterEach, expect, test } from "bun:test";
import { ImageAgentPlanningError, isImageAgentPlanningIssue } from "../../shared/image-agent-iteration";
import { requestImageAgentPlanWithRepair } from "../src/lib/image-agent/planning-repair";
import { compileImageAgentPrompt } from "../src/lib/image-agent/compile";
import { requestToolResponse } from "../src/services/api/image";
import { defaultConfig } from "../src/stores/use-config-store";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const issue = { error: "IMAGE_AGENT_ARGUMENTS_INVALID", message: "规划参数无效", submitted: false, repairable: true };
const config = { ...defaultConfig, model: "repair-fixture", textModel: "repair-fixture" };
function serve(response: () => Response) {
    globalThis.fetch = (async url => String(url) === "/api/models" ? Response.json({ models: [{ id: "repair-fixture", modelId: "repair-fixture", name: "fixture", capabilities: ["chat", "vision"], creditCost: 0, rmbCost: 0 }], tools: [{ toolKey: "gpt-chat", modelConfigId: "repair-fixture", enabled: true }], prices: [] }) : response()) as typeof fetch;
}
const request = (stage = "plan") => requestToolResponse(config, [{ role: "user", content: "只改袖口" }], [], "auto", undefined, { chatProfile: "creative-chat", profileContext: { stage } });

test("only explicit HTTP422 validation refusals permit a new plan", async () => {
    serve(() => Response.json(issue, { status: 422 }));
    await expect(request()).rejects.toBeInstanceOf(ImageAgentPlanningError);
    for (const [payload, status] of [[issue, 500], [{ ...issue, error: "OTHER" }, 422], [{ ...issue, submitted: true }, 422], [{ error: issue.error, message: issue.message }, 422]] as const) {
        serve(() => Response.json(payload, { status }));
        try { await request(); throw new Error("expected failure"); } catch (error) { expect(isImageAgentPlanningIssue(error)).toBe(false); }
    }
    serve(() => Response.json(issue, { status: 422 }));
    try { await request("review"); } catch (error) { expect(isImageAgentPlanningIssue(error)).toBe(false); }
});

test("SSE typed rejection permits repair but interrupted EOF does not", async () => {
    serve(() => new Response(`data: ${JSON.stringify({ type: "error", error: { ...issue, code: issue.error } })}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    await expect(request()).rejects.toBeInstanceOf(ImageAgentPlanningError);
    serve(() => new Response('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"unfinished"}}\n\n', { headers: { "content-type": "text/event-stream" } }));
    await expect(request()).rejects.toThrow("未完整返回");
});

test("one repair budget spans continuations and never retries execution/network failures", async () => {
    const budget = { used: false }; let calls = 0;
    const plan = () => requestImageAgentPlanWithRepair({ budget, request: async () => ++calls, validate: value => { if (value === 1 || value === 3) throw new ImageAgentPlanningError("IMAGE_AGENT_SPEC_INVALID", "invalid spec"); return value; } });
    expect(await plan()).toBe(2);
    await expect(plan()).rejects.toThrow("invalid spec");
    expect(calls).toBe(3);
    for (const error of [new Error("network"), new DOMException("stopped", "AbortError")]) {
        let requests = 0;
        await expect(requestImageAgentPlanWithRepair({ budget: { used: false }, request: async () => { requests++; throw error; }, validate: value => value })).rejects.toBe(error);
        expect(requests).toBe(1);
    }
    let attempts = 0;
    await expect(requestImageAgentPlanWithRepair({ budget: { used: false }, canRepair: () => false, request: async () => ++attempts, validate: () => { throw new ImageAgentPlanningError("IMAGE_AGENT_SPEC_INVALID", "invalid spec"); } })).rejects.toThrow("invalid spec");
    expect(attempts).toBe(1);
});

test("local image preparation is awaited once and only the wire issue reaches the next request", async () => {
    const events: string[] = [], requests: unknown[] = [];
    const missing = ["old"], required = ["old", "reference"];
    const error = new ImageAgentPlanningError("IMAGE_AGENT_UNPREVIEWED_IMAGE", "missing pixels", { missingImageIds: missing, requiredImageIds: required });
    missing.push("outside"); required.push("outside");
    const budget = { used: false };
    const answer = await requestImageAgentPlanWithRepair({
        budget,
        request: async issue => { events.push(issue ? "repair" : "initial"); requests.push(issue); return requests.length; },
        validate: value => { if (value === 1) throw error; return value; },
        prepareRepair: async issue => {
            expect(budget.used).toBe(true);
            expect(issue).toMatchObject({ missingImageIds: ["old"], requiredImageIds: ["old", "reference"] });
            events.push("prepare"); await Promise.resolve(); events.push("ready");
        },
    });
    expect(answer).toBe(2);
    expect(events).toEqual(["initial", "prepare", "ready", "repair"]);
    expect(requests[1]).toEqual({ code: error.code, message: error.message, repairable: true, submitted: false });
});

test.each(["load-failure", "aborted", "execution-started"])("%s during image preparation prevents repair without restoring its budget", async mode => {
    const budget = { used: false }, controller = new AbortController();
    let calls = 0, mayRepair = true;
    await expect(requestImageAgentPlanWithRepair({
        budget, signal: controller.signal, canRepair: () => mayRepair,
        request: async () => ++calls,
        validate: () => { throw new ImageAgentPlanningError("IMAGE_AGENT_UNPREVIEWED_IMAGE", "missing pixels", { missingImageIds: ["old"], requiredImageIds: ["old"] }); },
        prepareRepair: async () => {
            await Promise.resolve();
            if (mode === "load-failure") throw new Error("original unavailable");
            if (mode === "aborted") controller.abort();
            if (mode === "execution-started") mayRepair = false;
        },
    })).rejects.toThrow();
    expect(calls).toBe(1);
    expect(budget.used).toBe(true);
});

test("compiler retains full visual prompt and code-owned non-target preservation", () => {
    const full = "只把左袖口换成蓝色罗纹，沿用原有细腻布纹与柔和侧光。";
    const compiled = compileImageAgentPrompt({ prompt: full, keep: [], images: [{ id: "a", label: "图8" }], baseImageId: "a", spec: { changes: ["左袖口改蓝色罗纹"], assumptions: ["不修改右袖口"], acceptance: ["左袖口可见蓝色罗纹"] } });
    expect(compiled.prompt).toContain(full);
    expect(compiled.prompt).toContain("除本次明确修改外，其余保持底图不变");
    expect(compiled.prompt).not.toContain("结果应满足");
    expect(compiled.spec?.assumptions).toEqual(["不修改右袖口"]);
    expect(() => compileImageAgentPrompt({ prompt: full, keep: [], images: [{ id: "a", label: "图8" }], baseImageId: "b" })).toThrow("第一张");
    expect(() => compileImageAgentPrompt({ prompt: "x".repeat(20_000), keep: [], images: [{ id: "a", label: "图8" }], baseImageId: "a" })).toThrow("20000");
});
