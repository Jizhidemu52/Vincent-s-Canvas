import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, IMAGE } from "./fixtures";
import { imageAgentSpecText } from "../src/lib/image-agent/compile";
import { imageAgentWorkNoteText } from "../src/lib/image-agent/work-note";

const archivedPrompt = "原始生成要求：保留毛衫纹理";
const submittedPrompt = "实际发送私有原文：保留毛衫纹理，不要水印";
const spec = { changes: ["只修改左袖口"], region: "左袖口", acceptance: ["左袖口为罗纹"], assumptions: ["只处理可见左袖口"] };
const note = { summary: "本轮将左袖口改为罗纹", keep: ["毛衫版型与纽扣"] };
const report = { summary: "袖口罗纹可见，纽扣仍需核查", checks: [{ criterion: "袖口纹理", result: "warning" as const, evidence: "局部纹路较模糊，应对照原图" }] };
const translations: Record<string, string> = {
    [archivedPrompt]: "Original generation request: preserve the knit texture",
    [submittedPrompt]: "Submitted original: preserve the knit texture, without watermarks",
    [imageAgentSpecText(spec)]: "Region: left cuff\nChange only the left cuff to ribbing; verify the visible area",
    [imageAgentWorkNoteText(note)]: "This edit changes the left cuff to ribbing\nKeep the fit and buttons",
    [report.summary]: "Ribbing is visible; the buttons still need checking",
    [report.checks[0].criterion]: "Cuff texture",
    [report.checks[0].evidence]: "The detail is blurry; compare against the original image",
    [spec.assumptions[0]]: "Only the visible left cuff is being edited",
    "原始附件说明.txt": "Original attachment note.txt",
    "原始对话正文": "Original conversation text",
};

async function displayFixture(context: BrowserContext, sources: string[]) {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await context.route("**/api/display-translations", route => {
        const body = route.request().postDataJSON() as { texts: string[]; target: string };
        expect(body.target).toBe("en-US"); sources.push(...body.texts);
        return route.fulfill({ json: { translations: body.texts.map(text => translations[text] ?? (text.includes("超大原图.png") ? "Oversized original image.png exceeds 5MB; not attached" : "Unrelated fixture display")) } });
    });
}
async function language(page: Page, target: "en" | "zh-CN") {
    await page.getByTestId("language-switch").filter({ visible: true }).first().click();
    await expect(page.locator("html")).toHaveAttribute("lang", target);
}
async function chatSnapshot(page: Page) {
    return page.evaluate(async () => {
        const { chatSessionStorage } = await import("/src/pages/chat/chat-session-storage.ts");
        const { useUserStore } = await import("/src/stores/use-user-store.ts");
        return JSON.stringify(await chatSessionStorage.load(`wireless-canvas:llm-chat:${useUserStore.getState().user!.id}`, () => null));
    });
}

test("canvas generation archive translates display after expansion but copy, input and stored record stay original", async ({ page, context, api }) => {
    const sources: string[] = []; await displayFixture(context, sources);
    const projectId = "73000000-0000-4000-8000-000000000001", assetId = "73000000-0000-4000-8000-000000000002";
    api.assetBytes.set(assetId, IMAGE);
    const record = { version: 1, id: "private-run-id", sourceNodeId: "source", createdAt: "2026-11-13T00:00:00Z", prompt: archivedPrompt, inputPrompt: "原始可编辑输入", submittedPrompt,
        references: [], parameters: { model: "gpt-image-2", size: "1:1", quality: "medium", imageOptions: "", systemPrompt: "", count: 1, generationType: "generation" } };
    const node = { id: "archived-result", type: "image", title: "归档毛衫", position: { x: 0, y: 0 }, width: 200, height: 200,
        metadata: { content: `/api/assets/${assetId}/content`, status: "success", naturalWidth: 256, naturalHeight: 256, mimeType: "image/png", generationRecord: record } };
    const document = { id: projectId, title: "生成记录语言验收", createdAt: "2026-11-13T00:00:00Z", updatedAt: "2026-11-13T00:00:00Z", nodes: [node], connections: [], groups: [], chatSessions: [], activeChatId: null,
        backgroundMode: "dots", showImageInfo: false, viewport: { x: 600, y: 200, k: 1 }, selectedNodeIds: [], history: { past: [], future: [] } };
    api.documents.set(projectId, { id: projectId, revision: 1, document, deleted: false, updatedAt: document.updatedAt });
    await page.goto(`/canvas/${projectId}`);
    await expect(page.locator('[data-node-id="archived-result"]')).toBeVisible();
    await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    await page.locator('[data-node-id="archived-result"]').click({ position: { x: 30, y: 18 } });
    const panel = page.getByTestId("canvas-quick-generate-panel"), archive = panel.getByTestId("canvas-generation-record");
    await expect(archive).toBeVisible();
    const input = panel.locator("textarea.cw-prompt"), details = archive.locator("details").first();
    await expect(input).toHaveValue("原始可编辑输入");
    const original = JSON.stringify(record), media = node.metadata.content;
    await language(page, "en");
    await expect(archive).toContainText(translations[archivedPrompt]);
    await expect(details).not.toHaveAttribute("open");
    expect(sources).not.toContain(submittedPrompt);
    await archive.getByRole("button", { name: "Copy original generation prompt", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(archivedPrompt);
    await details.locator("summary").click();
    await expect(details).toContainText(translations[submittedPrompt]);
    await details.getByRole("button").click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(submittedPrompt);
    await language(page, "zh-CN");
    await expect(archive).toContainText(archivedPrompt); await expect(details).toContainText(submittedPrompt);
    await expect(input).toHaveValue("原始可编辑输入");
    expect(JSON.stringify(api.document(projectId)!.nodes[0].metadata.generationRecord)).toBe(original);
    expect(api.document(projectId)!.nodes[0].metadata.content).toBe(media);
    expect(api.assetBytes.get(assetId)).toEqual(IMAGE);
    expect(sources).not.toContain("private-run-id");
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("chat review, work note, specification and attachment display translate without rewriting saved originals", async ({ page, context, api }) => {
    const sources: string[] = []; await displayFixture(context, sources);
    await context.route("**/api/models", route => route.fulfill({ json: { models: [
        { id: "chat", modelId: "gpt-6-astra", name: "隔离对话", capabilities: ["chat", "vision"], creditCost: 0, rmbCost: 0 },
        { id: "image", modelId: "gpt-image-2", name: "隔离图片", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    ], prices: [], tools: [{ toolKey: "gpt-chat", modelConfigId: "chat", enabled: true }, { toolKey: "gpt-chat-image", modelConfigId: "image", enabled: true }] } }));
    await page.goto("/chat");
    await expect(page.getByRole("textbox", { name: "对话内容", exact: true })).toBeEnabled();
    await page.evaluate(async input => {
        const { chatSessionStorage } = await import("/src/pages/chat/chat-session-storage.ts");
        const { useUserStore } = await import("/src/stores/use-user-store.ts");
        await chatSessionStorage.save(`wireless-canvas:llm-chat:${useUserStore.getState().user!.id}`, [{ id: "original-detail-session", title: "原始对话标题", updatedAt: "2026-11-13T00:00:00Z", messages: [{
            id: "original-detail-message", role: "assistant", content: "原始对话正文", createdAt: "2026-11-13T00:00:00Z",
            generatedImages: [{ id: "original-detail-image", dataUrl: input.dataUrl, prompt: "原始模型提示词", spec: input.spec, workNote: input.note, review: { report: input.report, reviewedAt: "2026-11-13T00:00:00Z", baseUnavailable: true } }],
            attachments: [{ id: "original-attachment-id", kind: "text", name: "原始附件说明.txt", type: "text/plain", size: 24, textContent: "不改动原始附件内容" }],
        }] }]);
    }, { dataUrl: `data:image/png;base64,${IMAGE.toString("base64")}`, spec, note, report });
    await page.reload();
    const bubble = page.locator('[data-message-id="original-detail-message"]');
    await expect(bubble.getByTestId("chat-image-review")).toContainText(report.summary);
    const original = await chatSnapshot(page), imageSrc = await bubble.locator("img").first().getAttribute("src");
    const work = bubble.locator("details").first(), specification = bubble.getByTestId("chat-image-spec").locator("details");
    await page.getByRole("textbox", { name: "对话内容", exact: true }).fill("未发送的原始草稿");
    await language(page, "en");
    await expect(bubble.getByTestId("chat-image-review")).toContainText(translations[report.summary]);
    await expect(bubble.getByTestId("chat-image-review")).toContainText(translations[report.checks[0].criterion]);
    await expect(bubble.getByTestId("chat-image-review")).toContainText(translations[report.checks[0].evidence]);
    await expect(bubble).toContainText("Original attachment note.txt");
    expect(sources).not.toContain(imageAgentWorkNoteText(note)); expect(sources).not.toContain(imageAgentSpecText(spec));
    await work.locator("summary").click(); await specification.locator("summary").click();
    await expect(work).toContainText(translations[imageAgentWorkNoteText(note)]);
    await expect(specification).toContainText(translations[imageAgentSpecText(spec)]);
    await bubble.getByRole("button", { name: "Copy message", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("原始对话正文");
    expect(await bubble.locator("img").first().getAttribute("src")).toBe(imageSrc);
    expect(await chatSnapshot(page)).toBe(original);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload images", exact: true }).click();
    await (await chooser).setFiles({ name: "超大原图.png", mimeType: "image/png", buffer: Buffer.alloc(6 * 1024 * 1024) });
    await expect(page.getByText("Oversized original image.png exceeds 5MB; not attached", { exact: true })).toBeVisible();
    expect(sources.some(source => source.includes("超大原图.png"))).toBe(true);
    expect(await chatSnapshot(page)).toBe(original);
    await language(page, "zh-CN");
    await expect(work).toContainText(imageAgentWorkNoteText(note)); await expect(specification).toContainText(imageAgentSpecText(spec));
    await expect(bubble).toContainText(report.summary); await expect(bubble).toContainText("原始附件说明.txt");
    await expect(page.getByRole("textbox", { name: "对话内容", exact: true })).toHaveValue("未发送的原始草稿");
    expect(await chatSnapshot(page)).toBe(original);
    expect(sources).not.toContain("original-attachment-id");
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});
