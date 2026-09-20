import { expect, test } from "bun:test";
import { buildCanvasConversationHistory } from "@/lib/canvas/canvas-assistant-history";
import { CanvasNodeType, type CanvasAssistantMessage, type CanvasAssistantReference } from "@/types/canvas";
import type { AiTextMessage } from "@/services/api/image";
import { portableCanvasMedia } from "@/lib/canvas/canvas-portable-media";

const ref = (id: string): CanvasAssistantReference => ({ id, title: id, type: CanvasNodeType.Image, dataUrl: `blob:old-${id}`, storageKey: `image:${id}` });
const preview = async (item: CanvasAssistantReference) => `data:image/jpeg;base64,${btoa(item.storageKey || item.dataUrl || "")}`;
const images = (messages: AiTextMessage[]) => messages.flatMap(message => typeof message.content === "string" ? [] : message.content.flatMap(part => part.type === "image_url" ? [part.image_url.url] : []));
const current: CanvasAssistantMessage = { id: "feedback", role: "user", text: "花型太大，先对照原图反思，再改小一点" };
const history: CanvasAssistantMessage[] = [
    { id: "original", role: "user", text: "保留原版花型和袖口", references: [ref("source")] },
    { id: "v1", role: "assistant", text: "第一版已生成", attachments: [{ id: "output", name: "第一版", mediaType: "image", url: "blob:old-v1", storageKey: "image:v1" }] },
    { id: "critique", role: "user", text: "袖口不对，花型也太大" },
    { id: "v2", role: "assistant", text: "第二版已生成", attachments: [{ id: "output", name: "第二版", mediaType: "image", url: "blob:old-v2", storageKey: "image:v2" }] },
];

test("original, each generated version and feedback reach the model in chronological order", async () => {
    const before = JSON.stringify(history);
    const result = await buildCanvasConversationHistory(history, current, preview);
    expect(images(result.messages)).toEqual([await preview(ref("source")), await preview(ref("v1")), await preview(ref("v2"))]);
    expect(result.messages.map(item => item.role)).toEqual(["user", "user", "assistant", "user", "user", "assistant", "user"]);
    const text = JSON.stringify(result.messages);
    expect(text.indexOf("原版花型")).toBeLessThan(text.indexOf("第一版已生成"));
    expect(text.indexOf("第一版已生成")).toBeLessThan(text.indexOf("袖口不对"));
    expect(text.indexOf("袖口不对")).toBeLessThan(text.indexOf("第二版已生成"));
    expect(text).toContain("助手生成结果");
    expect(result.references.find(item => item.id === "history-v1-0")?.storageKey).toBe("image:v1");
    expect(result.references.find(item => item.id === "history-v2-0")?.storageKey).toBe("image:v2");
    expect(JSON.stringify(history)).toBe(before);
});

test("new uploads do not erase earlier original and result images", async () => {
    const result = await buildCanvasConversationHistory(history, { ...current, references: [ref("new-source")] }, preview);
    expect(images(result.messages)).toHaveLength(3);
    expect(images([{ role: "user", content: result.currentContent }])).toEqual([await preview(ref("new-source"))]);
    expect(result.references.every(item => item.id.startsWith("history-"))).toBe(true);
});

test("repeated automatic snapshots reuse image evidence without crowding out distinct original/result versions", async () => {
    const result = await buildCanvasConversationHistory([
        ...history,
        ...Array.from({ length: 18 }, (_, index): CanvasAssistantMessage => ({ id: `repeat${index}`, role: "user", text: "继续对照", contextReferences: [ref("v2"), ref("source")] })),
    ], current, preview);
    expect(images(result.messages)).toHaveLength(3);
    expect(result.summary.omitted).toBe(0);
    expect(result.references.find(item => item.id === "history-original-0")?.storageKey).toBe("image:source");
});

test("image-only messages survive; errors, other sessions and videos are not invented as images", async () => {
    const result = await buildCanvasConversationHistory([
        { id: "only", role: "user", text: "", references: [ref("only")] },
        { id: "failed", role: "error", text: "error", references: [ref("private")] },
        { id: "video", role: "assistant", text: "视频", attachments: [{ id: "clip", name: "video", mediaType: "video", url: "clip.mp4" }] },
    ], current, preview);
    expect(images(result.messages)).toEqual([await preview(ref("only"))]);
    expect(JSON.stringify(result.messages)).not.toContain("private");
    expect((await buildCanvasConversationHistory([], current, preview)).messages).toEqual([]);
});

test("a broken image is disclosed without dropping valid images or feedback", async () => {
    const result = await buildCanvasConversationHistory(history, current, async item => {
        if (item.storageKey === "image:v1") throw new Error("missing");
        return preview(item);
    });
    expect(images(result.messages)).toHaveLength(2);
    expect(JSON.stringify(result.messages)).toContain("图片读取失败");
    expect(JSON.stringify(result.messages)).toContain("袖口不对");
    expect(result.summary.failed).toBe(1);
    expect(result.references.some(item => item.storageKey === "image:v1")).toBe(false);
});

test("one shared image budget prioritizes current uploads then recent versions, and discloses omitted media", async () => {
    const result = await buildCanvasConversationHistory(Array.from({ length: 28 }, (_, index) => ({ id: `m${index}`, role: "user", text: `feedback ${index}`, references: [ref(`image${index}`)] })), { ...current, references: [ref("current")] }, preview,
        [{ type: "text", text: "自动画布帧" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]);
    expect(images([...result.messages, { role: "user", content: result.currentContent }])).toHaveLength(20);
    expect(result.summary).toMatchObject({ historyMessages: 24, omittedMessages: 4, omitted: 6, failed: 0 });
    expect(images([{ role: "user", content: result.currentContent }])).toEqual([await preview(ref("current"))]);
    expect(JSON.stringify(result.messages)).toContain("未提供图片");
});

test("serialized image size is bounded across history and automatic canvas images", async () => {
    const result = await buildCanvasConversationHistory(history, current, async item => item.storageKey === "image:v2" ? `data:image/jpeg;base64,${"A".repeat(6 * 1024 * 1024)}` : preview(item));
    expect(result.summary.omitted).toBe(1);
    expect(images(result.messages)).toHaveLength(2);
    expect(JSON.stringify(result.messages).length).toBeLessThan(6 * 1024 * 1024);
});

test("automatic image snapshots and generated results still resolve after cloud serialization and reload", async () => {
    const original = [{ ...history[0]!, contextReferences: [ref("auto-old-version")] }, history[1]!];
    const cloud = await portableCanvasMedia(original, async item => `/api/assets/${item.storageKey?.replace("image:", "")}/content`);
    const reloaded = JSON.parse(JSON.stringify(cloud)) as CanvasAssistantMessage[];
    expect(JSON.stringify(reloaded)).not.toContain("blob:");
    expect(reloaded[0]!.contextReferences?.[0]?.dataUrl).toBe("/api/assets/auto-old-version/content");
    const result = await buildCanvasConversationHistory(reloaded, current, preview);
    expect(images(result.messages)).toEqual([
        "data:image/jpeg;base64," + btoa("/api/assets/source/content"),
        "data:image/jpeg;base64," + btoa("/api/assets/auto-old-version/content"),
        "data:image/jpeg;base64," + btoa("/api/assets/v1/content"),
    ]);
});
