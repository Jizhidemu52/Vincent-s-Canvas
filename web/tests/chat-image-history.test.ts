import { afterEach, expect, test } from "bun:test";

import { buildChatRequestMessages, type ChatHistoryMessage } from "@/lib/chat-context";
import { requestImageQuestion } from "@/services/api/image";
import { defaultConfig } from "@/stores/use-config-store";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const image = "data:image/png;base64,AQID";
const firstTurn: ChatHistoryMessage = {
    role: "user",
    content: "读取文件并描述图片",
    attachments: [
        { name: "attachment-text.txt", textContent: "TXT: MAPLE-4271 Quantity: 15" },
        { name: "attachment-pdf.pdf", textContent: "PDF: CORAL-7193 Quantity: 25" },
        { name: "attachment-word.docx", textContent: "DOCX: ORBIT-5832 Quantity: 35" },
        { name: "attachment-excel.xlsx", textContent: "XLSX: CEDAR-8642 Quantity: 40" },
        { name: "attachment-image.png", dataUrl: image },
    ],
};
const firstAnswer: ChatHistoryMessage = { role: "assistant", content: "已读取文件和图片。" };

for (const modelId of ["gpt-6-astra", "claude-fable-5-1"]) {
    test(`${modelId} sends the previous uploaded image in the real second-turn HTTP payload`, async () => {
        const requests: Array<{ url: string; body: any }> = [];
        globalThis.fetch = (async (url, init) => {
            requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
            return Response.json({ content: "verified", toolCalls: [] });
        }) as typeof fetch;
        const config = { ...defaultConfig, model: modelId, textModel: modelId, systemPrompt: "", claudeStream: "false" };
        const history = [firstTurn, firstAnswer];
        const savedHistory = structuredClone(history);

        await requestImageQuestion(config, buildChatRequestMessages([], firstTurn), () => undefined);
        await requestImageQuestion(config, buildChatRequestMessages(history, { role: "user", content: "计算总量、排序、差值，并描述刚才的图片" }), () => undefined);

        expect(requests.map((request) => request.url)).toEqual(["/api/chat/responses", "/api/chat/responses"]);
        expect(requests[0]!.body.input[0].content.filter((part: any) => part.type === "input_image")).toEqual([{ type: "input_image", image_url: image }]);
        const followup = requests[1]!.body;
        expect(followup.modelId).toBe(modelId);
        expect(followup.input.map((message: any) => message.role)).toEqual(["user", "assistant", "user"]);
        const imageParts = followup.input.map((message: any) => Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "input_image") : []);
        expect(imageParts.map((parts: unknown[]) => parts.length)).toEqual([1, 0, 0]);
        expect(imageParts[0]).toEqual([{ type: "input_image", image_url: image }]);
        expect(JSON.stringify(followup.input)).toContain("CORAL-7193");
        expect(history).toEqual(savedHistory);
    });
}

function imageUrls(messages: ReturnType<typeof buildChatRequestMessages>) {
    return messages.flatMap((message) => typeof message.content === "string" ? [] : message.content.flatMap((part) => part.type === "image_url" ? [part.image_url.url] : []));
}

test("a file-only follow-up still retains the most recent image batch", () => {
    const messages = buildChatRequestMessages([firstTurn, firstAnswer], { role: "user", content: "对照上一张图补充", attachments: [{ name: "update.txt", textContent: "新增要求" }] });
    expect(imageUrls(messages)).toEqual([image]);
    expect(messages.at(-1)?.content).toContain("新增要求");
});

test("newly uploaded images replace older batches instead of growing the request indefinitely", () => {
    const replacement = "data:image/png;base64,BAUG";
    const current: ChatHistoryMessage = { role: "user", content: "看这张新图", attachments: [{ name: "new.png", dataUrl: replacement }] };
    expect(imageUrls(buildChatRequestMessages([firstTurn, firstAnswer], current))).toEqual([replacement]);
    expect(imageUrls(buildChatRequestMessages([firstTurn, firstAnswer, current, firstAnswer], { role: "user", content: "再描述一次" }))).toEqual([replacement]);
});

test("retained image batches respect the existing five-image and eight-MiB limits", () => {
    const largeImage = `data:image/png;base64,${"A".repeat(4 * 1024 * 1024)}`;
    const attachments = Array.from({ length: 7 }, (_, index) => ({ name: `${index}.png`, dataUrl: image }));
    const current: ChatHistoryMessage = { role: "user", content: "继续" };
    expect(imageUrls(buildChatRequestMessages([{ role: "user", content: "七张", attachments }], current))).toHaveLength(5);
    expect(imageUrls(buildChatRequestMessages([{ role: "user", content: "大图", attachments: attachments.slice(0, 3).map((item) => ({ ...item, dataUrl: largeImage })) }], current))).toHaveLength(2);
});

test("images outside the text/message context window are not reintroduced", () => {
    const history: ChatHistoryMessage[] = [firstTurn, ...Array.from({ length: 25 }, () => ({ role: "assistant" as const, content: "recent" }))];
    const messages = buildChatRequestMessages(history, { role: "user", content: "继续" });
    expect(messages).toHaveLength(25);
    expect(imageUrls(messages)).toEqual([]);
    const textLimited = buildChatRequestMessages([firstTurn, { role: "assistant", content: "x".repeat(48_001) }], { role: "user", content: "继续" });
    expect(imageUrls(textLimited)).toEqual([]);
    expect(String(textLimited[0]?.content).length).toBeLessThanOrEqual(48_000);
});

test("restored metadata-only attachments remain valid without inventing lost image data", () => {
    const restored: ChatHistoryMessage[] = [{ role: "user", content: "第一轮", attachments: [{ name: "attachment-image.png" }, { name: "attachment-pdf.pdf" }] }, firstAnswer];
    const saved = structuredClone(restored);
    const messages = buildChatRequestMessages(restored, { role: "user", content: "继续" });
    expect(imageUrls(messages)).toEqual([]);
    expect(messages[0]?.content).toBe("第一轮");
    expect(restored).toEqual(saved);
});
