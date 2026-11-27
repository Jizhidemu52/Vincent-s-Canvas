import { test, expect, newCanvas, uploadImage } from "./fixtures";

test("new text-only canvas saves to cloud without requiring an image upload", async ({ page, api }) => {
    const id = await newCanvas(page);
    await page.getByRole("button", { name: "文本", exact: true }).click();
    await expect.poll(async () => {
        const state = await page.evaluate(async () => {
            const { useCanvasStore } = await import("/src/stores/canvas/use-canvas-store.ts");
            const state = useCanvasStore.getState();
            return { status: state.cloudStatus, error: state.cloudError };
        });
        if (state.error) throw new Error(JSON.stringify(state));
        return api.document(id)?.nodes.length;
    }).toBe(1);
});

test("上传原图遇到失效素材时从本机原件自动恢复，刷新可读", async ({ page, api }, info) => {
    const id = await newCanvas(page);
    let rejected = "";
    await page.route(`**/api/canvas-documents/${id}`, async route => {
        if (route.request().method() !== "PUT") return route.fallback();
        const image = route.request().postDataJSON().document?.nodes.find((node: { type: string }) => node.type === "image");
        const assetId = image?.metadata?.content?.split("/")[3];
        if (!assetId) return route.fallback();
        rejected ||= assetId;
        if (assetId !== rejected) return route.fallback();
        return route.fulfill({ status: 403, json: { error: "CANVAS_ASSET_FORBIDDEN", message: "素材不可用", rejectedAssetIds: [rejected] } });
    });
    await uploadImage(page, "款式原稿.png");
    await expect.poll(() => api.document(id)?.nodes[0]?.metadata.content).toMatch(/^\/api\/assets\//);
    const saved = api.document(id)!.nodes[0];
    expect(rejected).toBeTruthy();
    const replacement = saved.metadata.content.split("/")[3];
    expect(replacement).not.toBe(rejected);
    expect(api.assetBytes.get(replacement)).toEqual(api.assetBytes.get(rejected));
    await page.reload();
    await expect(page.locator(`[data-node-id="${saved.id}"] img`).first()).toBeVisible();
    await expect(page.getByTestId("canvas-save-status")).toHaveAccessibleName("画布与图片已保存至服务器");
    await page.screenshot({ path: info.outputPath("canvas-media-recovered.png") });
});

test("失效素材显示对应节点，用户点击重试后完整保存最新草稿", async ({ page, api }, info) => {
    const id = await newCanvas(page);
    let denied = true;
    await page.route(`**/api/canvas-documents/${id}`, async route => {
        if (!denied || route.request().method() !== "PUT") return route.fallback();
        const image = route.request().postDataJSON().document?.nodes.find((node: { type: string }) => node.type === "image");
        const assetId = image?.metadata?.content?.split("/")[3];
        if (!assetId) return route.fallback();
        return route.fulfill({ status: 403, json: { error: "CANVAS_ASSET_FORBIDDEN", rejectedAssetIds: [assetId] } });
    });
    await uploadImage(page, "测试款式.png");
    const status = page.getByTestId("canvas-save-status");
    await expect(status).toHaveAccessibleName("服务器保存失败 · 点击重试");
    await status.hover();
    await expect(page.getByRole("tooltip").filter({ hasText: /节点「.+」有无法访问的素材/ })).toBeVisible();
    await page.screenshot({ path: info.outputPath("canvas-retry-guidance.png") });
    await page.getByRole("button", { name: "文本", exact: true }).click();
    await expect(page.locator("[data-node-id]")).toHaveCount(2);
    denied = false;
    await status.click();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
    await expect(status).toHaveAccessibleName("画布与图片已保存至服务器");
});
