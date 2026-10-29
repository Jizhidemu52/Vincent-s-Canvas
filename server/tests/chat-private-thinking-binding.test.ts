import { expect, test } from "bun:test";
import { prepareChatProfileInput } from "../src/prompt-chat-profiles";
import { buildClaudeMessagesRequest, type ResponseInput } from "../src/routes/chat";

const blocks = [
    { type: "thinking", thinking: "", signature: "signed-for-plan-prefix" },
    { type: "redacted_thinking", data: "redacted-for-plan-prefix" },
    { type: "text", text: "我先查看图2。" },
    { type: "tool_use", id: "inspect-old-image", name: "inspect_images", input: { image_ids: ["green-old"] } },
];
const replay: ResponseInput[] = [
    { role: "user", content: "只改图2的纽扣，不能用较新的图3。" },
    { type: "claude_assistant", content: blocks },
    { type: "function_call_output", call_id: "inspect-old-image", output: "图2是墨绿衬衫。" },
];

test.each(["creative-chat", "canvas-assistant"] as const)("%s Sonnet replay retains tool evidence without stale prefix-bound reasoning", async profile => {
    const prepared = await prepareChatProfileInput({
        profile, toolKey: profile === "creative-chat" ? "gpt-chat" : "canvas-chat", input: replay, tools: [],
        profileContext: profile === "creative-chat" ? {
            phase: "after-inspection", currentUserText: "只改图2的纽扣", catalogTotal: 3,
            imageCatalog: [{ image_id: "green-old" }], workingImageDetails: [], previewImageIds: ["green-old"],
        } : { stage: "continue", userText: "只改图2的纽扣", editContext: { selectedTarget: { baseImageIds: ["green-old"] } } },
    }, async () => "仅修改用户指定的图片要求。");
    const before = JSON.stringify(prepared.input);
    const body = buildClaudeMessagesRequest(prepared.input, { modelId: "claude-sonnet-5-5", maxTokens: 2048, thinking: false });
    expect(body.messages.find(message => message.role === "assistant")?.content).toEqual(blocks.slice(2));
    expect(body.messages.at(-1)).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "inspect-old-image", content: "图2是墨绿衬衫。" }] });
    expect(JSON.stringify(body)).not.toContain("signed-for-plan-prefix");
    expect(JSON.stringify(body)).not.toContain("redacted-for-plan-prefix");
    expect(JSON.stringify(prepared.input)).toBe(before);
});

test("ordinary Sonnet and other model continuation contracts remain unchanged", () => {
    for (const [privateProfile, modelId] of [[false, "claude-sonnet-5-5"], [true, "claude-fable-5"], [true, "claude-sonnet-5"]] as const) {
        const body = buildClaudeMessagesRequest({ input: replay, tools: [], privateProfile }, { modelId, maxTokens: 2048 });
        expect(body.messages.find(message => message.role === "assistant")?.content).toEqual(blocks);
    }
});

test("private Sonnet drops an empty reasoning-only history entry without changing visible turns", () => {
    const body = buildClaudeMessagesRequest({ input: [
        { role: "user", content: "原要求" },
        { type: "claude_assistant", content: blocks.slice(0, 2) },
        { role: "user", content: "当前要求" },
    ], tools: [], privateProfile: true }, { modelId: "claude-sonnet-5-5", maxTokens: 2048 });
    expect(body.messages).toEqual([{ role: "user", content: "原要求" }, { role: "user", content: "当前要求" }]);
});
