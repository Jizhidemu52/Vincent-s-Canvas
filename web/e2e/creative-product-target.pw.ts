import { test, expect, IMAGE } from "./fixtures";
import type { ProductCandidatesReceipt } from "../../shared/product-candidates";

const candidates = [
    { id: "candidate-1", name: "蓝色衬衫", brief: "画面左侧，有纽扣门襟", evidence: "可见蓝色领口、门襟和长袖" },
    { id: "candidate-2", name: "黑色裤子", brief: "画面右侧，与衬衫分开", evidence: "可见黑色裤腰和两条裤腿" },
];

test("product candidates need explicit identification and confirmation, then freeze into the ordinary scene history", async ({ page, context, api }, info) => {
    const posts: any[] = [];
    await context.route("**/api/chat/responses", async route => {
        const input = route.request().postDataJSON(); posts.push(input);
        expect(route.request().headers()["x-canvas-owner-id"]).toBe("00000000-0000-4000-8000-000000000099");
        expect(input).toMatchObject({ toolKey: "gpt-chat", profile: "product-candidates", input: [], tools: [] });
        expect(api.assetBytes.get(input.profileContext.sourceAssetId)?.equals(IMAGE)).toBe(true);
        await route.fulfill({ json: { profile: "product-candidates", requestId: input.requestId, sourceAssetId: input.profileContext.sourceAssetId, status: "success", candidates, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    });
    await page.goto("/creative/style-to-sketch");
    const target = page.getByRole("textbox", { name: /要处理的产品/ });
    const keep = page.getByRole("textbox", { name: /关键特征保持/ });
    await target.fill("手写的目标");
    await keep.fill("保留六颗纽扣与小尖领");
    await page.getByLabel("上传服装参考图", { exact: true }).setInputFiles({ name: "original-product.png", mimeType: "image/png", buffer: IMAGE });
    const identify = page.getByRole("button", { name: "识别图中产品", exact: true });
    await expect(identify).toBeEnabled();
    expect(posts).toHaveLength(0); expect(api.submissions).toHaveLength(0);
    await identify.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    const confirm = page.getByRole("button", { name: "确认使用所选产品", exact: true });
    await expect(confirm).toBeDisabled();
    expect(posts).toHaveLength(1);
    await expect(target).toHaveValue("手写的目标");
    await page.getByRole("radio", { name: /蓝色衬衫/ }).check();
    await expect(target).toHaveValue("手写的目标");
    await confirm.click();
    await expect(target).toHaveValue("蓝色衬衫（画面左侧，有纽扣门襟）");
    await expect(page.getByText("已填入目标产品，可继续手动修改；未生成图片，也未建立像素选区。", { exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(0);
    await page.screenshot({ path: info.outputPath("product-target-desktop.png"), fullPage: true });
    await page.reload();
    await expect(target).toHaveValue("蓝色衬衫（画面左侧，有纽扣门襟）");
    await expect(keep).toHaveValue("保留六颗纽扣与小尖领");
    await expect(confirm).toBeDisabled();
    expect(posts).toHaveLength(1);
    await page.getByRole("button", { name: /^生成线稿/ }).click();
    await expect(page.getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(1);
    expect(api.submissions[0].promptInput.fields).toMatchObject({ targetProduct: "蓝色衬衫（画面左侧，有纽扣门襟）", keepDetails: "保留六颗纽扣与小尖领" });
    await target.fill("新的手动产品");
    await page.getByRole("button", { name: /^最近任务/ }).click();
    await page.locator(".cs-history-item").first().click();
    await expect(target).toHaveValue("新的手动产品");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".cs-product-candidates").scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("product-target-mobile.png"), fullPage: true });
    await page.getByLabel("上传服装参考图", { exact: true }).setInputFiles({ name: "replacement.png", mimeType: "image/png", buffer: IMAGE });
    await expect(target).toHaveValue("");
    await expect(keep).toHaveValue("保留六颗纽扣与小尖领");
    await expect(confirm).toHaveCount(0);
    expect(posts).toHaveLength(1); expect(api.submissions).toHaveLength(1);
});

test("a lost recognition response and GET 404 survive reload without another paid POST", async ({ page, context, api }) => {
    const posts: any[] = [], queries: string[] = [];
    let found = false;
    await context.route("**/api/chat/responses**", async route => {
        const request = route.request();
        if (request.method() === "POST") { posts.push(request.postDataJSON()); return route.abort("connectionclosed"); }
        const url = new URL(request.url());
        expect(url.searchParams.get("profile")).toBe("product-candidates");
        queries.push(decodeURIComponent(url.pathname.split("/").at(-1)!));
        if (!found) return route.fulfill({ status: 404, json: { message: "not found" } });
        const input = posts[0];
        return route.fulfill({ json: { profile: "product-candidates", requestId: input.requestId, sourceAssetId: input.profileContext.sourceAssetId, status: "success", candidates, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    });
    await page.goto("/creative/garment-colorway");
    await page.getByLabel("上传服装参考图", { exact: true }).setInputFiles({ name: "original.png", mimeType: "image/png", buffer: IMAGE });
    await page.getByRole("button", { name: "识别图中产品", exact: true }).click();
    await expect(page.getByRole("button", { name: "查询原识别请求", exact: true })).toBeEnabled();
    await page.reload();
    const query = page.getByRole("button", { name: "查询原识别请求", exact: true });
    await expect(query).toBeEnabled();
    expect(posts).toHaveLength(1); expect(queries).toHaveLength(0);
    await query.click();
    await expect(page.getByRole("alert")).toContainText("不代表未提交");
    expect(queries).toEqual([posts[0].requestId]);
    await expect(page.getByRole("button", { name: /重新识别/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /识别图中产品/ })).toHaveCount(0);
    found = true;
    await query.click();
    await expect(page.getByRole("button", { name: "确认使用所选产品", exact: true })).toBeDisabled();
    expect(posts).toHaveLength(1); expect(queries).toEqual([posts[0].requestId, posts[0].requestId]);
    expect(api.submissions).toHaveLength(0);
});

test("only a terminal failed receipt enables an explicitly paid new recognition attempt", async ({ page, context, api }) => {
    const posts: any[] = [];
    await context.route("**/api/chat/responses", async route => {
        const input = route.request().postDataJSON(); posts.push(input);
        const receipt: ProductCandidatesReceipt = { profile: "product-candidates", requestId: input.requestId, sourceAssetId: input.profileContext.sourceAssetId, status: posts.length === 1 ? "failed" : "success", message: posts.length === 1 ? "未取得有效候选" : undefined, candidates: posts.length === 1 ? undefined : candidates, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        await route.fulfill({ json: receipt });
    });
    await page.goto("/creative/pattern-extract");
    await page.getByLabel("上传图案参考图", { exact: true }).setInputFiles({ name: "original.png", mimeType: "image/png", buffer: IMAGE });
    await page.getByRole("button", { name: "识别图中产品", exact: true }).click();
    const retry = page.getByRole("button", { name: "重新识别", exact: true });
    await expect(retry).toBeEnabled(); expect(posts).toHaveLength(1);
    await page.reload(); await expect(retry).toBeEnabled(); expect(posts).toHaveLength(1);
    await retry.click();
    await expect(page.getByRole("button", { name: "确认使用所选产品", exact: true })).toBeDisabled();
    expect(posts).toHaveLength(2); expect(posts[1].requestId).not.toBe(posts[0].requestId);
    expect(posts[1].profileContext.sourceAssetId).toBe(posts[0].profileContext.sourceAssetId);
    expect(api.assets.size).toBe(1); expect(api.submissions).toHaveLength(0);
});

test("result review carries frozen requirements and original bytes into an isolated editable next draft", async ({ page, api }, info) => {
    await page.goto("/creative/garment-colorway");
    await page.getByRole("textbox", { name: /要处理的产品/ }).fill("普通草稿产品不能覆盖");
    await page.getByRole("textbox", { name: /关键特征保持/ }).fill("普通草稿要求不能覆盖");
    await page.goto("/creative/style-to-sketch");
    await page.getByLabel("上传服装参考图", { exact: true }).setInputFiles({ name: "original.png", mimeType: "image/png", buffer: IMAGE });
    await page.getByRole("textbox", { name: /要处理的产品/ }).fill("左侧蓝色衬衫");
    await page.getByRole("textbox", { name: /关键特征保持/ }).fill("保留六颗纽扣与小尖领");
    await page.getByRole("button", { name: /^生成线稿/ }).click();
    await expect(page.getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(1);
    await page.getByRole("textbox", { name: /要处理的产品/ }).fill("生成后改动不可混入旧结果");
    await page.getByRole("textbox", { name: /关键特征保持/ }).fill("生成后改动不可混入旧结果");
    await page.getByText("结果核对与继续处理", { exact: true }).click();
    await expect(page.getByText("实际输出：256 × 256 px · PNG", { exact: true })).toBeVisible();
    await expect(page.getByText("待人工核对，不代表已验收", { exact: true })).toBeVisible();
    await page.getByText(/将沿用的设计要求（/).click();
    await expect(page.getByText("目标产品：左侧蓝色衬衫", { exact: true })).toBeVisible();
    await expect(page.getByText("关键特征：保留六颗纽扣与小尖领", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("result-review-desktop.png"), fullPage: true });
    await page.getByLabel("下一步处理", { exact: true }).click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "服装配色" }).click();
    await page.getByRole("button", { name: "带入新草稿", exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === "/garment-colorway" && /^[\w-]+$/.test(url.searchParams.get("designToken") || ""));
    const handoffUrl = page.url();
    const requirements = page.getByRole("textbox", { name: "沿用设计要求", exact: true });
    await expect(requirements).toHaveValue("目标产品：左侧蓝色衬衫\n关键特征：保留六颗纽扣与小尖领");
    await expect(page.getByText("已带入结果原图和可编辑要求，保留原任务与普通草稿，未自动生成。", { exact: true })).toBeVisible();
    const resultTask = [...api.tasks.values()][0]!;
    const copiedBytes = await page.locator(".cs-upload-preview").evaluate(async image => Array.from(new Uint8Array(await (await fetch((image as HTMLImageElement).src)).arrayBuffer())));
    expect(Buffer.from(copiedBytes).equals(api.assetBytes.get(resultTask.id)!)).toBe(true);
    expect(api.submissions).toHaveLength(1);
    await requirements.fill("用户整理后的要求，刷新必须保留");
    await page.getByRole("textbox", { name: /关键特征保持/ }).fill("后续编辑新增要求");
    await page.reload();
    await expect(requirements).toHaveValue("用户整理后的要求，刷新必须保留");
    await expect(page.getByRole("textbox", { name: /关键特征保持/ })).toHaveValue("后续编辑新增要求");
    expect(api.submissions).toHaveLength(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await requirements.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("handoff-draft-mobile.png"), fullPage: true });
    await page.goto("/creative/garment-colorway");
    await expect(page.getByRole("textbox", { name: /要处理的产品/ })).toHaveValue("普通草稿产品不能覆盖");
    await expect(page.getByRole("textbox", { name: /关键特征保持/ })).toHaveValue("普通草稿要求不能覆盖");
    await page.goto(handoffUrl);
    await expect(requirements).toHaveValue("用户整理后的要求，刷新必须保留");
    expect(api.submissions).toHaveLength(1);
});

test("oversized recognition sources remain untouched and are blocked before server upload", async ({ page, api }) => {
    await page.goto("/creative/back-design");
    const bytes = Buffer.concat([IMAGE, Buffer.alloc(10 * 1024 * 1024 + 1 - IMAGE.length)]);
    await page.getByLabel("上传服装正面图", { exact: true }).setInputFiles({ name: "large-original.png", mimeType: "image/png", buffer: bytes });
    await expect(page.getByRole("button", { name: "识别图中产品", exact: true })).toBeDisabled();
    await expect(page.getByText("产品识别仅支持不超过 10 MiB 的单张原图；原件未压缩，可手动填写产品。", { exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: /要处理的产品/ }).fill("仍可手工指定产品");
    expect(api.assets.size).toBe(0); expect(api.submissions).toHaveLength(0);
    const previewBytes = await page.locator(".cs-upload-preview").evaluate(async image => (await (await fetch((image as HTMLImageElement).src)).arrayBuffer()).byteLength);
    expect(previewBytes).toBe(bytes.length);
});

test("a known pre-claim rejection needs an explicit same-ID retry, while ordinary page refresh never retries", async ({ page, context, api }) => {
    const posts: any[] = [];
    await context.route("**/api/chat/responses", async route => {
        const input = route.request().postDataJSON(); posts.push(input);
        if (posts.length === 1) return route.fulfill({ status: 503, json: { error: "PROVIDER_NOT_CONFIGURED", message: "服务端凭据未配置" } });
        return route.fulfill({ json: { profile: "product-candidates", requestId: input.requestId, sourceAssetId: input.profileContext.sourceAssetId, status: "success", candidates, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    });
    await page.goto("/creative/local-restyle");
    await page.getByLabel("上传服装参考图", { exact: true }).setInputFiles({ name: "original.png", mimeType: "image/png", buffer: IMAGE });
    await page.getByRole("button", { name: "识别图中产品", exact: true }).click();
    const retry = page.getByRole("button", { name: "重新识别", exact: true });
    await expect(retry).toBeEnabled();
    await expect(page.getByText("本次识别未提交。检查素材或配置后可明确再试，将沿用原编号核验，不会自动重发。", { exact: true })).toBeVisible();
    await page.reload(); await expect(retry).toBeEnabled(); expect(posts).toHaveLength(1);
    await retry.click();
    await expect(page.getByRole("button", { name: "确认使用所选产品", exact: true })).toBeDisabled();
    expect(posts).toHaveLength(2); expect(posts[1].requestId).toBe(posts[0].requestId);
    expect(posts[1].profileContext.sourceAssetId).toBe(posts[0].profileContext.sourceAssetId);
    expect(api.submissions).toHaveLength(0);
});
