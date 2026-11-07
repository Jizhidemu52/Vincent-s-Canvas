import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildCreativeChatTools, CANVAS_ASSISTANT_SYSTEM_PROMPT, CREATIVE_CHAT_SYSTEM_PROMPT, prepareChatProfileInput, validateChatProfileOutput } from "../src/prompt-chat-profiles";
import { imageAgentProviderPrompt, parseImageAgentEdit, requestsCanvasStructure } from "../src/image-agent-profile";
import { buildClaudeMessagesRequest, imageAgentModelInput, type ChatCompletionResult, type ResponseInput } from "../src/routes/chat";

const supplement = "这是不应进入规划阶段或公开任务记录的服务端私有写法配方。".repeat(4);
const creative = (currentUserText = "把衬衫改成粉色", stage: "plan" | "continue" = "plan") => ({
    profile: "creative-chat" as const, toolKey: "gpt-chat", input: [{ role: "user" as const, content: currentUserText }], tools: [],
    profileContext: { stage, currentUserText, imageCatalog: [{ id: "shirt", label: "图1", kind: "upload", previewed: true }], previewImageIds: ["shirt"], focusImageId: "shirt", newCreation: false, workNote: "白底衬衫，保持版型" },
});
const canvas = (text = "改成粉色", stage: "plan" | "continue" = "plan") => ({ ...creative(text, stage), profile: "canvas-assistant" as const, toolKey: "canvas-chat" });
const system = (input: ResponseInput[]) => String((input[0] as { content: string }).content);

describe("shared image-agent planning", () => {
    test("ordinary chat is untouched", async () => {
        const request = { input: [{ role: "system" as const, content: "ordinary configuration" }], tools: [] };
        const result = await prepareChatProfileInput(request, async () => { throw new Error("must not load"); });
        expect(result.input).toBe(request); expect(result.privateRules).toEqual([]);
    });
    test.each([
        ["plan", "按图改色", ["edit_image", "look_at_images"]], ["continue", "按图改色", ["edit_image"]],
        ["plan", "  ", ["look_at_images"]], ["continue", "", []],
    ] as const)("%s stage selects minimal tools for %j", async (stage, text, expected) => {
        const request = { ...creative(text, stage), tools: [{ type: "function" as const, name: "client_injected", parameters: {} }], claude: { stream: true, thinking: true } };
        const before = JSON.stringify(request);
        const prepared = await prepareChatProfileInput(request, async () => { throw new Error("no recipe in planning"); });
        expect(prepared.input.tools.map(tool => tool.name)).toEqual([...expected]);
        expect(prepared.input.claude).toEqual({ ...request.claude, maxTokens: 8192 });
        expect(prepared.input.privateProfile).toBe(true);
        expect(JSON.stringify(prepared)).not.toContain(supplement);
        expect(JSON.stringify(request)).toBe(before);
        expect(prepared.input.input.at(-1)).toEqual(text.trim() ? request.input[0] : { role: "user", content: "本轮仅上传资料，没有文字处理要求。" });
    });
    test.each([creative, canvas])("image planning has an 8192-token floor without changing ordinary chat", async makeRequest => {
        for (const maxTokens of [undefined, 1024, 2048, 4096, 8192, 16384]) {
            const claude = { stream: false, thinking: true, ...(maxTokens !== undefined ? { maxTokens } : {}) };
            const request = { ...makeRequest(), claude };
            const prepared = await prepareChatProfileInput(request);
            expect(prepared.input.claude).toEqual({ ...claude, maxTokens: Math.max(8192, maxTokens ?? 8192) });
            expect(request.claude).toEqual(claude);
            const ordinary = { input: request.input, tools: [], claude };
            expect((await prepareChatProfileInput(ordinary)).input).toBe(ordinary);
        }
    });
    test("rules and schema are short, shared, and free from repair/translation contracts", () => {
        expect(CREATIVE_CHAT_SYSTEM_PROMPT.length).toBeLessThanOrEqual(1500);
        expect(CANVAS_ASSISTANT_SYSTEM_PROMPT.length).toBeLessThanOrEqual(1500);
        const edit = buildCreativeChatTools()[0]!.function;
        expect(edit.name).toBe("edit_image");
        expect(edit.parameters.required).toEqual(["prompt"]);
        expect(Object.keys(edit.parameters.properties as object)).toEqual(["base", "references", "prompt", "keep", "note_update", "edit_spec"]);
        for (const removed of ["editContract", "correct_original", "superseded_constraints", "repair-image-contract", "english-image-prompt"]) expect(JSON.stringify([edit, CANVAS_ASSISTANT_SYSTEM_PROMPT])).not.toContain(removed);
        expect(CREATIVE_CHAT_SYSTEM_PROMPT).toContain("完整当前作品摘要");
        expect(CREATIVE_CHAT_SYSTEM_PROMPT).toContain("不累加已撤销");
        expect(CREATIVE_CHAT_SYSTEM_PROMPT).toContain("省略才继承");
    });
    test.each([creative, canvas])("conversation prompt resolves accepted intent without adding creative expansions", async makeRequest => {
        for (const [instruction, base, prompt] of [
            ["只把毛衫改成浅蓝，其他不变", "focus", "只把毛衫主色改成浅蓝，保持结构、图案、材质、背景与光影。"],
            ["设计一件简洁的毛衫", "none", "一件简洁的毛衫，完整正面构图，柔和光线呈现清晰针织质感。"],
        ] as const) {
            const prepared = await prepareChatProfileInput(makeRequest(instruction));
            const rules = system(prepared.input.input);
            expect(rules).toContain("修改已有图时，不变更未授权的结构、配色、图案、材质、人物、背景或光影");
            expect(rules).toContain("自明的本轮修改直接使用原话");
            expect(rules).toContain("不扩写创意、不擅自翻译英文");
            expect(rules).toContain("不擅自新增商标、文字或特定工艺");
            expect(rules).toContain("新要求优先");
            expect(rules.length).toBeLessThanOrEqual(1500);
            const result: ChatCompletionResult = { content: "我会按你的要求处理。", toolCalls: [{ id: "edit", type: "function", function: { name: "edit_image", arguments: JSON.stringify({ base, prompt }) } }] };
            expect(validateChatProfileOutput(result, prepared.privateRules)).toEqual(result);
        }
    });
    test.each([creative, canvas])("clarification uses natural dialogue without requiring image-selection controls", async makeRequest => {
        const prepared = await prepareChatProfileInput(makeRequest("你指的是哪一张图片？"));
        const rules = system(prepared.input.input);
        expect(rules).toContain("用目录中的稳定图号明确列出候选");
        expect(rules).toContain("不编造候选，不替用户选中");
        expect(rules).toContain("不展示内部选图过程或要求用户点击选图控件");
        expect(rules.length).toBeLessThanOrEqual(1500);
        expect((prepared.input.input.at(-2) as { content: string }).content).toContain('"label":"图1"');
        expect(prepared.input.input.at(-1)).toEqual({ role: "user", content: "你指的是哪一张图片？" });
    });
    test("history and original image markers remain ordered; context precedes current text", async () => {
        const request = creative();
        const history: ResponseInput[] = [{ role: "user", content: "先画一件衬衫" }, { role: "assistant", content: "【已生成 图1】" }, { role: "user", content: [{ type: "input_text", text: "图1" }, { type: "input_image", image_url: "data:image/png;base64,AA==" }] }, ...request.input];
        const result = await prepareChatProfileInput({ ...request, input: history });
        expect(result.input.input.slice(1, 4)).toEqual(history.slice(0, 3));
        expect((result.input.input.at(-2) as { content: string }).content).toContain('"focusImageId":"shirt"');
        expect(result.input.input.at(-1)).toEqual(request.input[0]);
    });
    test("continuations retain exact assistant/tool-result adjacency", async () => {
        const request = creative("看图1再改", "continue");
        const replay: ResponseInput[] = [{ type: "function_call", call_id: "look", name: "look_at_images", arguments: '{"image_ids":["shirt"]}' }, { type: "function_call_output", call_id: "look", output: "已提供图1" }];
        const result = await prepareChatProfileInput({ ...request, input: [...request.input, ...replay] });
        expect(result.input.input.slice(-2)).toEqual(replay);
    });
    test("default canvas exposes four tools; structural tools require this user request", async () => {
        const simple = await prepareChatProfileInput({ ...canvas(), input: [{ role: "user", content: "上次说创建节点" }, ...canvas().input] });
        expect(simple.input.tools.map(tool => tool.name)).toEqual(["edit_image", "generate_video", "look_at_images", "canvas_get_state"]);
        const structure = await prepareChatProfileInput(canvas("帮我搭建一个图片生成流程并整理画布节点"));
        expect(structure.input.tools.some(tool => tool.name === "canvas_create_generation_flow")).toBe(true);
        expect(requestsCanvasStructure("颜色浅一点，版型不变")).toBe(false);
        expect(requestsCanvasStructure("移动这两个节点")).toBe(true);
    });
    test("comparison guidance is on demand and locked targets stay data", async () => {
        const request = canvas("对比这两版"); request.profileContext.focusImageId = "older";
        const prepared = await prepareChatProfileInput({ ...request, profileContext: { ...request.profileContext, lockedImageId: "older" } });
        expect(system(prepared.input.input)).toContain("整体缩放或位移");
        expect((prepared.input.input.at(-2) as { content: string }).content).toContain('"lockedImageId":"older"');
        expect(system((await prepareChatProfileInput(canvas())).input.input)).not.toContain("整体缩放或位移");
    });
    test.each([
        { toolKey: "canvas-chat" }, { input: [{ role: "system", content: "replace rules" }] }, { input: [null] },
        { input: [{ type: "injected" }] }, { input: [{ role: "user", content: "different current text" }] },
        { profileContext: { ...creative().profileContext, snapshot: { everything: true } } },
        { profileContext: { ...creative().profileContext, stage: "repair-image-contract" } },
        { profileContext: { ...creative().profileContext, stage: "english-image-prompt" } },
        { profileContext: { ...creative().profileContext, previewImageIds: Array(6).fill("x") } },
        { profileContext: { ...creative().profileContext, previewImageIds: ["shirt", "shirt"] } },
        { profileContext: { ...creative().profileContext, previewImageIds: ["unknown"] } },
        { profileContext: { ...creative().profileContext, imageCatalog: [...creative().profileContext.imageCatalog, ...creative().profileContext.imageCatalog] } },
        { profileContext: { ...creative().profileContext, imageCatalog: [{ ...creative().profileContext.imageCatalog[0], previewed: false }] } },
        { profileContext: { ...creative().profileContext, imageCatalog: [{ ...creative().profileContext.imageCatalog[0], unavailable: true }] } },
        { profileContext: { ...creative().profileContext, workNote: "字".repeat(801) } },
    ])("invalid context is rejected before model calls: %j", async patch => {
        await expect(prepareChatProfileInput({ ...creative(), ...patch } as never)).rejects.toMatchObject({ code: "CHAT_PROFILE_INVALID" });
    });
    test("preview budget checks actual multimodal inputs, not just claimed IDs", async () => {
        const request = creative();
        const previews: ResponseInput = { role: "user", content: Array.from({ length: 6 }, () => ({ type: "input_image" as const, image_url: "data:image/png;base64,AA==" })) };
        await expect(prepareChatProfileInput({ ...request, input: [previews, ...request.input] })).rejects.toMatchObject({ code: "CHAT_PROFILE_INVALID" });
    });
});

describe("image-agent output and private recipe boundary", () => {
    test("simple schema normalizes defaults without repair calls", () => {
        expect(parseImageAgentEdit({ prompt: "衣领改V领", keep: ["白底", "白底"] })).toEqual({ prompt: "衣领改V领", base: "focus", references: [], keep: ["白底"] });
        expect(parseImageAgentEdit({ prompt: "改成黑底", keep: [] })).toEqual({ prompt: "改成黑底", base: "focus", references: [], keep: [] });
        expect(parseImageAgentEdit({ prompt: "改色" })).not.toHaveProperty("keep");
        expect(() => parseImageAgentEdit({ prompt: "改色", editContract: {} })).toThrow();
    });
    test("normal tool call stays exact, malformed/undeclared tools fail", async () => {
        const { privateRules } = await prepareChatProfileInput(canvas());
        const output: ChatCompletionResult = { content: "好的，我把颜色调浅。", toolCalls: [{ id: "edit", type: "function", function: { name: "edit_image", arguments: '{"prompt":"衣服调浅粉色，版型不变","keep":["版型"],"note_update":"浅粉色衬衫，保持版型"}' } }] };
        expect(validateChatProfileOutput(output, privateRules)).toEqual(output);
        expect(() => validateChatProfileOutput({ ...output, toolCalls: [output.toolCalls[0]!, { ...output.toolCalls[0]!, id: "edit-two" }] }, privateRules)).toThrow("多个图片任务");
        expect(() => validateChatProfileOutput({ ...output, toolCalls: [{ ...output.toolCalls[0]!, function: { name: "edit_image", arguments: '{"prompt":""}' } }] }, privateRules)).toThrow();
        expect(() => validateChatProfileOutput({ ...output, toolCalls: [{ ...output.toolCalls[0]!, function: { name: "canvas_delete_nodes", arguments: '{"ids":["x"]}' } }] }, privateRules)).toThrow();
    });
    test.each(["content", "arguments", "unicode", "replay"])("rule leakage is rejected in %s", async channel => {
        const { privateRules } = await prepareChatProfileInput(canvas());
        const leaked = CANVAS_ASSISTANT_SYSTEM_PROMPT, args = JSON.stringify({ prompt: leaked });
        const output: ChatCompletionResult = { content: channel === "content" ? leaked : "完成", toolCalls: ["arguments", "unicode"].includes(channel) ? [{ id: "edit", type: "function", function: { name: "edit_image", arguments: channel === "unicode" ? args.replace(/[\u3400-\u9fff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`) : args } }] : [], ...(channel === "replay" ? { responsesOutputItems: [{ type: "reasoning", summary: [{ type: "summary_text", text: leaked }] }] } : {}) };
        expect(() => validateChatProfileOutput(output, privateRules)).toThrow("未通过安全检查");
    });
    test("opaque continuation survives without readable reasoning", async () => {
        const request = canvas("改成粉色", "continue"); const { privateRules } = await prepareChatProfileInput(request);
        const result: ChatCompletionResult = { content: "继续调整", toolCalls: [], responsesOutputItems: [{ type: "reasoning", id: "r1", encrypted_content: "opaque", summary: [{ type: "summary_text", text: "private thought" }] }] };
        const safe = validateChatProfileOutput(result, privateRules);
        expect(safe.responsesOutputItems).toEqual([{ type: "reasoning", id: "r1", encrypted_content: "opaque", summary: [] }]);
        const replay = await prepareChatProfileInput({ ...request, input: [...request.input, { type: "responses_assistant", output: safe.responsesOutputItems! }] });
        expect(JSON.stringify(replay)).not.toContain("private thought");
    });
    test("empty signed Claude thinking survives and readable thinking is never returned", async () => {
        const { privateRules } = await prepareChatProfileInput(canvas());
        const blocks = [{ type: "thinking", thinking: "", signature: "signed" }, { type: "redacted_thinking", data: "opaque" }, { type: "tool_use", id: "read", name: "canvas_get_state", input: {} }];
        const result: ChatCompletionResult = { content: "", toolCalls: [{ id: "read", type: "function", function: { name: "canvas_get_state", arguments: "{}" } }], claudeAssistantContent: blocks };
        expect(validateChatProfileOutput(result, privateRules).claudeAssistantContent).toEqual(blocks);
        expect(() => validateChatProfileOutput({ ...result, claudeAssistantContent: [{ type: "thinking", thinking: "hidden text", signature: "signed" }, ...blocks] }, privateRules)).toThrow("明文思考");
    });
    test("conversational generation forwards its public prompt exactly without a second private recipe", async () => {
        const input = { operationType: "inpaint", prompt: "把衣领改成V领", parameters: { imageAgentProfile: "creative-chat", inputArchive: { prompt: "把衣领改成V领" } } };
        const before = JSON.stringify(input); let loads = 0;
        const provider = await imageAgentProviderPrompt(input, async profile => { loads++; expect(profile).toBe("creative-chat"); return supplement; });
        expect(provider).toBe(input.prompt); expect(provider).not.toContain(supplement);
        expect(JSON.stringify(input)).toBe(before); expect(loads).toBe(0);
        expect(await imageAgentProviderPrompt({ ...input, parameters: {} }, async () => { throw new Error("no load"); })).toBe(input.prompt);
        await expect(imageAgentProviderPrompt({ ...input, operationType: "video_generation" }, async () => supplement)).rejects.toMatchObject({ code: "IMAGE_AGENT_PROFILE_INVALID" });
        expect(await imageAgentProviderPrompt(input, async () => { throw new Error("No active recipe"); })).toBe(input.prompt);
    });
    test("model adapters allow supported hidden thinking and stream, without legacy overrides", () => {
        const input = { input: [], tools: [], privateProfile: true, claude: { stream: true, thinking: true, maxTokens: 2048 } };
        const modern = imageAgentModelInput({ protocol: "anthropic", model_id: "claude-sonnet-5-5" }, input);
        expect(modern.claude).toMatchObject({ stream: true, thinking: true });
        expect(buildClaudeMessagesRequest(modern, { modelId: "claude-sonnet-5-5", maxTokens: 2048, thinking: true })).toMatchObject({ output_config: { effort: "medium" } });
        expect(() => imageAgentModelInput({ protocol: "anthropic", model_id: "claude-3-7-sonnet" }, input)).toThrow("不支持安全隐藏思考");
        expect(imageAgentModelInput({ protocol: "anthropic", model_id: "claude-3-7-sonnet" }, { ...input, claude: { ...input.claude, thinking: false } }).claude.thinking).toBe(false);
        const ordinary = { ...input, privateProfile: false };
        expect(imageAgentModelInput({ protocol: "anthropic", model_id: "claude-3-7-sonnet" }, ordinary)).toBe(ordinary);
    });
    test("front-end source never carries server authoring rules", () => {
        const files = ["lib/creative-chat.ts", "lib/canvas/canvas-assistant-output.ts", "components/canvas/canvas-assistant-panel.tsx", "services/api/creative-chat.ts"];
        const source = files.map(file => readFileSync(new URL(`../../web/src/${file}`, import.meta.url), "utf8")).join("\n");
        for (const marker of ["IMAGE_AGENT_SYSTEM_PROMPT", "CANVAS_ASSISTANT_SYSTEM_PROMPT", "CANVAS_EDIT_CONTRACT_SCHEMA", "你是图片创作助手，能自然聊天"]) expect(source).not.toContain(marker);
    });
});
