import { test, expect, newCanvas, IMAGE } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";
import type { BrowserContext, Page } from "@playwright/test";
import { wordDocumentFixture } from "../tests/fixtures/agent-document-fixtures";

async function setup(context: BrowserContext) {
    const plans: any[] = [];
    let generate = false;
    let discuss = false;
    await context.route("**/api/generation-capabilities?*", route => route.fulfill({ json: { models: [] } }));
    await context.route("**/api/models", route => route.fulfill({ json: { models: [
        { id: "doc-chat", modelId: "gpt-6-astra", name: "隔离对话", capabilities: ["chat", "vision"], creditCost: 0, rmbCost: 0 },
        { id: "doc-image", modelId: "gpt-image-2", name: "隔离图片", imageParameterProfile: "standard", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    ], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: /chat|text|agent/.test(tool.toolKey) && tool.toolKey !== "gpt-chat-image" ? "doc-chat" : "doc-image", configurationVersion: 1 })) } }));
    await context.route("**/api/chat/responses", route => {
        const input = route.request().postDataJSON(); plans.push(input);
        if (discuss) return route.fulfill({ json: { content: "参考图仅提供配色，当前底图不变。", toolCalls: [] } });
        const document = input.profileContext.documentCatalog[0];
        const fn = generate ? { name: "edit_image", arguments: JSON.stringify({ prompt: "红色无口袋开衫", base: "none" }) }
            : input.profileContext.documentsInspected ? { name: "propose_requirements", arguments: JSON.stringify({ title: "开衫需求", documentIds: [document.id], subject: "女式开衫", colors: "红色", materials: "羊毛混纺", must: ["5粒纽扣"], avoid: ["口袋"], unknowns: ["袖长未注明"], referenceFigureIds: [], sources: [{ documentId: document.id, sectionId: document.sections[0].id }] }) }
            : { name: "read_document", arguments: JSON.stringify({ document_id: document.id, section_start: 1, section_count: 1 }) };
        return route.fulfill({ json: { content: "已整理资料。", toolCalls: [{ id: `doc-${plans.length}`, type: "function", function: fn }] } });
    });
    return { plans, generate: () => { generate = true; }, discuss: () => { discuss = true; } };
}
async function upload(page: Page, button: string) {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: button, exact: true }).click();
    await (await chooser).setFiles({ name: "设计需求.txt", mimeType: "text/plain", buffer: Buffer.from("女式羊毛混纺开衫，红色，必须5粒纽扣，禁止口袋。袖长待确认。") });
    await expect(page.getByTestId("agent-document-panel")).toContainText("设计需求.txt");
}

test("chat documents are read once, editable card persists and only confirmed requirements enter image tasks", async ({ page, context, api }) => {
    const planner = await setup(context);
    await page.goto("/chat");
    await upload(page, "上传文件");
    await page.getByRole("textbox", { name: "对话内容", exact: true }).fill("整理需求卡");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const panel = page.getByTestId("agent-document-panel");
    await expect(panel.getByRole("button", { name: "确认需求卡", exact: true })).toBeEnabled();
    expect(planner.plans).toHaveLength(2);
    expect(api.submissions).toHaveLength(0);
    planner.generate();
    await page.getByRole("textbox", { name: "对话内容", exact: true }).fill("先按文件出图");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByText("文件已保留。请先让我整理需求卡，核对并确认后再出图。", { exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(0);
    await panel.getByRole("button", { name: "编辑需求", exact: true }).click();
    await panel.getByRole("textbox", { name: "需求卡颜色", exact: true }).fill("燕麦色");
    await panel.getByRole("button", { name: "确认需求卡", exact: true }).click();
    await expect(panel).toContainText("需求卡已确认");
    await page.reload();
    await expect(panel).toContainText("需求卡已确认");
    await panel.locator("summary").first().click();
    await expect(panel).toContainText("燕麦色");
    planner.generate();
    await page.getByRole("textbox", { name: "对话内容", exact: true }).fill("按确认需求出一张");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(planner.plans.at(-1).profileContext.requirements.colors).toBe("燕麦色");
    expect(api.submissions[0].parameters.designRequirements).toMatchObject({ colors: "燕麦色", avoid: ["口袋"] });
    expect(api.submissions[0].parameters.designRequirements).not.toHaveProperty("status");
    expect(api.pageErrors).toEqual([]); expect(api.blocked).toEqual([]);
});

test("Word figure pixels reach planning without becoming a base; only an explicit reference action enters the image catalog", async ({ page, context, api }) => {
    const planner = await setup(context);
    await page.goto("/chat");
    let chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传图片", exact: true }).click();
    await (await chooser).setFiles({ name: "底图.png", mimeType: "image/png", buffer: IMAGE });
    await expect(page.getByRole("button", { name: "移除 底图.png", exact: true })).toBeVisible();
    chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传文件", exact: true }).click();
    await (await chooser).setFiles({ name: "款式.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from(wordDocumentFixture().original) });
    const panel = page.getByTestId("agent-document-panel");
    await expect(panel).toContainText("款式.docx");
    await page.getByRole("textbox", { name: "对话内容", exact: true }).fill("整理需求卡，底图不变");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(panel.getByRole("button", { name: "确认需求卡", exact: true })).toBeEnabled();
    expect(planner.plans[0].profileContext.imageCatalog).toHaveLength(1);
    const focus = planner.plans[0].profileContext.focusImageId;
    expect(JSON.stringify(planner.plans[0].input).match(/"type":"input_image"/g)).toHaveLength(2);
    expect(planner.plans[1].profileContext.documentsInspected).toBe(true);
    await panel.getByRole("button", { name: "确认需求卡", exact: true }).click();
    await panel.locator("summary").first().click();
    await panel.locator("details summary").click();
    await panel.getByRole("button", { name: "选作参考图", exact: true }).click();
    planner.discuss();
    await page.getByRole("textbox", { name: "对话内容", exact: true }).fill("只讨论参考关系");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByText("参考图仅提供配色，当前底图不变。", { exact: true })).toBeVisible();
    expect(planner.plans.at(-1).profileContext.focusImageId).toBe(focus);
    expect(planner.plans.at(-1).profileContext.imageCatalog).toHaveLength(2);
    expect(api.submissions).toHaveLength(0);
    await page.getByRole("button", { name: "新对话", exact: true }).click();
    await expect(page.getByTestId("agent-document-panel")).toHaveCount(0);
    expect(api.pageErrors).toEqual([]); expect(api.blocked).toEqual([]);
});

test("canvas accepts a file, confirms a durable card and creates a reusable text node without generating", async ({ page, context, api }) => {
    const planner = await setup(context);
    const id = await newCanvas(page);
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    await upload(page, "上传设计文件或参考图");
    const input = page.locator(".cw-agent-panel").getByPlaceholder("理解画布、修改图片或批量编排…");
    await input.fill("整理需求卡"); await input.press("Enter");
    const panel = page.getByTestId("agent-document-panel");
    await expect(panel.getByRole("button", { name: "确认需求卡", exact: true })).toBeEnabled();
    expect(planner.plans).toHaveLength(2); expect(api.submissions).toHaveLength(0);
    await panel.getByRole("button", { name: "确认需求卡", exact: true }).click();
    await panel.locator("summary").first().click();
    await panel.getByRole("button", { name: "放到画布作文本节点", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.some((node: any) => node.type === "text" && node.metadata.content.includes("不要：口袋"))).toBe(true);
    await expect.poll(() => api.document(id)?.chatSessions[0].requirementCard.status).toBe("confirmed");
    expect(api.document(id)?.chatSessions[0].documents[0].source.dataUrl).toMatch(/^\/api\/assets\//);
    expect(api.submissions).toHaveLength(0);
    expect(api.pageErrors).toEqual([]); expect(api.blocked).toEqual([]);
});
