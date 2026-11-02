import type { Page } from "@playwright/test";
import { test, expect, type MockCanvasApi } from "./fixtures";

const PROJECT = "73000000-0000-4000-8000-000000000001";
const NODE = "boundary-draft-note";
const NOTE = "旧员工画布原稿：身份变化不能删除";

async function prepareCanvas(page: Page, api: MockCanvasApi) {
    const document = {
        id: PROJECT, title: "身份边界浏览器验收", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
        nodes: [{ id: NODE, type: "text", title: "保留的原稿", position: { x: 0, y: 0 }, width: 360, height: 200, metadata: { content: NOTE } }],
        connections: [], groups: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false,
        viewport: { x: 400, y: 240, k: 1 }, selectedNodeIds: [], history: { past: [], future: [] },
    };
    api.documents.set(PROJECT, { id: PROJECT, revision: 1, document, deleted: false, updatedAt: document.updatedAt });
    await page.context().route("**/api/generation-capabilities?*", route => route.fulfill({ json: { models: [] } }));
    await page.context().route("**/api/prompt-templates?*", route => route.fulfill({ json: { templates: [], total: 0 } }));
    await page.goto(`/canvas/${PROJECT}`);
    await expect(page.locator(`[data-node-id="${NODE}"]`)).toBeVisible();
    await expect(page.getByRole("button", { name: "上传素材", exact: true })).toBeVisible();
}

function observeDocuments(page: Page) {
    const documents: string[] = [];
    page.on("request", request => {
        if (request.isNavigationRequest() && request.resourceType() === "document" && request.frame() === page.mainFrame()) documents.push(request.url());
    });
    return documents;
}

function assertNoGeneration(api: MockCanvasApi) {
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
}

for (const scenario of [
    { name: "403", english: false, oa: false },
    { name: "invalid-200", english: true, oa: true },
] as const) {
    test(`${scenario.name} after successful canvas bootstrap pauses one document until an explicit reload`, async ({ page, context, api }, info) => {
        let failure = false;
        let sessionCalls = 0;
        let deploymentCalls = 0;
        const documents = observeDocuments(page);
        await context.route("**/api/deployment", async route => {
            deploymentCalls++;
            if (scenario.oa) return route.fulfill({ json: { authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: true } });
            return route.fallback();
        });
        await context.route("**/api/auth/session", async route => {
            sessionCalls++;
            if (!failure) return route.fallback();
            if (scenario.name === "403") return route.fulfill({ status: 403, json: { error: "FIXTURE_FORBIDDEN" } });
            return route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>Fixture invalid session response</body></html>" });
        });
        await prepareCanvas(page, api);
        if (scenario.english) {
            await page.getByTestId("language-switch").filter({ visible: true }).first().click();
            await expect(page.locator("html")).toHaveAttribute("lang", "en");
        }
        const timeOrigin = await page.evaluate(() => performance.timeOrigin);
        failure = true;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        const heading = scenario.english ? "Your sign-in status changed. The workspace is paused." : "登录状态已变化，工作区已暂停";
        await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
        const reload = page.getByRole("button", { name: scenario.english ? "Reload" : "重新加载", exact: true });
        await expect(reload).toBeEnabled();
        await expect(page.locator("[data-node-id]")).toHaveCount(0);
        await expect(page.getByRole("navigation")).toHaveCount(0);
        await expect(page.locator("textarea,input:not([type=hidden]),[contenteditable=true]")).toHaveCount(0);
        expect(documents).toHaveLength(1); expect(deploymentCalls).toBe(1);
        const callsAtPause = sessionCalls;
        // Even if the endpoint becomes healthy, the invalidated owner must not
        // silently reopen. Observe beyond the former 10-second root poll.
        failure = false;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await page.waitForTimeout(11_500);
        await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
        expect(sessionCalls).toBe(callsAtPause);
        expect(documents).toHaveLength(1); expect(deploymentCalls).toBe(1);
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
        expect(api.document(PROJECT)?.nodes[0].metadata.content).toBe(NOTE);
        if (scenario.english) {
            await expect(page.getByRole("alert")).toContainText("This page will not reload automatically.");
            await expect(page.getByRole("alert")).toContainText("company OA portal in WeCom");
            expect(await page.getByRole("alert").innerText()).not.toMatch(/[\u3400-\u9fff]/);
        }
        await page.screenshot({ path: info.outputPath(`${scenario.name}-stable-boundary.png`) });
        await reload.click();
        await expect(page.locator(`[data-node-id="${NODE}"]`)).toBeVisible();
        expect(documents).toHaveLength(2); expect(deploymentCalls).toBe(2);
        expect(sessionCalls).toBeGreaterThan(callsAtPause);
        expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(timeOrigin);
        assertNoGeneration(api);
        await info.attach("navigation-evidence", { contentType: "application/json", body: Buffer.from(JSON.stringify({
            scenario: scenario.name, topLevelDocumentsBeforeClick: 1, topLevelDocumentsAfterClick: documents.length,
            deploymentCalls, sessionCallsAtPause: callsAtPause, sessionCallsAfterClick: sessionCalls, observationMs: 11_500,
            originalCanvasContentPreserved: api.document(PROJECT)?.nodes[0].metadata.content === NOTE,
        }, null, 2)) });
    });
}

test("same-owner 401 keeps the canvas draft editable without a modal or document reload", async ({ page, context, api }, info) => {
    let expired = false;
    let sessionCalls = 0;
    const documents = observeDocuments(page);
    await context.route("**/api/auth/session", async route => {
        sessionCalls++;
        if (expired) return route.fulfill({ status: 401, json: { error: "FIXTURE_EXPIRED" } });
        return route.fallback();
    });
    await prepareCanvas(page, api);
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const composer = page.locator(".cw-agent-panel textarea").last();
    const draft = "尚未提交的画布草稿：会话过期后仍需保留";
    await composer.fill(draft);
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    expired = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const recovery = page.getByRole("button", { name: "恢复登录", exact: true });
    await expect(recovery).toBeVisible();
    await expect(page.getByRole("dialog", { name: "登录已过期", exact: true })).toHaveCount(0);
    await expect(page.locator("[inert]")).toHaveCount(0);
    await expect(composer).toHaveValue(draft);
    await expect(page.locator(`[data-node-id="${NODE}"]`)).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "登录状态已变化，工作区已暂停" })).toHaveCount(0);
    await page.waitForTimeout(11_500);
    await expect(recovery).toBeVisible(); await expect(composer).toHaveValue(draft);
    await composer.fill(`${draft}，仍可继续编辑`);
    expect(documents).toHaveLength(1);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    await page.screenshot({ path: info.outputPath("401-draft-retained.png") });
    expired = false;
    await recovery.click();
    await page.getByRole("button", { name: "已在其他窗口登录", exact: true }).click();
    await expect(recovery).toHaveCount(0);
    await expect(page.locator("[inert]")).toHaveCount(0);
    await expect(composer).toHaveValue(`${draft}，仍可继续编辑`);
    await expect(page.locator(`[data-node-id="${NODE}"]`)).toBeVisible();
    expect(documents).toHaveLength(1); assertNoGeneration(api);
    await info.attach("navigation-evidence", { contentType: "application/json", body: Buffer.from(JSON.stringify({
        scenario: "401", topLevelDocuments: documents.length, sessionCalls, observationMs: 11_500,
        draftRetained: await composer.inputValue() === `${draft}，仍可继续编辑`, resumedByExplicitSessionCheck: true,
    }, null, 2)) });
});
