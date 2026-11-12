import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, MockCanvasApi } from "./fixtures";
import { moduleDefinitions } from "../../shared/feature-catalog";

const owner = "00000000-0000-4000-8000-000000000099";
const source = "/api/assets/source-history/content", result = "/api/assets/result-history/content";
const task = (id: string, prompt = `此前生成-${id}`) => ({ id, userId: owner, requestId: `request-${id}`, status: "success", prompt, userInput: { userText: prompt },
    modelName: "原始图像模型", queuedAt: "2026-11-13T03:00:00Z", sourceUrls: [source], resultUrls: [result], parameters: { size: "1024x1024", creditCost: 99, inputArchive: { prompt } } });

async function cloud(context: BrowserContext, tasks: ReturnType<typeof task>[], requests: Array<{ board: string | null; cursor: string | null }> = []) {
    await context.route("**/api/tasks/history?**", route => {
        const url = new URL(route.request().url()); expect(route.request().method()).toBe("GET");
        expect(route.request().headers()["x-canvas-owner-id"]).toBe(owner);
        requests.push({ board: url.searchParams.get("board"), cursor: url.searchParams.get("cursor") });
        const offset = url.searchParams.get("cursor") === "second" ? 30 : 0;
        return route.fulfill({ json: { tasks: tasks.slice(offset, offset + 30), hasMore: tasks.length > offset + 30, nextCursor: tasks.length > offset + 30 ? "second" : null } });
    });
}
async function imageHistory(page: Page, path = "/image") {
    await page.goto(path);
    await page.locator(".image-result-tabs").getByRole("tab", { name: "历史记录", exact: false }).click();
    await expect(page.getByRole("region", { name: "账号云端历史" })).toBeVisible();
}

test("fresh browser contexts show the same account originals, paginate and keep current draft untouched", async ({ browser, page, api }, info) => {
    const tasks = Array.from({ length: 31 }, (_, index) => task(`cloud-${index}`, index === 0 ? "跨浏览器编辑记录：保留花边宽度与参考原图" : `此前生成-${index}`));
    const reads: Array<{ board: string | null; cursor: string | null }> = [];
    await cloud(page.context(), tasks, reads);
    await imageHistory(page);
    const draft = page.getByRole("textbox", { name: "图像提示词", exact: true });
    await draft.fill("本机未提交草稿，不得被云端历史替换");
    const history = page.getByRole("region", { name: "账号云端历史" });
    await expect(history.getByRole("button", { name: /^查看云端记录/ })).toHaveCount(30);
    await history.getByRole("button", { name: "加载更多云端记录" }).click();
    await expect(history.getByRole("button", { name: /^查看云端记录/ })).toHaveCount(31);
    expect(reads).toEqual([{ board: "image-generation", cursor: null }, { board: "image-generation", cursor: "second" }]);
    await history.getByRole("button", { name: /^查看云端记录/ }).first().click();
    const detail = page.getByTestId("account-history-detail");
    await expect(detail.getByRole("img", { name: "账号历史原件" })).toBeVisible();
    await expect(detail).toContainText("保留花边宽度");
    await detail.getByRole("button", { name: "参考原图 1" }).click();
    await expect(detail.getByRole("img")).toBeVisible();
    await detail.getByText("查看输入、参数和任务编号").click();
    await expect(detail.locator("pre")).toContainText("1024x1024");
    await expect(detail.locator("pre")).not.toContainText("creditCost");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("history-mobile.png"), animations: "disabled" });
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(draft).toHaveValue("本机未提交草稿，不得被云端历史替换");
    const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    const otherApi = new MockCanvasApi(new URL(page.url()).origin); await otherApi.attach(otherContext);
    try {
        expect((await otherContext.storageState()).origins).toEqual([]);
        await cloud(otherContext, tasks); const otherPage = await otherContext.newPage();
        await imageHistory(otherPage);
        await expect(otherPage.getByRole("button", { name: /查看云端记录：跨浏览器编辑记录/ })).toBeVisible();
        await otherPage.getByRole("button", { name: /查看云端记录：跨浏览器编辑记录/ }).click();
        await expect(otherPage.getByRole("img", { name: "账号历史原件" })).toBeVisible();
        expect(otherApi.submissions).toEqual([]); expect(otherApi.batchSubmissions).toEqual([]);
        expect(otherApi.blocked).toEqual([]); expect(otherApi.unexpected).toEqual([]); expect(otherApi.pageErrors).toEqual([]);
    } finally { await otherContext.close(); }
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("image edits and exact creative/quick/video/stitch boards use their own account history", async ({ page, api }) => {
    const reads: Array<{ board: string | null; cursor: string | null }> = [];
    await cloud(page.context(), [task("board-check")], reads);
    for (const [path, board, control] of [["/image?tool=image-edit", "image-edit", "image"], ["/remove-background", "remove-background", "image"],
        ["/creative/text-to-style", "creative-text-to-style", "scene"], ["/local-restyle", "creative-local-restyle", "scene"],
        ["/video", "video", "video"], ["/image?tool=seamless-stitch", "seamless-stitch", "stitch"]] as const) {
        await page.goto(path);
        if (control === "image") await page.locator(".image-result-tabs").getByRole("tab", { name: "历史记录", exact: false }).click();
        else if (control === "video") await page.getByRole("tab", { name: "历史记录", exact: true }).click();
        else if (control === "stitch") await page.getByRole("tab", { name: "历史记录", exact: true }).click();
        await expect(page.getByRole("region", { name: "账号云端历史" })).toBeVisible();
        await expect(page.getByRole("button", { name: "查看云端记录：此前生成-board-check" })).toBeVisible();
        expect(reads.at(-1)?.board).toBe(board);
    }
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("layer studio history loads on demand and leaves its editable input unchanged", async ({ page, api }) => {
    const reads: Array<{ board: string | null; cursor: string | null }> = [];
    await cloud(page.context(), [task("layer-original", "针织字母原件与图层拆分")], reads);
    await page.context().route("**/api/layer-studio/estimate", route => route.fulfill({ json: { estimate: { currency: "CNY", estimatedPrecharge: 3.2, maximumOutputs: 1, sourceCount: 0, priceVersion: 1, employeeCredits: 0, providerCharge: "unverified" } } }));
    await page.goto("/layer-studio");
    await page.getByRole("button", { name: "图片生成 / 编辑", exact: true }).click();
    await page.getByRole("textbox", { name: "图片描述", exact: true }).fill("此浏览器尚未提交的新草稿");
    expect(reads).toEqual([]);
    await page.getByText("账号历史记录", { exact: true }).click();
    await page.getByRole("button", { name: "查看云端记录：针织字母原件与图层拆分" }).click();
    await expect(page.getByRole("img", { name: "账号历史原件" })).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "图片描述", exact: true })).toHaveValue("此浏览器尚未提交的新草稿");
    expect(reads).toEqual([{ board: "layer-studio", cursor: null }]);
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("shared selected tags keep dark contrast and example copy feedback stays beside the action", async ({ page, api }, info) => {
    await page.goto("/assets");
    await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
    const selected = page.locator(".ant-tag-checkable-checked").first();
    const colors = await selected.evaluate(element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
    expect(colors.color).not.toBe(colors.background);
    expect(colors.background).not.toBe("rgb(238, 239, 235)");
    await page.screenshot({ path: info.outputPath("assets-selected-dark.png"), animations: "disabled" });
    await page.goto("/image");
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.locator(".image-result-tabs").getByRole("tab", { name: "历史记录", exact: false }).click();
    await page.getByTestId("practice-example-toggle").click();
    const example = page.getByTestId("design-example-article");
    await example.getByRole("button", { name: "复制示例要求", exact: true }).click();
    await expect(example).toContainText("已复制 ✓");
    await expect(page.locator(".ant-message-notice-success")).toHaveCount(0);
    await expect(example).not.toContainText("已复制 ✓", { timeout: 2500 });
    expect(api.submissions).toEqual([]);
});

test("foreign-owner records and outside media are refused without exposing data or credentials", async ({ page, api }) => {
    await page.context().route("**/api/tasks/history?**", route => route.fulfill({ json: { tasks: [{ ...task("foreign", "其他员工机密记录"), userId: "other-owner" }], nextCursor: null, hasMore: false } }));
    await imageHistory(page);
    await expect(page.getByRole("alert")).toContainText("归属或分页信息异常");
    await expect(page.getByText("其他员工机密记录")).toHaveCount(0);
    await cloud(page.context(), [{ ...task("external"), sourceUrls: [], resultUrls: ["https://private-upstream.invalid/image.png"] }]);
    await page.getByRole("button", { name: "刷新记录" }).click();
    await page.getByRole("button", { name: "查看云端记录：此前生成-external" }).click();
    await expect(page.getByTestId("account-history-detail")).toContainText("未保存本站原件");
    expect(api.blocked).toEqual([]); expect(api.submissions).toEqual([]);
});

test("failed pagination retries the same cursor while previously loaded records remain", async ({ page, api }) => {
    let attempts = 0;
    await page.context().route("**/api/tasks/history?**", route => {
        const cursor = new URL(route.request().url()).searchParams.get("cursor");
        if (cursor === "second" && attempts++ === 0) return route.fulfill({ status: 503, json: { message: "unavailable" } });
        return route.fulfill({ json: { tasks: [task(cursor ? "older" : "newer")], hasMore: !cursor, nextCursor: cursor ? null : "second" } });
    });
    await imageHistory(page);
    await page.getByRole("button", { name: "加载更多云端记录" }).click();
    await expect(page.getByRole("button", { name: "查看云端记录：此前生成-newer" })).toBeVisible();
    await page.getByRole("button", { name: "重试读取历史" }).click();
    await expect(page.getByRole("button", { name: /^查看云端记录/ })).toHaveCount(2);
    expect(attempts).toBe(2); expect(api.submissions).toEqual([]);
});

test("canvas stays first in desktop/mobile navigation and home survives disabled workspace modules", async ({ page, api }) => {
    await page.goto("/image");
    const navigation = page.locator(".wb-sidebar nav");
    await expect(navigation.getByRole("link").first()).toHaveAttribute("href", "/canvas");
    await page.goto("/creative");
    await expect(navigation.getByRole("link").first()).toHaveText("自由画布");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "打开导航" }).click();
    await expect(page.locator(".ant-drawer-body nav").getByRole("link").first()).toHaveAttribute("href", "/canvas");
    await page.context().route("**/api/modules", route => route.fulfill({ json: { modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: !["canvas", "gpt-chat"].includes(item.moduleKey) })) } }));
    await page.setViewportSize({ width: 1366, height: 768 }); await page.goto("/");
    await expect(navigation.getByRole("link", { name: "工作台", exact: true })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "自由画布", exact: true })).toHaveCount(0);
    expect(api.submissions).toEqual([]);
});
