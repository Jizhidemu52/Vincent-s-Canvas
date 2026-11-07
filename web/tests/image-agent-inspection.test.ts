import { afterEach, expect, test } from "bun:test";
import { requestImageAgentReview } from "../src/services/api/image-agent-inspection";
import { defaultConfig } from "../src/stores/use-config-store";
import { isImageAgentPlanningIssue } from "../../shared/image-agent-iteration";

const globals = globalThis as unknown as Record<string, unknown>;
const original = { fetch: globals.fetch, Image: globals.Image, document: globals.document };
afterEach(() => Object.assign(globals, original));
const config = { ...defaultConfig, model: "inspection-fixture", textModel: "inspection-fixture" };
const image = (id: string) => ({ id, name: id, type: "image/png", dataUrl: `data:image/png;base64,${btoa(id)}` });
const report = { summary: "袖口可见罗纹，纽扣被遮挡", checks: [{ criterion: "罗纹袖口", result: "pass", evidence: "左袖口可见纵向纹路" }, { criterion: "纽扣保持", result: "unverifiable", evidence: "纽扣被遮挡" }] };
const response = (args = JSON.stringify(report), name = "report_image_review") => ({ content: "", toolCalls: [{ id: "review", type: "function", function: { name, arguments: args } }] });
function fixture(options: { onLoad?: (loaded: () => void) => void; onModels?: () => void; preview?: string; handle?: (body: any) => Response | Promise<Response> } = {}) {
    const calls: Array<{ url: string; body: any }> = [];
    const sources: string[] = [];
    const canvas = { width: 0, height: 0, getContext: () => ({ fillStyle: "", fillRect() {}, drawImage() {} }), toDataURL: () => options.preview || "data:image/jpeg;base64,cHJldmlldw==" };
    globals.Image = class {
        naturalWidth = 4000; naturalHeight = 2000; onload?: () => void; onerror?: () => void;
        set src(value: string) { sources.push(value); if (!value) return; if (options.onLoad) options.onLoad(() => this.onload?.()); else queueMicrotask(() => this.onload?.()); }
    };
    globals.document = { createElement: () => canvas };
    globalThis.fetch = (async (url, init) => {
        if (String(url) === "/api/models") { options.onModels?.(); return Response.json({ models: [{ id: "inspection-fixture", modelId: "inspection-fixture", name: "fixture", capabilities: ["chat", "vision"], creditCost: 0, rmbCost: 0 }], tools: ["gpt-chat", "canvas-chat"].map(toolKey => ({ toolKey, modelConfigId: "inspection-fixture", enabled: true })), prices: [] }); }
        const body = JSON.parse(String(init?.body));
        calls.push({ url: String(url), body });
        return options.handle?.(body) ?? Response.json(response());
    }) as typeof fetch;
    return { calls, sources, canvas };
}

test.each(["creative-chat", "canvas-assistant"] as const)("%s sends only actual base/result pixels to read-only review", async profile => {
    const fake = fixture();
    const base = image("base"), result = image("result"), snapshot = JSON.stringify([base, result]);
    expect(await requestImageAgentReview(config, { profile, base, result, prompt: "只改左袖口", spec: { changes: ["罗纹袖口"] } })).toEqual(report);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe("/api/chat/responses");
    expect(fake.calls[0]?.body).toMatchObject({ profile, tools: [], toolChoice: "auto", profileContext: { stage: "review", previewImageIds: ["base", "result"], reviewContext: { baseImageId: "base", resultImageId: "result", prompt: "只改左袖口", spec: { changes: ["罗纹袖口"] } } } });
    expect(fake.calls[0]?.body.input[0].content.filter((part: any) => part.type === "input_image")).toHaveLength(2);
    expect(fake.canvas).toMatchObject({ width: 1600, height: 800 });
    expect(fake.sources).toEqual([base.dataUrl, result.dataUrl]);
    expect(JSON.stringify([base, result])).toBe(snapshot);
});

test("missing historical prompt/base is explicitly evidence-limited, not substituted", async () => {
    const fake = fixture();
    await requestImageAgentReview(config, { profile: "creative-chat", result: image("result"), prompt: "" });
    expect(fake.calls[0]?.body.profileContext.reviewContext).toEqual({ resultImageId: "result", prompt: expect.stringContaining("缺少原始生成要求") });
    expect(fake.sources).toHaveLength(1);
});

test.each(["external", "same-id", "huge-prompt", "invalid-spec", "huge-preview"])("rejects %s before any model call", async mode => {
    const fake = fixture({ ...(mode === "huge-preview" ? { preview: `data:image/jpeg;base64,${"A".repeat(4 * 1024 * 1024 + 4)}` } : {}) });
    const result = { ...image("result"), ...(mode === "external" ? { dataUrl: "https://example.org/private.png" } : {}) };
    await expect(requestImageAgentReview(config, { profile: "creative-chat", result, prompt: mode === "huge-prompt" ? "x".repeat(20001) : "改色", ...(mode === "same-id" ? { base: result } : {}), ...(mode === "invalid-spec" ? { spec: { changes: [] } } : {}) })).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
});

test.each(["wrong-tool", "multiple-tools", "duplicate-key", "empty-checks", "incomplete", "http-error"])("invalid %s never retries review or submits generation", async mode => {
    const fake = fixture({ handle: () => {
        if (mode === "http-error") return Response.json({ error: "IMAGE_AGENT_ARGUMENTS_INVALID", message: "invalid", repairable: true, submitted: false }, { status: 422 });
        if (mode === "wrong-tool") return Response.json(response("{}", "edit_image"));
        if (mode === "multiple-tools") { const result = response(); return Response.json({ ...result, toolCalls: [...result.toolCalls, ...result.toolCalls] }); }
        if (mode === "duplicate-key") return Response.json(response('{"summary":"bad","summary":"good","checks":[]}'));
        if (mode === "incomplete") return Response.json({ ...response(), stopReason: "max_tokens" });
        return Response.json(response(JSON.stringify({ ...report, checks: [] })));
    } });
    let error: unknown;
    try { await requestImageAgentReview(config, { profile: "creative-chat", result: image("result"), prompt: "改色" }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(isImageAgentPlanningIssue(error)).toBe(false);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe("/api/chat/responses");
});

test("abort during decoding stops before any model call", async () => {
    const controller = new AbortController();
    const fake = fixture({ onLoad: () => controller.abort() });
    await expect(requestImageAgentReview(config, { profile: "creative-chat", result: image("result"), prompt: "改色", signal: controller.signal })).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
});

test("identity change during preview stops before model submission", async () => {
    let current = true;
    const fake = fixture({ onLoad: loaded => { current = false; loaded(); } });
    await expect(requestImageAgentReview(config, { profile: "creative-chat", result: image("result"), prompt: "改色", assertCurrent: () => { if (!current) throw new Error("owner changed"); } })).rejects.toThrow("owner changed");
    expect(fake.calls).toHaveLength(0);
});

test("identity change after submission discards late review without retry", async () => {
    let current = true;
    const fake = fixture({ handle: () => { current = false; return Response.json(response()); } });
    await expect(requestImageAgentReview(config, { profile: "canvas-assistant", result: image("result"), prompt: "改色", assertCurrent: () => { if (!current) throw new Error("owner changed"); } })).rejects.toThrow("owner changed");
    expect(fake.calls).toHaveLength(1);
});

test("identity change while resolving model stops immediately before HTTP submission", async () => {
    let current = true;
    const fake = fixture({ onModels: () => { current = false; } });
    await expect(requestImageAgentReview(config, { profile: "creative-chat", result: image("result"), prompt: "改色", assertCurrent: () => { if (!current) throw new Error("owner changed"); } })).rejects.toThrow("owner changed");
    expect(fake.calls).toHaveLength(0);
});
