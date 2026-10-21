import { afterEach, describe, expect, test } from "bun:test";
import { buildCreativeScenePlanMessages, parseCreativeScenePlan, snapshotCreativeScenePlanInput } from "../src/lib/creative-scene-plan";
import { requestCreativeScenePlan, type CreativeScenePlanInput } from "../src/services/api/creative-scene-plan";
import { defaultConfig } from "../src/stores/use-config-store";
import { useUserStore } from "../src/stores/use-user-store";

const configuredId = "b3000000-0000-4000-8000-000000000001";
const actualId = "b3000000-0000-4000-8000-000000000002";
const reference = (id: string, slotId = id, role = `仅参考${id}`) => ({ id, slotId, role, name: `${id}.png`, type: "image/png", dataUrl: `data:image/png;base64,${btoa(id)}` });
const input = (references: CreativeScenePlanInput["references"] = []): CreativeScenePlanInput => ({ sceneId: "local-restyle", sceneTitle: "局部改款", brief: "只改领口为蓝色V领；保留插肩袖、菱形提花、奶油白衣身与原图比例。", references });
const content = { summary: "调整领口，延续毛衫原款", prompt: "依据图片1，将领口改为雾蓝色V领。", observations: ["奶油白插肩毛衫，胸前有蓝色菱形带"], preserve: ["插肩结构", "胸前提花与原配色"], warnings: ["不能由预览确认实际针数"] };
const config = { ...defaultConfig, model: "untrusted-client-choice", textModel: "untrusted-client-choice", systemPrompt: "图像模型专用系统指令，不得带入LLM规划" };
const originalFetch = globalThis.fetch;
const originalUser = useUserStore.getState().user;
const cleanups: Array<() => void> = [];
afterEach(() => {
    globalThis.fetch = originalFetch;
    useUserStore.setState({ user: originalUser });
    while (cleanups.length) cleanups.pop()!();
});

function installTransport(options: { response?: () => Response | Promise<Response>; capabilities?: string[]; additionalModels?: Array<{ id: string; name: string }>; onConfig?: (count: number) => void; configFailureAfter?: number } = {}) {
    const calls: Array<{ url: string; body: Record<string, any>; signal: AbortSignal | null | undefined }> = [];
    let reads = 0;
    globalThis.fetch = (async (url, init) => {
        if (String(url) === "/api/models") {
            reads += 1;
            options.onConfig?.(reads);
            if (options.configFailureAfter && reads > options.configFailureAfter) return Response.json({ message: "fixture unavailable" }, { status: 503 });
            return Response.json({ models: [{ id: configuredId, name: "统一视觉规划模型", modelId: "managed-public-id", parameterModelId: "claude-sonnet-5-5", capabilities: options.capabilities || ["chat", "vision"], creditCost: 0, rmbCost: 0 },
                ...(options.additionalModels || []).map(model => ({ ...model, modelId: model.id, capabilities: ["chat", "vision"], creditCost: 0, rmbCost: 0 }))],
            tools: [{ toolKey: "gpt-chat", modelConfigId: configuredId, enabled: true }, { toolKey: "creative-planner", modelConfigId: null, enabled: true }, { toolKey: "creative", modelConfigId: null, enabled: true }], prices: [] });
        }
        expect(String(url)).toBe("/api/chat/responses");
        expect(init?.method).toBe("POST");
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)), signal: init?.signal });
        return options.response ? options.response() : Response.json({ content: JSON.stringify(content), toolCalls: [] });
    }) as typeof fetch;
    return { calls, configReads: () => reads };
}

function installPreviews(onLoad?: () => void) {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previous = { Image: globals.Image, document: globals.document };
    const canvases: Array<{ width: number; height: number }> = [];
    const loaded: string[] = [];
    globals.Image = class {
        naturalWidth = 4096; naturalHeight = 2048; source = ""; onload?: () => void; onerror?: () => void;
        set src(value: string) { this.source = value; loaded.push(value); queueMicrotask(() => { onLoad?.(); this.onload?.(); }); }
    };
    globals.document = { createElement: () => {
        let source = "";
        const canvas = { width: 0, height: 0, getContext: () => ({ fillStyle: "", fillRect() {}, drawImage(image: { source: string }) { source = image.source; } }),
            toDataURL: (mime: string, quality: number) => { expect(mime).toBe("image/jpeg"); expect(quality).toBe(0.78); return `data:image/jpeg;base64,${btoa(`preview:${source}`)}`; } };
        canvases.push(canvas);
        return canvas;
    } };
    cleanups.push(() => Object.assign(globals, previous));
    return { loaded, canvases };
}

describe("creative scene plan transport", () => {
    test("uses the managed LLM once with its own billing ID and keeps original hard constraints", async () => {
        const transport = installTransport();
        const phases: string[] = [];
        const signal = new AbortController().signal;
        const request = input();
        const plan = await requestCreativeScenePlan(config, request, { requestId: "scene-plan-request-123", signal, onPhase: phase => phases.push(phase) });
        expect(transport.calls).toHaveLength(1);
        expect(transport.calls[0]!.body).toMatchObject({ requestId: "scene-plan-request-123", toolKey: "creative-planner", modelId: "managed-public-id", tools: [], toolChoice: "auto", webSearch: false });
        expect(transport.calls[0]!.signal).toBe(signal);
        expect(transport.calls[0]!.body.input.map((message: { role: string }) => message.role)).toEqual(["system", "user"]);
        expect(JSON.stringify(transport.calls)).not.toContain("untrusted-client-choice");
        expect(JSON.stringify(transport.calls)).not.toContain(config.systemPrompt);
        expect(config.systemPrompt).toBe("图像模型专用系统指令，不得带入LLM规划");
        expect(plan).toMatchObject({ summary: content.summary, observations: content.observations, preserve: content.preserve, warnings: content.warnings, modelId: configuredId, modelName: "统一视觉规划模型", requestId: "scene-plan-request-123" });
        expect(plan.prompt).toStartWith(content.prompt);
        expect(plan.prompt).toContain("以下完整需求优先于上方规划");
        expect(plan.prompt.endsWith(request.brief)).toBe(true);
        expect(phases.some(phase => phase.includes("LLM 规划已完成"))).toBe(true);
        expect(request).toEqual(input());
    });

    test("compressed previews preserve reference roles/order including the last selection guide", async () => {
        const previews = installPreviews();
        const transport = installTransport();
        const references = [reference("garment", "primary", "原款；仅修改领口"), reference("palette", "secondary", "仅参考蓝色配色"), reference("guide", "selection-guide", "蓝色标注是可改选区；最后参考")];
        const request = { ...input(references), selection: "仅允许蓝色标记领口区域；选区外保持原图像素。" };
        const original = JSON.stringify(request);
        const plan = await requestCreativeScenePlan(config, request);
        expect(transport.calls).toHaveLength(1);
        const messages = transport.calls[0]!.body.input as Array<{ role: string; content: Array<{ type: string; image_url?: string; text?: string }> }>;
        const parts = messages.find(message => message.role === "user")!.content;
        const imageParts = parts.filter(part => part.type === "input_image");
        expect(imageParts.map(part => atob(part.image_url!.split(",")[1]!))).toEqual(references.map(item => `preview:${item.dataUrl}`));
        expect(previews.loaded).toEqual(references.map(item => item.dataUrl));
        expect(previews.canvases.map(canvas => [canvas.width, canvas.height])).toEqual([[1024, 512], [1024, 512], [1024, 512]]);
        const labels = parts.filter(part => part.type === "input_text").map(part => part.text).slice(1);
        expect(labels).toEqual(["图片1：原款；仅修改领口（槽位 primary）", "图片2：仅参考蓝色配色（槽位 secondary）", "图片3：蓝色标注是可改选区；最后参考（槽位 selection-guide）"]);
        expect(plan.prompt).toContain("图片3（selection-guide）：蓝色标注是可改选区；最后参考");
        expect(plan.prompt).toContain(request.selection);
        expect(JSON.stringify(request)).toBe(original);
        expect(plan).not.toHaveProperty("references");
    });

    test("takes a stable input snapshot before model resolution", async () => {
        installPreviews();
        const request = input([reference("first"), reference("second")]);
        const originalBrief = request.brief;
        const transport = installTransport({ onConfig: count => { if (count === 1) { request.brief = "外部变化"; request.references.reverse(); request.references[0]!.role = "被修改的角色"; } } });
        const plan = await requestCreativeScenePlan(config, request);
        const payload = JSON.stringify(transport.calls[0]!.body.input);
        expect(payload).not.toContain("外部变化");
        expect(payload).not.toContain("被修改的角色");
        expect(plan.prompt).toContain("图片1（first）：仅参考first");
        expect(plan.prompt.endsWith(originalBrief)).toBe(true);
    });

    test.each(["json", "sse"])("records authoritative response headers for %s, resolving the actual public model name", async kind => {
        const headers = { "x-chat-model-config-id": actualId, "x-chat-request-id": "actual-request-from-server" };
        const transport = installTransport({ additionalModels: [{ id: actualId, name: "实际执行的视觉模型" }], response: () => kind === "json"
            ? Response.json({ content: JSON.stringify(content), toolCalls: [], modelConfigId: "body-must-not-win", requestId: "body-request" }, { headers })
            : new Response(`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: JSON.stringify(content) } })}\n\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`, { headers: { ...headers, "content-type": "text/event-stream" } }) });
        const plan = await requestCreativeScenePlan(config, input(), { requestId: "requested-client-id" });
        expect(plan).toMatchObject({ modelId: actualId, modelName: "实际执行的视觉模型", requestId: "actual-request-from-server" });
        expect(transport.calls).toHaveLength(1);
        expect(transport.configReads()).toBe(3);
    });

    test("an unknown actual model stays an explicit UUID when public metadata cannot be read", async () => {
        const transport = installTransport({ configFailureAfter: 2, response: () => Response.json({ content: JSON.stringify(content), toolCalls: [] }, { headers: { "x-chat-model-config-id": actualId } }) });
        expect(await requestCreativeScenePlan(config, input())).toMatchObject({ modelId: actualId, modelName: actualId });
        expect(transport.calls).toHaveLength(1);
    });

    test("refuses image planning without vision instead of dropping images", async () => {
        const transport = installTransport({ capabilities: ["chat"] });
        await expect(requestCreativeScenePlan(config, input([reference("garment")]))).rejects.toThrow("不支持视觉理解");
        expect(transport.calls).toHaveLength(0);
    });

    test.each([
        ["malformed JSON", "{"],
        ["empty prompt", JSON.stringify({ ...content, prompt: " \n " })],
        ["extra image selection", JSON.stringify({ ...content, reference_image_ids: ["different"] })],
        ["duplicate key", '{"summary":"摘要","prompt":"先改版型","prompt":"只改颜色","observations":[],"preserve":[],"warnings":[]}'],
        ["wrong array", JSON.stringify({ ...content, preserve: "不要改图案" })],
        ["markdown wrapper", `\`\`\`json\n${JSON.stringify(content)}\n\`\`\``],
    ])("invalid %s fails after exactly one LLM call, with no template fallback", async (_label, returned) => {
        const transport = installTransport({ response: () => Response.json({ content: returned, toolCalls: [] }) });
        await expect(requestCreativeScenePlan(config, input())).rejects.toThrow();
        expect(transport.calls).toHaveLength(1);
    });

    test("an inspection request is not executed and is not followed by a second LLM call", async () => {
        const transport = installTransport({ response: () => Response.json({ content: JSON.stringify(content), toolCalls: [{ id: "inspect", type: "function", function: { name: "inspect_images", arguments: "{}" } }] }) });
        await expect(requestCreativeScenePlan(config, input())).rejects.toThrow("不能请求额外工具");
        expect(transport.calls).toHaveLength(1);
    });

    test("a transport failure is not retried", async () => {
        const transport = installTransport({ response: () => { throw new TypeError("connection interrupted"); } });
        await expect(requestCreativeScenePlan(config, input())).rejects.toThrow("connection interrupted");
        expect(transport.calls).toHaveLength(1);
    });

    test("an abort during preview prevents a paid LLM submission", async () => {
        const controller = new AbortController();
        installPreviews(() => controller.abort());
        const transport = installTransport();
        await expect(requestCreativeScenePlan(config, input([reference("garment")]), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(transport.calls).toHaveLength(0);
    });

    test("an account change during preview prevents submission under the new owner", async () => {
        installPreviews(() => useUserStore.setState({ user: { id: "different-owner" } as never }));
        const transport = installTransport();
        await expect(requestCreativeScenePlan(config, input([reference("garment")]))).rejects.toThrow("员工会话已变化");
        expect(transport.calls).toHaveLength(0);
    });
});

describe("creative scene plan validation", () => {
    test("rejects missing roles, oversized input and mismatched preview order", () => {
        expect(() => snapshotCreativeScenePlanInput(input([{ ...reference("one"), role: "" }]))).toThrow();
        expect(() => snapshotCreativeScenePlanInput(input(Array.from({ length: 6 }, (_, index) => reference(String(index)))))).toThrow();
        const request = input([reference("one"), reference("two")]);
        expect(() => buildCreativeScenePlanMessages(request, [...request.references].reverse())).toThrow("顺序不一致");
    });

    test("truncated output cannot become an executable plan even if its JSON parses", () => {
        expect(() => parseCreativeScenePlan({ content: JSON.stringify(content), toolCalls: [], stopReason: "max_tokens" })).toThrow("被截断");
    });
});
