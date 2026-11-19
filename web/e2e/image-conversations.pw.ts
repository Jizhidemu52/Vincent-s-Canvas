import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { ConversationMessage, SubmitTurnRequest } from "../../shared/image-conversation-contracts";
import type { PublicConversationEvent as ConversationEvent, PublicConversationSnapshot as ConversationSnapshot, PublicImageTurn as ImageTurn, PublicImageVersion as ImageVersion } from "../../shared/image-conversation-public";
import { test, expect, IMAGE, newCanvas, uploadImage } from "./fixtures";
import { conversationIds as ids, conversationTime as now, conversationSnapshot, conversationTurn, conversationVersion, conversationMessage } from "../tests/fixtures/image-conversation";

const output = resolve(import.meta.dirname, "../../output/image-conversations-ui");
const envelope = (data: unknown) => ({ code: "OK", data, msg: "" });
const frame = (event: ConversationEvent) => `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

class ConversationFixture {
    exists = false;
    snapshot: ConversationSnapshot = conversationSnapshot();
    versions: ImageVersion[] = [conversationVersion()];
    messages: ConversationMessage[] = [];
    turn: ImageTurn | null = null;
    events: ConversationEvent[] = [];
    creates: Record<string, unknown>[] = [];
    createLookups = 0;
    loseCreateResponse = false;
    hideCreateLookup = false;
    submissions: SubmitTurnRequest[] = [];
    lookups = 0;
    snapshots = 0;
    streamCursors: number[] = [];
    legacyPosts: string[] = [];
    loseSubmissionResponse = false;
    hideLookup = false;
    expireOnce = false;
    cancellation: "cancelled_before_submission" | "detached_task_continues" = "cancelled_before_submission";
    async attach(page: Page) {
        await mkdir(output, { recursive: true });
        await page.route("**/api/deployment", route => route.fulfill({ json: { authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false, imageConversationsEnabled: true } }));
        await page.route("**/api/chat/**", route => { this.legacyPosts.push(route.request().url()); return route.abort(); });
        await page.route("**/api/assets/*/content", route => [ids.asset, ids.resultAsset].some(id => route.request().url().includes(id)) ? route.fulfill({ contentType: "image/png", body: IMAGE }) : route.fallback());
        await page.route(/^https?:\/\/[^/]+\/api\/image-conversations(?:[/?]|$)/, async route => {
            const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
            expect(route.request().headers()["x-canvas-owner-id"]).toBe(ids.owner);
            const reply = (data: unknown, status = 200) => route.fulfill({ status, json: envelope(data) });
            if (path === "/api/image-conversations" && method === "GET") return reply({ items: this.exists ? [this.summary()] : [], nextCursor: null });
            if (path === "/api/image-conversations" && method === "POST") {
                const input = route.request().postDataJSON(); this.creates.push(input); this.exists = true;
                this.snapshot.entrypoint = input.entrypoint; this.snapshot.canvasExternalId = input.canvasExternalId || null;
                if (input.initialAssetId) { this.versions[0]!.assetId = input.initialAssetId; this.snapshot.activeVersion = this.versions[0]!; }
                else { this.versions = []; this.snapshot.activeVersion = null; this.snapshot.activeVersionId = null; }
                if (this.loseCreateResponse) return route.abort("failed");
                return reply(this.snapshot, 201);
            }
            if (path.startsWith("/api/image-conversations/by-request/")) {
                this.createLookups++;
                if (this.hideCreateLookup || !this.exists) return route.fulfill({ status: 404, json: { code: "NOT_FOUND", data: null, msg: "原编号尚未查到" } });
                expect(decodeURIComponent(path.split("/by-request/")[1]!)).toBe(this.creates[0]!.clientRequestId);
                return reply(this.snapshot);
            }
            if (path === `/api/image-conversations/${ids.conversation}`) { this.snapshots++; return reply(this.snapshot); }
            if (path.endsWith("/messages")) return reply({ items: this.messages, nextCursor: null });
            if (path.endsWith("/versions")) return reply({ items: this.versions, nextCursor: null });
            if (path.endsWith("/events")) {
                const cursor = Number(url.searchParams.get("afterSeq")); this.streamCursors.push(cursor);
                expect(route.request().headers()["last-event-id"]).toBe(String(cursor));
                if (this.expireOnce) { this.expireOnce = false; return route.fulfill({ status: 410, json: { code: "EVENT_CURSOR_EXPIRED", data: { latestEventSeq: this.snapshot.latestEventSeq }, msg: "事件已过期" } }); }
                const fresh = this.events.filter(event => event.seq > cursor);
                return route.fulfill({ contentType: "text/event-stream", body: ": connected\n\n" + fresh.flatMap(event => event.type === "version.created" ? [frame(event), frame(event)] : [frame(event)]).join("") });
            }
            if (path.endsWith("/turns") && method === "POST") {
                const input = route.request().postDataJSON(); this.submissions.push(input); this.turn = conversationTurn("accepted", input.clientRequestId);
                this.messages = [{ ...conversationMessage(), text: input.text }];
                this.snapshot.pendingTurn = this.turn; this.snapshot.stateRevision = 2; this.snapshot.latestEventSeq = 2;
                if (this.loseSubmissionResponse) return route.abort("failed");
                return reply({ turnId: this.turn.id, stateRevision: 2, state: this.turn.state, assistant: this.turn.assistant }, 202);
            }
            if (path.includes("/turns/by-request/")) {
                this.lookups++;
                if (this.hideLookup || !this.turn) return route.fulfill({ status: 404, json: { code: "NOT_FOUND", data: null, msg: "尚未查到原请求" } });
                expect(decodeURIComponent(path.split("/by-request/")[1]!)).toBe(this.turn.clientRequestId);
                return reply({ turn: this.turn, stateRevision: this.snapshot.stateRevision });
            }
            if (path.endsWith("/cancel") && method === "POST") {
                this.turn = { ...this.turn!, state: this.cancellation === "cancelled_before_submission" ? "cancelled" : "detached", autoActivate: false, assistant: { kind: "status", text: "停止已处理", canCancel: false } };
                this.snapshot.pendingTurn = null; this.snapshot.stateRevision++;
                return reply({ turnId: this.turn.id, stateRevision: this.snapshot.stateRevision, state: this.turn.state, assistant: this.turn.assistant, disposition: this.cancellation });
            }
            if (path.includes("/turns/")) return reply({ turn: this.turn, stateRevision: this.snapshot.stateRevision });
            throw new Error(`Unmocked conversation API ${method} ${path}`);
        });
    }
    summary() { const { activeVersion: _active, pendingTurn: _pending, latestEventSeq: _seq, contextSummary: _context, contextSummaryThroughSeq: _through, ...summary } = this.snapshot; return summary; }
    complete(detached = false) {
        const version = conversationVersion(true); this.versions.push(version);
        this.turn = { ...this.turn!, state: "completed", outputVersionId: version.id, taskId: ids.task, assistant: { kind: "reply", text: "图片已保存", canCancel: false } };
        const reply = conversationMessage(true); this.messages.push(reply);
        this.snapshot.pendingTurn = null; this.snapshot.stateRevision++;
        const push = (event: Omit<ConversationEvent, "conversationId" | "seq" | "turnId" | "createdAt">) => {
            this.snapshot.latestEventSeq++;
            this.events.push({ ...event, conversationId: ids.conversation, seq: this.snapshot.latestEventSeq, turnId: ids.turn, createdAt: now } as ConversationEvent);
        };
        push({ type: "version.created", payload: { stateRevision: this.snapshot.stateRevision, version } });
        if (!detached) {
            this.snapshot.activeVersion = version; this.snapshot.activeVersionId = version.id;
            push({ type: "active.changed", payload: { stateRevision: this.snapshot.stateRevision, activeVersionId: version.id, reason: "generation_completed" } });
        }
        push({ type: "message.created", payload: { stateRevision: this.snapshot.stateRevision, message: reply } });
        push({ type: "turn.completed", payload: { stateRevision: this.snapshot.stateRevision, turn: this.turn } });
    }
}

async function uploadAndSend(page: Page, fixture: ConversationFixture) {
    await page.goto("/chat");
    await expect(page.getByTestId("server-image-conversation")).toBeVisible();
    await page.locator('input[type="file"][accept="image/*"]').setInputFiles({ name: "原始针织图.png", mimeType: "image/png", buffer: IMAGE });
    await expect.poll(() => fixture.creates.length).toBe(1);
    await expect(page.getByRole("textbox", { name: "对话内容", exact: true })).toBeEnabled();
    await page.getByRole("textbox", { name: "对话内容", exact: true }).fill("改为蓝色，保留针织纹理");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => fixture.submissions.length).toBe(1);
}

test("upload original, persisted acceptance, duplicate SSE result and refresh recover from server without paid endpoints", async ({ page, api }) => {
    const fixture = new ConversationFixture(); await fixture.attach(page);
    await uploadAndSend(page, fixture);
    expect(fixture.creates[0]).toMatchObject({ entrypoint: "standalone", initialAssetId: [...api.assets.keys()][0] });
    expect(Object.keys(fixture.submissions[0]!).sort()).toEqual(["attachments", "clientRequestId", "expectedStateRevision", "outputPreferences", "text"]);
    expect(fixture.submissions[0]!.outputPreferences).toEqual({ mode: "auto" });
    await expect(page.getByText("已受理，尚未出图", { exact: true }).first()).toBeVisible();
    await expect(page.locator(`[data-version-id="${ids.generated}"]`)).toHaveCount(0);
    await page.screenshot({ path: resolve(output, "accepted-not-generated.png"), animations: "disabled" });
    fixture.complete();
    await expect(page.locator(`[data-version-id="${ids.generated}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-version-id="${ids.generated}"]`)).toContainText("当前图");
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "对话内容", exact: true }).fill("尚未发送的草稿");
    await page.screenshot({ path: resolve(output, "server-version-desktop.png"), animations: "disabled" });
    await page.reload();
    await expect(page.locator(`[data-version-id="${ids.generated}"]`)).toHaveCount(1);
    await expect(page.getByRole("textbox", { name: "对话内容", exact: true })).toHaveValue("尚未发送的草稿");
    expect(fixture.submissions).toHaveLength(1);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.legacyPosts).toHaveLength(0);
    expect(api.submissions).toHaveLength(0);
    await page.setViewportSize({ width: 390, height: 844 });
    const sidebar = page.getByRole("complementary", { name: "服务端会话记录" });
    if (await sidebar.isVisible()) await sidebar.getByRole("button", { name: "收起会话" }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeInViewport();
    await page.screenshot({ path: resolve(output, "server-version-mobile.png"), animations: "disabled" });
});

test("lost creation response is recovered by GET and never automatically sends the draft", async ({ page, api }) => {
    const fixture = new ConversationFixture(); fixture.loseCreateResponse = true; await fixture.attach(page);
    await page.goto("/chat");
    const input = page.getByRole("textbox", { name: "对话内容", exact: true });
    await input.fill("保留这条尚未提交的设计需求");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByRole("button", { name: "查询原创建请求", exact: true })).toBeVisible();
    await page.reload();
    await expect(input).toHaveValue("保留这条尚未提交的设计需求");
    expect(fixture.creates).toHaveLength(1); expect(fixture.submissions).toHaveLength(0);
    await page.getByRole("button", { name: "查询原创建请求", exact: true }).click();
    await expect.poll(() => fixture.createLookups).toBe(1);
    await expect(page.getByRole("button", { name: "查询原创建请求", exact: true })).toHaveCount(0);
    await expect(input).toHaveValue("保留这条尚未提交的设计需求");
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
    expect(fixture.creates).toHaveLength(1); expect(fixture.submissions).toHaveLength(0); expect(api.submissions).toHaveLength(0);
});

test("creation lookup 404 retains receipt until explicit same-key empty creation without a turn", async ({ page, api }) => {
    const fixture = new ConversationFixture(); fixture.loseCreateResponse = true; fixture.hideCreateLookup = true; await fixture.attach(page);
    await page.goto("/chat");
    const input = page.getByRole("textbox", { name: "对话内容", exact: true });
    await input.fill("只准备草稿，不自动执行");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByRole("button", { name: "查询原创建请求", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("原编号尚未查到");
    expect(fixture.creates).toHaveLength(1);
    fixture.loseCreateResponse = false;
    await page.getByRole("button", { name: "按原编号完成创建", exact: true }).click();
    await expect(page.getByText("空会话创建已确认，未发送草稿；请检查后手动发送。", { exact: true })).toBeVisible();
    expect(fixture.creates).toHaveLength(2); expect(fixture.creates[1]).toEqual(fixture.creates[0]);
    await expect(input).toHaveValue("只准备草稿，不自动执行");
    expect(fixture.submissions).toHaveLength(0); expect(api.submissions).toHaveLength(0);
});

test("lost response persists original key across refresh and only queries until the original turn is found", async ({ page, api }) => {
    const fixture = new ConversationFixture(); fixture.loseSubmissionResponse = true; fixture.hideLookup = true; await fixture.attach(page);
    await uploadAndSend(page, fixture);
    await expect(page.getByRole("button", { name: "查询原请求", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
    const key = fixture.submissions[0]!.clientRequestId;
    await page.reload();
    await expect(page.getByText(`原请求 ${key}`, { exact: true })).toBeVisible();
    await expect.poll(() => fixture.lookups).toBeGreaterThanOrEqual(2);
    expect(fixture.submissions).toHaveLength(1);
    fixture.hideLookup = false;
    await page.getByRole("button", { name: "查询原请求", exact: true }).click();
    await expect(page.getByRole("button", { name: "查询原请求", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "停止本轮", exact: true })).toBeVisible();
    expect(fixture.submissions[0]!.clientRequestId).toBe(key);
    expect(fixture.submissions).toHaveLength(1); expect(api.submissions).toHaveLength(0);
});

test("410 reconnect reloads server snapshot and history without recreating a turn", async ({ page, api }) => {
    const fixture = new ConversationFixture(); await fixture.attach(page); await uploadAndSend(page, fixture);
    await expect.poll(() => fixture.streamCursors.includes(2)).toBe(true);
    const before = fixture.snapshots;
    fixture.complete(); fixture.expireOnce = true;
    await expect(page.locator(`[data-version-id="${ids.generated}"]`)).toHaveCount(1);
    await expect.poll(() => fixture.snapshots).toBeGreaterThan(before);
    await expect.poll(() => fixture.streamCursors.includes(fixture.snapshot.latestEventSeq)).toBe(true);
    expect(fixture.submissions).toHaveLength(1); expect(api.submissions).toHaveLength(0);
});

for (const disposition of ["cancelled_before_submission", "detached_task_continues"] as const) test(`stop reports ${disposition} and refresh preserves server outcome`, async ({ page, api }) => {
    const fixture = new ConversationFixture(); fixture.cancellation = disposition; await fixture.attach(page); await uploadAndSend(page, fixture);
    await page.getByRole("button", { name: "停止本轮", exact: true }).click();
    await expect(page.getByText(disposition === "cancelled_before_submission" ? "本轮已在提交前取消。" : "已停止采用本轮结果；原任务可能仍在执行，不会自动切换当前图。", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.locator(`[data-turn-state="${disposition === "cancelled_before_submission" ? "cancelled" : "detached"}"]`)).toBeVisible();
    if (disposition === "detached_task_continues") {
        fixture.complete(true);
        await expect(page.locator(`[data-version-id="${ids.generated}"]`)).toHaveCount(1);
        await expect(page.locator(`[data-version-id="${ids.generated}"]`)).not.toContainText("当前图");
        await expect(page.locator(`[data-version-id="${ids.root}"]`)).toContainText("当前图");
    }
    expect(fixture.submissions).toHaveLength(1); expect(api.submissions).toHaveLength(0);
});

test("canvas original assistant keeps a durable server pointer and installs each result once across duplicate events and reload", async ({ page, api }) => {
    const fixture = new ConversationFixture(); await fixture.attach(page);
    api.assets.set(ids.resultAsset, { id: ids.resultAsset, ownerUserId: ids.owner, status: "ready", mimeType: "image/png", contentUrl: `/api/assets/${ids.resultAsset}/content`, width: 256, height: 256 });
    const projectId = await newCanvas(page);
    await uploadImage(page, "画布原图.png");
    await expect.poll(() => api.document(projectId)?.nodes.length).toBe(1);
    const originalNode = structuredClone(api.document(projectId)!.nodes[0]);
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const conversation = page.getByTestId("server-image-conversation");
    await expect(conversation).toBeVisible();
    await expect(conversation.getByAltText("将用于新会话的画布原图")).toBeVisible();
    await conversation.getByRole("textbox", { name: "对话内容", exact: true }).fill("在画布原图上改成蓝色");
    await conversation.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => fixture.submissions.length).toBe(1);
    expect(fixture.creates[0]).toMatchObject({ entrypoint: "canvas", canvasExternalId: projectId, initialAssetId: [...api.assets.keys()].find(id => id !== ids.resultAsset) });
    await expect.poll(() => api.document(projectId)?.chatSessions.some((session: { serverConversationId?: string }) => session.serverConversationId === ids.conversation)).toBe(true);
    fixture.complete();
    await expect(conversation.locator(`[data-version-id="${ids.generated}"]`)).toHaveCount(1);
    await expect.poll(() => api.document(projectId)?.nodes.length).toBe(2);
    expect(api.document(projectId)!.nodes.find((node: { id: string }) => node.id === originalNode.id)).toEqual(originalNode);
    const projected = api.document(projectId)!.nodes.find((node: { metadata?: { imageConversation?: { versionId: string } } }) => node.metadata?.imageConversation?.versionId === ids.generated);
    expect(projected.metadata).toMatchObject({ serverAssetId: ids.resultAsset, content: `/api/assets/${ids.resultAsset}/content`, naturalWidth: 256, naturalHeight: 256 });
    const originalBytes = await page.evaluate(async source => Array.from(new Uint8Array(await (await fetch(source)).arrayBuffer())), projected.metadata.content);
    expect(Buffer.from(originalBytes)).toEqual(IMAGE);
    const pointer = api.document(projectId)!.chatSessions.find((session: { serverConversationId?: string }) => session.serverConversationId === ids.conversation);
    expect(pointer.messages).toEqual([]);
    await page.screenshot({ path: resolve(output, "canvas-original-assistant.png"), animations: "disabled" });
    await page.reload();
    const open = page.getByRole("tab", { name: "对话", exact: true }).first();
    await expect(open).toBeVisible();
    if (!(await conversation.isVisible())) await open.click();
    await expect(conversation.locator(`[data-version-id="${ids.generated}"]`)).toHaveCount(1);
    await expect.poll(() => api.document(projectId)?.nodes.length).toBe(2);
    expect(fixture.creates).toHaveLength(1); expect(fixture.submissions).toHaveLength(1); expect(api.submissions).toHaveLength(0);
    await page.getByRole("button", { name: "切换为宽屏对话", exact: true }).click();
    await expect(page.getByRole("button", { name: "切换为左侧窄栏", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "切换为左侧窄栏", exact: true }).click();
    await page.getByRole("button", { name: "关闭对话面板", exact: true }).click();
    await expect(conversation).toBeHidden();
    const snapshotsBeforeDisable = fixture.snapshots;
    await page.route("**/api/deployment", route => route.fulfill({ json: { authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false, imageConversationsEnabled: false } }));
    await page.route("**/api/generation-capabilities?*", route => route.fulfill({ json: { models: [] } }));
    await page.reload();
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    await expect(page.getByPlaceholder("理解画布、修改图片或批量编排…")).toBeVisible();
    await expect(conversation).toHaveCount(0);
    expect(fixture.snapshots).toBe(snapshotsBeforeDisable);
    expect(api.document(projectId)!.chatSessions.find((session: { serverConversationId?: string }) => session.serverConversationId === ids.conversation).messages).toEqual([]);
});

test("feature-off keeps the original canvas assistant without conversation API calls", async ({ page, api }) => {
    const fixture = new ConversationFixture(); await fixture.attach(page);
    await page.route("**/api/deployment", route => route.fulfill({ json: { authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false, imageConversationsEnabled: false } }));
    await page.route("**/api/generation-capabilities?*", route => route.fulfill({ json: { models: [] } }));
    await newCanvas(page);
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    await expect(page.getByPlaceholder("理解画布、修改图片或批量编排…")).toBeVisible();
    await expect(page.getByTestId("server-image-conversation")).toHaveCount(0);
    expect(fixture.creates).toHaveLength(0); expect(fixture.submissions).toHaveLength(0); expect(fixture.snapshots).toBe(0); expect(api.submissions).toHaveLength(0);
});

test("detached canvas result remains in server history without automatic canvas installation after refresh", async ({ page, api }) => {
    const fixture = new ConversationFixture(); fixture.cancellation = "detached_task_continues"; await fixture.attach(page);
    const projectId = await newCanvas(page);
    await uploadImage(page, "保留原图.png");
    await expect.poll(() => api.document(projectId)?.nodes.length).toBe(1);
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const conversation = page.getByTestId("server-image-conversation");
    await expect(conversation.getByAltText("将用于新会话的画布原图")).toBeVisible();
    await conversation.getByRole("textbox", { name: "对话内容", exact: true }).fill("先做一个改色版本");
    await conversation.getByRole("button", { name: "发送", exact: true }).click();
    await conversation.getByRole("button", { name: "停止本轮", exact: true }).click();
    await expect(conversation.getByText("已停止采用本轮结果；原任务可能仍在执行，不会自动切换当前图。", { exact: true })).toBeVisible();
    fixture.complete(true);
    await expect(conversation.locator(`[data-version-id="${ids.generated}"]`)).toHaveCount(1);
    await expect(conversation.locator(`[data-version-id="${ids.generated}"]`)).not.toContainText("当前图");
    await conversation.getByRole("button", { name: "刷新服务端记录", exact: true }).click();
    await expect.poll(() => api.document(projectId)?.nodes.length).toBe(1);
    await page.reload();
    if (!(await conversation.isVisible())) await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    await expect(conversation.locator(`[data-version-id="${ids.generated}"]`)).toHaveCount(1);
    expect(api.document(projectId)!.nodes).toHaveLength(1);
    expect(fixture.creates).toHaveLength(1); expect(fixture.submissions).toHaveLength(1); expect(api.submissions).toHaveLength(0);
});
