import { test, expect, newCanvas, IMAGE } from "./fixtures";
import type { Page } from "@playwright/test";
import { parseCanvasProject } from "../src/lib/canvas/canvas-project-codec";

async function localNode(page: Page, projectId: string, nodeId: string) {
    const key = JSON.stringify(["wireless-canvas:canvas_store:oa:user:00000000-0000-4000-8000-000000000099:project-documents:v1", projectId]);
    const value = await page.evaluate(key => new Promise<string | undefined>((resolve, reject) => {
        const opening = indexedDB.open("wireless-canvas");
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
            const database = opening.result;
            const request = database.transaction("app_state", "readonly").objectStore("app_state").get(key);
            request.onsuccess = () => { database.close(); resolve(request.result); };
            request.onerror = () => { database.close(); reject(request.error); };
        };
    }), key);
    return value ? parseCanvasProject(value).nodes.find(node => node.id === nodeId) : undefined;
}

test("empty template reference uploads an original into the same node and restores it after refresh", async ({ page, api }) => {
    const id = await newCanvas(page);
    await page.getByTestId("canvas-empty-start").getByRole("button", { name: /用模板开始/ }).click();
    await page.getByRole("dialog", { name: "整套服装画布模板", exact: true }).getByRole("button", { name: "添加这套流程", exact: true }).first().click();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(4);
    const graph = structuredClone(api.document(id)!);
    const source = graph.nodes.find((node: any) => node.type === "image");
    const branch = graph.nodes.find((node: any) => node.type === "config");
    const configPanel = page.locator(`[data-node-id="${branch.id}"]`);
    const chip = configPanel.locator(`[data-reference-node-id="${source.id}"]`);
    await expect(chip).toHaveAttribute("data-reference-state", "pending");
    await expect(chip).toHaveText("待上传原图");
    await expect(configPanel.getByRole("button", { name: "开始生成", exact: true })).toBeDisabled();
    await expect(configPanel.getByRole("status").filter({ hasText: "先设置参考款原图" })).toBeVisible();
    await expect(configPanel).not.toContainText("已失效引用");
    await page.locator(`[data-node-id="${source.id}"]`).dblclick({ position: { x: 40, y: 40 } });
    const setup = page.getByRole("region", { name: "参考款原图设置", exact: true });
    await expect(setup).toBeVisible();
    const chooser = page.waitForEvent("filechooser");
    await setup.getByRole("button", { name: "上传参考款原图", exact: true }).click();
    const upload = await chooser;
    expect(upload.isMultiple()).toBe(false);
    expect(await upload.element().getAttribute("accept")).toBe("image/*");
    await upload.setFiles({ name: "template-original.png", mimeType: "image/png", buffer: IMAGE });
    await expect.poll(() => api.document(id)?.nodes.find((node: any) => node.id === source.id)?.metadata?.naturalWidth).toBe(256);
    const saved = structuredClone(api.document(id)!);
    expect(saved.nodes).toHaveLength(4);
    expect(saved.connections).toEqual(graph.connections);
    expect(saved.groups).toEqual(graph.groups);
    expect(saved.nodes.find((node: any) => node.id === source.id).title).toBe("template-original.png");
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
    await expect(chip).toHaveAttribute("data-reference-state", "image");
    await expect(chip.locator("img")).toBeVisible();
    await expect(configPanel.getByRole("button", { name: "开始生成", exact: true })).toBeEnabled();
    await page.reload();
    const preview = page.locator(`[data-node-id="${source.id}"] img`).first();
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    expect(api.document(id)!.connections).toEqual(graph.connections);
    expect(api.submissions).toHaveLength(0);
    // A real deletion is still an invalid reference, not another upload slot.
    await page.locator(`[data-node-id="${source.id}"]`).click({ position: { x: 40, y: 40 } });
    await page.keyboard.press("Delete");
    await expect.poll(() => api.document(id)?.nodes.some((node: any) => node.id === source.id)).toBe(false);
    await expect(chip).toHaveAttribute("data-reference-state", "invalid");
    await expect(chip).toHaveText("已失效引用 ×");
    await configPanel.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect(page.getByText("提示词中含有已失效引用，请移除该引用并重新选择素材。", { exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});

test("existing single attachment is promoted with its original storage key and shared cloud asset", async ({ page, api }, info) => {
    const id = "70000000-0000-4000-8000-000000000091";
    const source = { id: "template-reference", type: "image", title: "参考款 · 请上传图片", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: {
        status: "idle", manualImageReferences: [{ id: "attached", referenceKey: "upload:attached", name: "existing-original.png", type: "image/png", origin: "upload", content: "/api/assets/template-reference/content", storageKey: "image:retained-original" }],
    } };
    const branches = ["技术线稿", "改色方案", "上身效果图"].map((title, index) => ({ id: `branch-${index}`, type: "config", title, position: { x: 440, y: index * 240 }, width: 320, height: 180,
        metadata: { status: "idle", generationMode: "image", generationType: "edit", model: "gpt-image-2", prompt: "保留款式", composerContent: `参考款：@[node:${source.id}]\n保留款式`, promptInput: { scene: "garment-colorway", fields: { templateId: "development", branchIndex: index }, userText: "保留款式", mode: "edit" } },
    }));
    const connections = branches.map(node => ({ id: `edge-${node.id}`, fromNodeId: source.id, toNodeId: node.id }));
    const document = { id, title: "参考款原图恢复", createdAt: "2026-11-11T00:00:00Z", updatedAt: "2026-11-11T00:00:00Z", nodes: [source, ...branches], connections, groups: [], chatSessions: [], activeChatId: null,
        backgroundMode: "dots", showImageInfo: false, viewport: { x: 450, y: 220, k: 1 }, selectedNodeIds: [], history: { past: [], future: [] } };
    api.assetBytes.set("template-reference", IMAGE);
    api.documents.set(id, { id, revision: 1, document, deleted: false, updatedAt: document.updatedAt });
    await page.goto(`/canvas/${id}`);
    await page.locator(`[data-node-id="${source.id}"]`).dblclick({ position: { x: 40, y: 40 } });
    const setup = page.getByRole("region", { name: "参考款原图设置", exact: true });
    await expect(setup).toBeVisible();
    await setup.screenshot({ path: info.outputPath("template-source-recovery.png") });
    const uploads = api.assets.size;
    await setup.getByRole("button", { name: "将这张参考图设为原图", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.find((node: any) => node.id === source.id)?.metadata?.naturalWidth).toBe(256);
    const saved = api.document(id)!;
    const promoted = saved.nodes.find((node: any) => node.id === source.id);
    // Cloud documents intentionally use portable asset URLs; browser persistence keeps the storage identity.
    await expect.poll(async () => (await localNode(page, id, source.id))?.metadata?.storageKey).toBe("image:retained-original");
    expect((await localNode(page, id, source.id))?.metadata?.manualImageReferences).toEqual(source.metadata.manualImageReferences);
    expect(promoted.metadata.content).toBe(promoted.metadata.manualImageReferences[0].content);
    expect(saved.nodes).toHaveLength(4);
    expect(saved.connections).toEqual(connections);
    // The seeded reference has not been published before: its first cloud save creates one shared asset, not one per occurrence.
    expect(api.assets.size).toBe(uploads + 1);
    expect(api.submissions).toHaveLength(0);
    await page.reload();
    await expect(page.locator(`[data-node-id="${source.id}"] img`).first()).toBeVisible();
    expect((await localNode(page, id, source.id))?.metadata?.storageKey).toBe("image:retained-original");
    expect(api.submissions).toHaveLength(0);
});
