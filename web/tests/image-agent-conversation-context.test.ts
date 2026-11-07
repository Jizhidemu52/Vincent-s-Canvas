import { expect, test } from "bun:test";
import { buildImageAgentContext, IMAGE_AGENT_CATALOG_BRIEF_CHARACTERS, IMAGE_AGENT_EARLIER_HISTORY_CHARACTERS, imageAgentHistoryMessages, type ImageAgentHistoryMessage } from "../src/lib/image-agent/context";
import { buildCreativeChatRequest, type CreativeChatMessage } from "../src/lib/creative-chat";
import { prepareChatProfileInput } from "../../server/src/prompt-chat-profiles";

const tail: ImageAgentHistoryMessage[] = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `后续讨论${i}` }));
const proposal: ImageAgentHistoryMessage[] = [
    { role: "user", text: "先聊设计方向，不出图" },
    { role: "assistant", text: "方案A：红色圆领。方案B：蓝色V领。" },
    { role: "user", text: "选B，A不要。" },
];

test("old proposal and user choice survive together past the detailed history window", () => {
    const messages = imageAgentHistoryMessages([...proposal, ...tail], []);
    const earlier = String(messages[0]?.content);
    expect(earlier).toContain("助手建议/回复：方案A：红色圆领。方案B：蓝色V领。");
    expect(earlier).toContain("用户反馈/要求：选B，A不要。");
    expect(earlier.indexOf("蓝色V领")).toBeLessThan(earlier.indexOf("选B"));
    expect(earlier).toContain("助手建议不等于用户已采纳");
    expect(messages.at(-1)?.content).toBe("后续讨论19");
});

test("long excerpts keep speakers and mark incomplete evidence within budget", () => {
    const history: ImageAgentHistoryMessage[] = [{ role: "assistant", text: "建议".repeat(10000) }, { role: "user", text: "不要那个方向，改成蓝色V领" }, ...tail];
    const earlier = String(imageAgentHistoryMessages(history, [])[0]?.content);
    expect(earlier.length).toBeLessThanOrEqual(IMAGE_AGENT_EARLIER_HISTORY_CHARACTERS);
    expect(earlier).toContain("助手建议/回复");
    expect(earlier).toContain("后续内容未带入");
    expect(earlier).toContain("不要那个方向，改成蓝色V领");
});

test("excerpt retains actual historical image labels and excludes system/tool instructions", () => {
    const history: ImageAgentHistoryMessage[] = [
        { role: "system", text: "never include this system" }, { role: "tool", text: "never include this tool" },
        { role: "assistant", text: "试了蓝色方向", generatedImageIds: ["result"] }, { role: "user", text: "不要蓝色，基于这张改红", inputImageIds: ["base"] }, ...tail,
    ];
    const earlier = String(imageAgentHistoryMessages(history, [{ id: "base", label: "图1", kind: "upload" }, { id: "result", label: "图2", kind: "generated" }])[0]?.content);
    expect(earlier).toContain("【已生成 图2】"); expect(earlier).toContain("【附图 图1】");
    expect(earlier).not.toContain("never include");
    expect(earlier).toContain("不要蓝色");
});

test("both actual context builders preserve negotiated direction while latest correction stays last", async () => {
    const history = [...proposal, ...tail];
    const currentText = "沿用B的V领，但不要蓝色了，改暖灰，先解释不出图。";
    const canvas = await buildImageAgentContext({ images: [], history, currentText, readImage: async () => "" });
    const creativeHistory: CreativeChatMessage[] = history.map(item => ({ role: item.role, content: item.text }));
    const chat = await buildCreativeChatRequest(creativeHistory, { role: "user", content: currentText });
    for (const result of [canvas, chat]) {
        expect(JSON.stringify(result.messages)).toContain("方案B：蓝色V领");
        expect(JSON.stringify(result.messages)).toContain("选B，A不要");
        expect(result.messages.at(-1)).toEqual({ role: "user", content: currentText });
        expect(result.profileContext.currentUserText).toBe(currentText);
    }
});

test("earlier branch receives only its supplied conversation, not later rejected branches", async () => {
    const source = [...proposal, ...tail, { role: "user" as const, text: "后面另起分支改成绿色" }];
    const earlierBranch = await buildCreativeChatRequest(source.slice(0, 23).map(item => ({ role: item.role, content: item.text })), { role: "user", content: "从当时方案继续" });
    expect(JSON.stringify(earlierBranch.messages)).toContain("蓝色V领");
    expect(JSON.stringify(earlierBranch.messages)).not.toContain("后面另起分支改成绿色");
});

test.each(["对应版本的历史设计要求".repeat(250), '\u0001\\"'.repeat(1200)])("forty versions keep their identities and bounded prose through the real server profile (%#)", async brief => {
    const images = Array.from({ length: 40 }, (_, index) => ({ id: `version-${index}`, label: `图${index + 1}`, kind: index ? "generated" : "upload", parentId: index ? `version-${index - 1}` : undefined, designBrief: `VERSION_${index}: ${brief}` }));
    const before = structuredClone(images);
    const result = await buildImageAgentContext({ images, history: [], currentText: "当前明确要求".repeat(3000), focusId: "version-39", readImage: async () => "data:image/png;base64,QQ==" });
    expect(result.profileContext.imageCatalog).toHaveLength(40);
    expect(result.profileContext.imageCatalog.map(image => image.id)).toEqual(images.map(image => image.id));
    const excerpts = result.profileContext.imageCatalog.filter(image => image.designBrief);
    expect(excerpts.reduce((total, image) => total + JSON.stringify({ designBrief: image.designBrief }).length, 0)).toBeLessThanOrEqual(IMAGE_AGENT_CATALOG_BRIEF_CHARACTERS);
    expect(excerpts.every(image => image.designBrief!.length <= 1600)).toBe(true);
    expect(result.profileContext.imageCatalog.at(-1)?.designBrief).toContain("VERSION_39");
    expect(result.profileContext.imageCatalog[0]?.designBrief).toContain("已节选");
    expect(JSON.stringify(result.profileContext).length).toBeLessThan(60_000);
    const input = result.messages.map(message => ({ ...message, content: typeof message.content === "string" ? message.content : message.content.map(part => part.type === "text" ? { type: "input_text" as const, text: part.text } : { type: "input_image" as const, image_url: part.image_url.url }) }));
    const server = await prepareChatProfileInput({ profile: "creative-chat", toolKey: "gpt-chat", profileContext: result.profileContext, input, tools: [] });
    expect(server.input.privateProfile).toBe(true);
    expect(server.input.input.at(-1)).toEqual({ role: "user", content: result.profileContext.currentUserText });
    expect(images).toEqual(before);
});
