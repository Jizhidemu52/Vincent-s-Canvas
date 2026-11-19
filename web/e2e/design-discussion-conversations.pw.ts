import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import type { CreateConversationRequest, SubmitTurnRequest } from "../../shared/image-conversation-contracts";
import type { PublicConversationSnapshot, PublicImageTurn, PublicImageVersion } from "../../shared/image-conversation-public";
import { toolDefinitions } from "../../shared/feature-catalog";
import { test, expect, IMAGE, newCanvas } from "./fixtures";
import { conversationSnapshot, conversationTurn, conversationVersion } from "../tests/fixtures/image-conversation";

const proposal = { id: "blue-knit", title: "灰蓝针织方向", features: ["灰蓝衣身", "保留白色翻领"], rationale: "隔离测试中的固定方案。", prompt: "生成一张灰蓝色针织开衫白底图，保留白色翻领。", referenceIds: [], sourceNotes: [] };
const videoModel = { id: "40000000-0000-4000-8000-000000000115", modelId: "seedance-2-5-flash", name: "seedance-2-5-flash", capabilities: ["video"] };
type State = { snapshot: PublicConversationSnapshot; create: CreateConversationRequest; turn: PublicImageTurn | null; versions: PublicImageVersion[] };

class DiscussionFixture {
    states = new Map<string, State>();
    creates: CreateConversationRequest[] = [];
    submissions: SubmitTurnRequest[] = [];
    lookups: string[] = [];
    chats: Record<string, any>[] = [];
    loseCreate = false;
    loseTurn = false;
    hideTurn = false;
    async attach(page: Page) {
        await page.route("**/api/deployment", route => route.fulfill({ json: { authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false, imageConversationsEnabled: true } }));
        await page.route("**/api/models", route => route.fulfill({ json: { models: [videoModel], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: null, configurationVersion: 1 })) } }));
        await page.route("**/api/chat/responses", route => {
            const input = route.request().postDataJSON(); this.chats.push(input);
            const video = input.input[0].content.includes("本轮方案用于生成视频");
            return route.fulfill({ json: { content: JSON.stringify({ message: this.chats.length === 1 ? "先讨论配色，保持白领识别度。" : "按讨论整理为可选择方向。", questions: [], proposals: this.chats.length > 1 ? [{ ...proposal, ...(video ? { prompt: "生成6秒针织服装商品视频，缓慢推近，保留白色翻领。" } : {}) }] : [], sources: [], trendStatus: "隔离交互测试，不代表模型质量。" }), toolCalls: [] } });
        });
        await page.route("**/api/assets/*/content", route => {
            const asset = route.request().url().split("/assets/")[1]!.split("/")[0];
            return [...this.states.values()].some(state => state.versions.some(version => version.assetId === asset)) ? route.fulfill({ contentType: "image/png", body: IMAGE }) : route.fallback();
        });
        await page.route(/^https?:\/\/[^/]+\/api\/image-conversations(?:[/?]|$)/, async route => {
            const path = new URL(route.request().url()).pathname, method = route.request().method();
            const reply = (data: unknown, status = 200) => route.fulfill({ status, json: { code: "OK", data, msg: "" } });
            const missing = () => route.fulfill({ status: 404, json: { code: "NOT_FOUND", data: null, msg: "尚未查到原请求" } });
            if (path === "/api/image-conversations" && method === "POST") {
                const input = route.request().postDataJSON() as CreateConversationRequest; this.creates.push(input);
                const id = randomUUID();
                const snapshot: PublicConversationSnapshot = { ...conversationSnapshot(), id, title: input.title || null, entrypoint: "canvas", canvasExternalId: input.canvasExternalId!, activeVersionId: null, activeVersion: null };
                this.states.set(id, { snapshot, create: input, turn: null, versions: [] });
                return this.loseCreate ? route.abort("failed") : reply(snapshot, 201);
            }
            if (path.includes("/by-request/") && !path.includes("/turns/")) {
                const key = decodeURIComponent(path.split("/by-request/")[1]!); this.lookups.push(key);
                const state = [...this.states.values()].find(item => item.create.clientRequestId === key);
                return state ? reply(state.snapshot) : missing();
            }
            const id = path.split("/")[3]!, state = this.states.get(id);
            if (!state) return missing();
            if (path.endsWith("/turns") && method === "POST") {
                const input = route.request().postDataJSON() as SubmitTurnRequest; this.submissions.push(input);
                const turn = { ...conversationTurn("generating", input.clientRequestId), id: randomUUID(), conversationId: id, taskId: randomUUID(), baseVersionId: null, inputActiveVersionId: null, intent: "generate_new" as const };
                const version = { ...conversationVersion(true), id: randomUUID(), conversationId: id, turnId: turn.id, assetId: randomUUID(), parentVersionId: null, versionNo: 1, imageNo: 1 };
                version.rootVersionId = version.id;
                state.turn = { ...turn, state: "completed", outputVersionId: version.id }; state.versions = [version];
                state.snapshot = { ...state.snapshot, stateRevision: 2, activeVersionId: version.id, activeVersion: version };
                return this.loseTurn ? route.abort("failed") : reply({ turnId: turn.id, stateRevision: 2, state: turn.state, assistant: turn.assistant }, 202);
            }
            if (path.includes("/turns/by-request/")) {
                const key = decodeURIComponent(path.split("/by-request/")[1]!); this.lookups.push(key);
                if (this.hideTurn || !state.turn || state.turn.clientRequestId !== key) return missing();
                return reply({ turn: state.turn, stateRevision: 2 });
            }
            if (path.includes("/turns/")) return state.turn ? reply({ turn: state.turn, stateRevision: 2 }) : missing();
            if (path.endsWith("/versions")) return reply({ items: state.versions, nextCursor: null });
            return reply(state.snapshot);
        });
    }
}

async function selectDirection(page: Page, fixture: DiscussionFixture, count = 1) {
    await page.getByRole("button", { name: "打开设计讨论", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "设计讨论面板" });
    const composer = panel.getByRole("textbox", { name: "输入设计需求" });
    await expect(panel.getByRole("button", { name: "发送讨论", exact: true })).toBeEnabled();
    await composer.fill("保留白色翻领，先讨论配色，不出图。"); await composer.press("Enter");
    await expect(panel.locator(".studio-conversation")).toContainText("先讨论配色");
    expect(fixture.creates).toHaveLength(0); expect(fixture.submissions).toHaveLength(0);
    await panel.locator(".discussion-settings > summary").click();
    await panel.getByRole("combobox", { name: "方案数量", exact: true }).selectOption("1");
    await panel.getByRole("combobox", { name: "生成数量", exact: true }).selectOption(String(count));
    await expect(panel.getByRole("combobox", { name: "出图模型", exact: true })).toHaveCount(0);
    await composer.fill("把刚才的方向整理成一个灰蓝配色完整方案。");
    await panel.getByRole("button", { name: "给我方案", exact: true }).click();
    await expect(panel.locator(".discussion-proposals")).toContainText("灰蓝针织方向");
    expect(fixture.creates).toHaveLength(0); expect(fixture.submissions).toHaveLength(0);
    await panel.locator(".studio-batch").click();
    await expect(page.getByRole("dialog", { name: "可选设计方向 · 1 个方案" })).toContainText("自动图片服务");
    return { panel, generate: page.getByRole("button", { name: `按选中方案生成 ${count} 张`, exact: true }) };
}

test("discussion and proposals stay non-generating; three independent server versions survive reload and video stays legacy", async ({ page, api }, info) => {
    const fixture = new DiscussionFixture(); await fixture.attach(page);
    const projectId = await newCanvas(page);
    const { panel, generate } = await selectDirection(page, fixture, 3);
    await generate.click();
    await expect(panel.locator(".discussion-results img")).toHaveCount(3);
    await expect.poll(() => api.document(projectId)?.nodes.filter((node: any) => node.metadata?.imageConversation?.versionId).length).toBe(3);
    expect(fixture.creates).toHaveLength(3); expect(fixture.submissions).toHaveLength(3); expect(api.submissions).toHaveLength(0);
    expect(new Set(fixture.creates.map(input => input.clientRequestId)).size).toBe(3);
    expect(fixture.creates.every(input => input.canvasExternalId === projectId && !input.projectUuid)).toBe(true);
    expect(fixture.submissions.every(input => input.outputPreferences?.mode === "auto" && !Object.hasOwn(input, "modelConfigId"))).toBe(true);
    await page.screenshot({ path: info.outputPath("three-server-versions.png"), animations: "disabled" });
    await page.reload(); await page.getByRole("button", { name: "打开设计讨论", exact: true }).click();
    await expect(panel.locator(".discussion-results img")).toHaveCount(3);
    await expect.poll(() => api.document(projectId)?.nodes.filter((node: any) => node.metadata?.imageConversation?.versionId).length).toBe(3);
    expect(fixture.creates).toHaveLength(3); expect(fixture.submissions).toHaveLength(3);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel.getByRole("button", { name: "发送讨论", exact: true })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("server-conversation-mobile.png"), animations: "disabled" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await panel.locator(".discussion-settings > summary").click();
    await panel.getByRole("combobox", { name: "生成类型", exact: true }).selectOption("video");
    await panel.getByRole("combobox", { name: "生成数量", exact: true }).selectOption("1");
    await panel.getByRole("textbox", { name: "输入设计需求" }).fill("生成一个6秒针织服装视频，保留白色翻领。");
    await panel.getByRole("button", { name: "给我方案", exact: true }).click();
    await panel.locator(".studio-batch").click();
    api.taskStatus = "processing";
    await page.getByRole("button", { name: "按选中方案生成 1 个视频", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(api.submissions[0]).toMatchObject({ operationType: "video_generation", modelConfigId: videoModel.id });
    expect(fixture.creates).toHaveLength(3); expect(fixture.submissions).toHaveLength(3);
});

test("a lost create receipt only queries its key after reload, then one explicit continue sends the first turn", async ({ page, api }, info) => {
    const fixture = new DiscussionFixture(); fixture.loseCreate = true; await fixture.attach(page);
    await newCanvas(page);
    const { generate } = await selectDirection(page, fixture); await generate.click();
    await expect.poll(() => fixture.lookups.length).toBeGreaterThan(0);
    expect(fixture.creates).toHaveLength(1); expect(fixture.submissions).toHaveLength(0);
    await page.reload();
    await page.getByRole("button", { name: "查看设计生成任务", exact: true }).click();
    const resume = page.getByRole("button", { name: "继续已记录的生成操作", exact: true });
    await expect(resume).toBeVisible();
    expect(fixture.creates).toHaveLength(1); expect(fixture.submissions).toHaveLength(0);
    await page.screenshot({ path: info.outputPath("create-restored-not-resubmitted.png"), animations: "disabled" });
    await resume.click();
    await expect(page.getByRole("button", { name: "定位设计结果", exact: true })).toBeVisible();
    expect(fixture.creates).toHaveLength(1); expect(fixture.submissions).toHaveLength(1); expect(api.submissions).toHaveLength(0);
});

test("a lost turn receipt and 404 remain unresolved through reload until a GET recovers the original version", async ({ page, api }, info) => {
    const fixture = new DiscussionFixture(); fixture.loseTurn = true; fixture.hideTurn = true; await fixture.attach(page);
    const projectId = await newCanvas(page);
    const { generate } = await selectDirection(page, fixture); await generate.click();
    await expect.poll(() => fixture.lookups.length).toBeGreaterThan(0);
    expect(fixture.submissions).toHaveLength(1);
    await page.reload(); await page.getByRole("button", { name: "查看设计生成任务", exact: true }).click();
    await expect(page.getByRole("button", { name: "查询原设计任务", exact: true })).toBeVisible();
    expect(fixture.creates).toHaveLength(1); expect(fixture.submissions).toHaveLength(1);
    await page.screenshot({ path: info.outputPath("turn-unknown-get-only.png"), animations: "disabled" });
    fixture.hideTurn = false;
    await page.getByRole("button", { name: "查询原设计任务", exact: true }).click();
    await expect.poll(() => api.document(projectId)?.nodes.filter((node: any) => node.metadata?.imageConversation?.versionId).length).toBe(1);
    await page.reload();
    await expect(page.getByRole("button", { name: "打开设计讨论", exact: true })).toBeVisible();
    expect(fixture.creates).toHaveLength(1); expect(fixture.submissions).toHaveLength(1); expect(api.submissions).toHaveLength(0);
    expect(fixture.lookups.every(key => key === fixture.submissions[0]!.clientRequestId)).toBe(true);
});
