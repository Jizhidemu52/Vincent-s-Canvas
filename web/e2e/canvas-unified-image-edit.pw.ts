import { test, expect, IMAGE } from "./fixtures";

for (const source of ["uploaded", "generated", "config-linked"]) test(`${source} opens AI edit in the same composer without executing the graph`, async ({ page, api }, info) => {
    const id = "51000000-0000-4000-8000-000000000115", assetId = "51000000-0000-4000-8000-000000000001";
    const now = new Date().toISOString();
    api.assetBytes.set(assetId, IMAGE);
    const node = { id: "picture", type: "image", title: "款式原图", position: { x: 510, y: 270 }, width: 220, height: 220,
        metadata: { content: `/api/assets/${assetId}/content`, status: source === "generated" ? "success" : "idle", ...(source === "generated" ? { sourceTaskId: "finished-fixture-task" } : {}) } };
    const config = { id: "shared", type: "config", title: "共享配置", position: { x: 100, y: 260 }, width: 250, height: 180, metadata: { generationMode: "image", model: "gpt-image-2", prompt: "共享配置原文" } };
    const connections = source === "config-linked" ? [{ id: "binding", kind: "config-target", fromNodeId: config.id, toNodeId: node.id }] : [];
    const document = { id, title: "图片编辑入口", createdAt: now, updatedAt: now, nodes: connections.length ? [config, node] : [node], connections, groups: [],
        viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "dots", showImageInfo: false, chatSessions: [], activeChatId: null, history: { past: [], future: [] } };
    api.documents.set(id, { id, revision: 1, deleted: false, document, updatedAt: now });
    await page.goto(`/canvas/${id}`);
    const image = page.locator('[data-node-id="picture"]');
    await image.click({ position: { x: 35, y: 15 } });
    await image.hover();
    await page.getByRole("toolbar", { name: "图片工具栏" }).getByRole("button", { name: "AI 改图", exact: true }).click();
    const panel = page.getByTestId("canvas-quick-generate-panel");
    const prompt = panel.getByRole("textbox", { name: "描述图像" });
    await expect(prompt).toBeVisible();
    await prompt.fill("只把袖口改成深蓝色");
    await expect(prompt).toHaveValue("只把袖口改成深蓝色");
    if (connections.length) {
        expect(api.document(id)?.connections).toEqual(connections);
        expect(api.document(id)?.nodes.find((item: { id: string }) => item.id === config.id)?.metadata.prompt).toBe("共享配置原文");
    }
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
    await panel.screenshot({ path: info.outputPath("image-edit-entry.png") });
});
