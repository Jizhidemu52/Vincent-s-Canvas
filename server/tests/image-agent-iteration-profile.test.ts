import { expect, test } from "bun:test";
import { IMAGE_AGENT_REPAIR_CODES } from "../../shared/image-agent-iteration";
import { ImageAgentArgumentsError, imageAgentContextSchema, imageAgentRepairMetadata, parseImageAgentEdit } from "../src/image-agent-profile";
import { prepareChatProfileInput, validateChatProfileOutput } from "../src/prompt-chat-profiles";
import { imageAgentClaudeStream } from "../src/image-agent-stream";
import type { ChatCompletionResult, ResponseInput } from "../src/routes/chat";

const original = { id: "original", label: "图1", kind: "upload", previewed: true, designBrief: "旧要求：蓝色；不是视觉检查结果。" };
const resultImage = { id: "result", label: "图2", kind: "result", parentId: "original", previewed: true };
const spec = { changes: ["袖口改为罗纹"], region: "左袖口", acceptance: ["袖口为罗纹，其余不变"], assumptions: [] };
const review = { summary: "袖口纹理可见，细节仍需人工确认。", checks: [{ criterion: "袖口为罗纹", result: "pass", evidence: "图2左袖口可见纵向罗纹。" }, { criterion: "纽扣数量保持", result: "unverifiable", evidence: "当前预览中纽扣被遮挡，不能确认数量。" }] };
const region = { image_id: "result", region: "左袖口", box: { x: 0.2, y: 0.4, width: 0.2, height: 0.1 }, confidence: "medium", note: "建议框覆盖左袖口，请确认后手涂细化；不是分割结果。" };
const repairIssue = { code: "IMAGE_AGENT_ARGUMENTS_INVALID", message: "工具参数缺少prompt", repairable: true as const, submitted: false as const };

function request(profile: "creative-chat" | "canvas-assistant", stage: "plan" | "repair" | "review" | "locate" = "plan") {
    const currentUserText = "把袖口改为罗纹，颜色改红；检查结果，并整理画布节点";
    return {
        profile, toolKey: profile === "creative-chat" ? "gpt-chat" : "canvas-chat", tools: [],
        input: [
            { role: "user", content: [{ type: "input_text", text: "图1：original；图2：result" }, { type: "input_image", image_url: "data:image/png;base64,b3JpZ2luYWw=" }, { type: "input_image", image_url: "data:image/png;base64,cmVzdWx0" }] },
            { role: "user", content: currentUserText },
        ] as ResponseInput[],
        profileContext: {
            stage, currentUserText, newCreation: false, imageCatalog: [original, resultImage], previewImageIds: ["original", "result"], focusImageId: "result", workNote: "袖口待改，尚未验收", memoryContext: "以往偏好蓝色，当前明确要求优先。",
            ...(stage === "repair" ? { repairIssue } : {}),
            ...(stage === "review" ? { reviewContext: { baseImageId: "original", resultImageId: "result", prompt: "左袖口改罗纹，颜色改红，其余保持", spec } } : {}),
            ...(stage === "locate" ? { regionContext: { imageId: "result", description: "左袖口" } } : {}),
            documentCatalog: [{ id: "brief", name: "需求.txt", kind: "text", sectionCount: 1, figureCount: 0, sections: [{ id: "brief-s1", figureIds: [] }] }],
        },
    };
}
const call = (name: string, value: unknown): ChatCompletionResult => ({ content: "", toolCalls: [{ id: "read-only", type: "function", function: { name, arguments: JSON.stringify(value) } }] });

test.each(["creative-chat", "canvas-assistant"] as const)("%s optional edit_spec keeps the old natural-prompt path", async profile => {
    const prepared = await prepareChatProfileInput(request(profile));
    const edit = prepared.input.tools.find(tool => tool.name === "edit_image")!;
    expect(edit.parameters.required).toEqual(["prompt"]);
    expect((edit.parameters.properties as Record<string, unknown>).edit_spec).toBeTruthy();
    for (const value of [{ prompt: "袖口改罗纹" }, { prompt: "袖口改罗纹，颜色改红，其余保持", edit_spec: spec }]) {
        const output = call("edit_image", value);
        expect(validateChatProfileOutput(output, prepared.privateRules)).toEqual(output);
    }
    expect(() => parseImageAgentEdit({ prompt: "改袖口", edit_spec: { ...spec, changes: [] } })).toThrow(ImageAgentArgumentsError);
    expect(() => parseImageAgentEdit({ prompt: "改袖口", edit_spec: { ...spec, model: "another-model" } })).toThrow(ImageAgentArgumentsError);
    expect(prepared.input.input.at(-1)).toEqual(request(profile).input.at(-1));
    expect(String((prepared.input.input[0] as { content: string }).content)).toContain("本轮明确要求优先");
});

test.each(["creative-chat", "canvas-assistant"] as const)("%s repair uses only the original image-planning tool", async profile => {
    const input = request(profile, "repair");
    const prepared = await prepareChatProfileInput(input);
    expect(prepared.input.tools.map(tool => tool.name)).toEqual(["edit_image"]);
    expect(prepared.input.toolChoice).toBe("auto");
    expect(prepared.input.claude?.maxTokens).toBe(8192);
    expect(prepared.input.input.at(-1)).toEqual(input.input.at(-1));
    expect(() => validateChatProfileOutput(call("generate_video", { prompt: "视频" }), prepared.privateRules)).toThrow("未开放");
});

test.each(["creative-chat", "canvas-assistant"] as const)("%s review/locate expose one read-only tool despite document and structural requests", async profile => {
    for (const [stage, name, value] of [["review", "report_image_review", review], ["locate", "propose_image_region", region]] as const) {
        const prepared = await prepareChatProfileInput(request(profile, stage));
        expect(prepared.input.tools.map(tool => tool.name)).toEqual([name]);
        expect(prepared.input.toolChoice).toBe("auto");
        const output = call(name, value);
        expect(validateChatProfileOutput(output, prepared.privateRules)).toEqual(output);
        for (const forbidden of ["edit_image", "generate_video", "canvas_get_state", "canvas_delete_nodes", "read_document", "propose_requirements"]) {
            expect(() => validateChatProfileOutput(call(forbidden, { prompt: "do not execute" }), prepared.privateRules)).toThrow("未开放");
        }
        expect(() => validateChatProfileOutput({ content: "检查完成", toolCalls: [] }, prepared.privateRules)).toThrow("单一只读");
        expect(() => validateChatProfileOutput({ ...output, toolCalls: [...output.toolCalls, ...output.toolCalls] }, prepared.privateRules)).toThrow("单一只读");
    }
});

test("review and region results validate bounded evidence and the exact inspected target", async () => {
    const inspected = await prepareChatProfileInput(request("canvas-assistant", "review"));
    expect(() => validateChatProfileOutput(call("report_image_review", { summary: "ok", checks: [] }), inspected.privateRules)).toThrow(ImageAgentArgumentsError);
    const located = await prepareChatProfileInput(request("canvas-assistant", "locate"));
    for (const bad of [{ ...region, image_id: "original" }, { ...region, image_id: "unknown" }, { ...region, box: { x: 0.9, y: 0, width: 0.2, height: 0.1 } }, { ...region, box: { x: 0, y: 0, width: 0, height: 1 } }]) {
        expect(() => validateChatProfileOutput(call("propose_image_region", bad), located.privateRules)).toThrow(ImageAgentArgumentsError);
    }
});

test("stage data is bounded and cannot turn a failed execution or unknown error into repair", () => {
    const base = request("creative-chat").profileContext;
    const repair = request("creative-chat", "repair").profileContext;
    for (const code of IMAGE_AGENT_REPAIR_CODES) expect(imageAgentContextSchema.safeParse({ ...repair, repairIssue: { ...repairIssue, code } }).success).toBe(true);
    for (const patch of [
        { repairIssue: undefined }, { repairIssue: { ...repairIssue, code: "NETWORK_ERROR" } }, { repairIssue: { ...repairIssue, submitted: true } },
        { repairIssue: { ...repairIssue, repairable: false } }, { repairIssue: { ...repairIssue, message: "x".repeat(1001) } },
        { repairIssue: { ...repairIssue, privateReasoning: "hidden" } },
    ]) expect(imageAgentContextSchema.safeParse({ ...repair, ...patch }).success).toBe(false);
    for (const patch of [{ repairIssue }, { memoryContext: "x".repeat(4001) }, { imageCatalog: [{ ...original, designBrief: "x".repeat(1601) }, resultImage] }, { reviewContext: request("creative-chat", "review").profileContext.reviewContext }]) {
        expect(imageAgentContextSchema.safeParse({ ...base, ...patch }).success).toBe(false);
    }
});

test.each(["review", "locate"] as const)("%s requires matching real preview payloads, not only claimed catalog flags", async stage => {
    const input = request("canvas-assistant", stage);
    for (const patch of [
        { previewImageIds: ["original"], imageCatalog: [original, { ...resultImage, previewed: false }] },
        { imageCatalog: [original, { ...resultImage, unavailable: true }] },
        stage === "review" ? { reviewContext: { resultImageId: "unknown", prompt: "检查" } } : { regionContext: { imageId: "unknown", description: "袖口" } },
        stage === "review" ? { reviewContext: undefined } : { regionContext: undefined },
    ]) await expect(prepareChatProfileInput({ ...input, profileContext: { ...input.profileContext, ...patch } })).rejects.toMatchObject({ code: "CHAT_PROFILE_INVALID" });
    await expect(prepareChatProfileInput({ ...input, input: [input.input.at(-1)!] })).rejects.toMatchObject({ code: "CHAT_PROFILE_INVALID" });
    await expect(prepareChatProfileInput({ ...input, input: [...input.input.slice(0, 1), input.input[0]!, input.input.at(-1)!] })).rejects.toMatchObject({ code: "CHAT_PROFILE_INVALID" });
});

test("review without a base remains an evidence-limited new-image check", async () => {
    const input = request("creative-chat", "review");
    const prepared = await prepareChatProfileInput({ ...input, profileContext: { ...input.profileContext, reviewContext: { resultImageId: "result", prompt: "创建罗纹毛衫" } } });
    expect(String((prepared.input.input[0] as { content: string }).content)).toContain("缺少底图时不能证明保留项未变");
});

test.each([["review", "report_image_review", review], ["locate", "propose_image_region", region]] as const)("%s SSE validates its sole result without image-generation tools", async (stage, name, value) => {
    const prepared = await prepareChatProfileInput(request("canvas-assistant", stage));
    const frames = [
        { type: "message_start", message: { role: "assistant" } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "inspection", name, input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(value) } },
        { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "tool_use" } }, { type: "message_stop" },
    ].map(event => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join("");
    let validated = 0;
    const output = await imageAgentClaudeStream(new Response(frames), prepared.privateRules, prepared.input.tools, () => { validated++; }).text();
    expect(output).toContain('"type":"message_stop"'); expect(output).not.toContain('"type":"error"');
    expect(validated).toBe(1); expect(output).not.toContain("edit_image");
    expect(imageAgentRepairMetadata(new Error("generic inspection failure"))).toEqual({});
});
