import { test, expect, newCanvas, uploadImage, editText, IMAGE } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

async function moveNode(page: Page, node: Locator, x: number, y: number) {
    const box = (await node.boundingBox())!;
    await page.mouse.move(box.x + 30, box.y + 15); await page.mouse.down();
    await page.mouse.move(x + 30, y + 15, { steps: 12 }); await page.mouse.up();
}

async function connect(page: Page, source: Locator, target: Locator) {
    await source.click({ position: { x: 30, y: 15 } });
    // Selection changes the image node's render tier; re-enter once settled so
    // its hover-only connection ports are exposed just as in normal pointer use.
    await page.mouse.move(20, 1000);
    await expect(source.locator('[data-canvas-resize-handle="top-left"]')).toBeVisible();
    await source.hover();
    const from = (await source.locator('[data-canvas-connection-handle="right"]').boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
    const targetBox = (await target.boundingBox())!;
    await page.mouse.move(targetBox.x, targetBox.y + targetBox.height / 2, { steps: 16 });
    await page.mouse.up();
}

test("新建画布、上传素材并刷新后保留原图", async ({ page, api }) => {
    const id = await newCanvas(page);
    await uploadImage(page);
    await expect(page.locator("[data-node-id]")).toHaveCount(1);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const imageId = api.document(id)!.nodes[0].id;
    expect(api.document(id)!.nodes[0].type).toBe("image");
    await page.reload();
    const node = page.locator(`[data-node-id="${imageId}"]`);
    await expect(node).toBeVisible();
    await expect(node.locator("img").first()).toBeVisible();
    expect(api.submissions).toHaveLength(0);
});

test("撤销节点移动后刷新，历史与节点坐标保留", async ({ page, api }) => {
    const id = await newCanvas(page);
    await page.getByRole("button", { name: "文本", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const nodeId = api.document(id)!.nodes[0].id;
    await editText(page, nodeId, "撤销与刷新回归");
    await expect.poll(() => api.document(id)?.nodes[0].metadata.content).toBe("撤销与刷新回归");
    const original = { ...api.document(id)!.nodes[0].position };
    const node = page.locator(`[data-node-id="${nodeId}"]`), box = (await node.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 12); await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + 90, { steps: 12 }); await page.mouse.up();
    await expect.poll(() => api.document(id)?.nodes[0].position.x).not.toBe(original.x);
    const dragged = { ...api.document(id)!.nodes[0].position };
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes[0].position).toEqual(original);
    await page.reload();
    await expect(page.locator(`[data-node-id="${nodeId}"]`)).toContainText("撤销与刷新回归");
    await expect(page.getByRole("button", { name: "重做", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes[0].position).toEqual(dragged);
});

test("批量改图暂停和恢复不重复创建批次", async ({ page, api }) => {
    await newCanvas(page);
    await page.getByRole("button", { name: "更多工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "批量改图", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "批量一键改图" });
    const chooser = page.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: "选择图片（可多选）" }).click();
    await (await chooser).setFiles(["a.png", "b.png"].map(name => ({ name, mimeType: "image/png", buffer: IMAGE })));
    await dialog.locator("textarea").fill("保留产品结构，仅更换背景");
    await dialog.getByRole("button", { name: "一键生图", exact: true }).click();
    await expect.poll(() => api.batchSubmissions.length).toBe(1);
    await expect(dialog.getByRole("button", { name: "暂停等待项" })).toBeEnabled();
    await dialog.getByRole("button", { name: "暂停等待项" }).click();
    await expect(dialog.getByText("已暂停", { exact: true })).toHaveCount(2);
    await dialog.getByRole("button", { name: "恢复", exact: true }).click();
    await expect(dialog.getByText("等待中", { exact: true })).toHaveCount(2);
    api.completeBatch();
    await expect(dialog.getByText("成功", { exact: true })).toHaveCount(2);
    expect(api.batchActions).toEqual(["pause", "resume"]);
    expect(api.batchSubmissions).toHaveLength(1);
    expect(api.submissions).toHaveLength(0);
});

test("真实拖线串联两个配置节点，后一步使用前一步结果", async ({ page, api }) => {
    const id = await newCanvas(page);
    await page.getByRole("button", { name: "收起创建面板", exact: true }).click();
    await uploadImage(page);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const sourceId = api.document(id)!.nodes[0].id;
    const source = page.locator(`[data-node-id="${sourceId}"]`);
    await moveNode(page, source, 100, 400);
    const configIds: string[] = [];
    for (let index = 0; index < 2; index++) {
        await page.getByRole("button", { name: "更多工具", exact: true }).click();
        await page.getByRole("menuitem", { name: "生成配置", exact: true }).click();
        await expect.poll(() => api.document(id)?.nodes.filter((node: any) => node.type === "config").length).toBe(index + 1);
        const configId = api.document(id)!.nodes.filter((node: any) => node.type === "config").at(-1).id;
        configIds.push(configId);
        await moveNode(page, page.locator(`[data-node-id="${configId}"]`), 450 + index * 650, 200);
    }
    const first = page.locator(`[data-node-id="${configIds[0]}"]`), second = page.locator(`[data-node-id="${configIds[1]}"]`);
    await connect(page, source, first);
    await connect(page, first, second);
    await expect.poll(() => api.document(id)?.connections.length).toBe(2);
    await first.getByRole("textbox", { name: "提示词", exact: true }).fill("第一步：将背景改成白色");
    await second.getByRole("textbox", { name: "提示词", exact: true }).fill("第二步：增强产品质感");
    await first.getByRole("button", { name: "运行工作流", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(2);
    await expect(first.getByRole("button", { name: "重新运行工作流", exact: true })).toBeVisible();
    expect(api.submissions[0].prompt).toContain("第一步：将背景改成白色");
    expect(api.submissions[1].prompt).toContain("第二步：增强产品质感");
    const firstTask = [...api.tasks.values()][0];
    expect(api.submissions[1].sourceUrls).toHaveLength(1);
    const nextInputId = api.submissions[1].sourceUrls[0].split("/")[3];
    expect(api.assetBytes.get(nextInputId)).toEqual(api.assetBytes.get(firstTask.id));
    expect(api.assetBytes.get(nextInputId)).not.toEqual(IMAGE);
    await expect.poll(() => api.document(id)?.nodes.filter((node: any) => node.type === "image").length).toBe(3);
    await page.reload();
    await expect(page.getByRole("button", { name: "重新运行工作流", exact: true }).first()).toBeVisible();
    expect(api.submissions).toHaveLength(2);
});

test("两个标签并发编辑同一节点，冲突副本保留双方内容", async ({ page, context, api }) => {
    const id = await newCanvas(page);
    await page.getByRole("button", { name: "文本", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const nodeId = api.document(id)!.nodes[0].id;
    await editText(page, nodeId, "共同基线");
    await expect.poll(() => api.document(id)?.nodes[0].metadata.content).toBe("共同基线");
    const other = await context.newPage();
    await other.goto(page.url());
    await expect(other.locator(`[data-node-id="${nodeId}"]`)).toContainText("共同基线");
    api.holdWrites = true;
    await Promise.all([editText(page, nodeId, "标签 A 的修改"), editText(other, nodeId, "标签 B 的修改")]);
    await expect.poll(() => api.pendingWrites()).toBeGreaterThanOrEqual(1);
    await api.releaseWrites();
    const contents = () => [...api.documents.values()].flatMap(record => record.document?.nodes.map((node: any) => node.metadata?.content) || []);
    await expect.poll(contents).toEqual(expect.arrayContaining(["标签 A 的修改", "标签 B 的修改"]));
    expect([...api.documents.values()].some(record => record.document?.persistenceConflict)).toBe(true);
    await page.goto("/canvas");
    await expect(page.getByText(/冲突副本/).first()).toBeVisible();
    await other.close();
});
