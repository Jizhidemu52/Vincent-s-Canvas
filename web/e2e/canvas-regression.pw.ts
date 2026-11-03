import { test, expect, newCanvas, uploadImage, editText, IMAGE } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { readCanvasViewState } from "./canvas-view-state";

async function moveNode(page: Page, node: Locator, x: number, y: number) {
    await node.hover();
    const title = node.locator("[data-node-title]");
    await expect(title).toBeVisible();
    let box = (await node.boundingBox())!, handle = (await title.boundingBox())!;
    // New nodes avoid occupied space and can start above the current view.
    // Pan to the actual drag handle before pressing the pointer; a visible DOM
    // element alone does not imply that negative client coordinates are usable.
    const panY = Math.max(0, 100 - handle.y);
    if (panY) {
        await page.mouse.move(1600, 850); await page.mouse.down({ button: "middle" });
        await page.mouse.move(1600, 850 + panY, { steps: 10 }); await page.mouse.up({ button: "middle" });
        await expect.poll(async () => (await title.boundingBox())!.y).toBeGreaterThan(80);
        box = (await node.boundingBox())!; handle = (await title.boundingBox())!;
    }
    const start = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(start.x + x - box.x, start.y + y + panY - box.y, { steps: 12 }); await page.mouse.up();
    if (panY) {
        await page.mouse.move(1600, 850 + panY); await page.mouse.down({ button: "middle" });
        await page.mouse.move(1600, 850, { steps: 10 }); await page.mouse.up({ button: "middle" });
    }
    await expect.poll(async () => { const moved = (await node.boundingBox())!; return Math.abs(moved.x - x) + Math.abs(moved.y - y); }).toBeLessThan(2);
}

async function connect(page: Page, source: Locator, target: Locator) {
    await source.click({ position: { x: 12, y: 100 } });
    // Image selection opens the creation rail; close it before reaching the
    // source's canvas connection ports with the real pointer.
    const collapse = page.getByRole("button", { name: "收起创建面板", exact: true });
    if (await collapse.isVisible()) await collapse.click();
    // Selection changes the image node's render tier; re-enter once settled so
    // its hover-only connection ports are exposed just as in normal pointer use.
    await page.mouse.move(20, 1000);
    await expect(source.locator('[data-canvas-resize-handle="top-left"]')).toBeVisible();
    await source.hover();
    const port = source.locator('[data-canvas-connection-handle="right"]');
    await port.hover();
    await expect.poll(() => port.evaluate(element => { const rect = element.getBoundingClientRect(); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("[data-canvas-connection-handle]") === element; })).toBe(true);
    const from = (await port.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
    const to = (await target.locator('[data-canvas-connection-handle="left"]').boundingBox())!;
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 16 });
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
    await expect(page.getByRole("button", { name: "展开创建面板", exact: true })).toBeVisible();
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

test("两个独立浏览器并发编辑同一节点，冲突副本保留双方内容", async ({ page, browser, api }, testInfo) => {
    const id = await newCanvas(page);
    await page.getByRole("button", { name: "文本", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const nodeId = api.document(id)!.nodes[0].id;
    await editText(page, nodeId, "共同基线");
    await expect.poll(() => api.document(id)?.nodes[0].metadata.content).toBe("共同基线");
    // Same-browser tabs are now protected by the edit lock. Separate contexts
    // model two devices: independent local state with the same cloud revision.
    const otherContext = await browser.newContext({ baseURL: testInfo.project.use.baseURL, viewport: page.viewportSize(), serviceWorkers: "block" });
    await api.attach(otherContext);
    const other = await otherContext.newPage();
    try {
        await other.goto(page.url());
        await expect(other.locator(`[data-node-id="${nodeId}"]`)).toContainText("共同基线");
        api.holdWrites = true;
        await Promise.all([editText(page, nodeId, "标签 A 的修改"), editText(other, nodeId, "标签 B 的修改")]);
        await expect.poll(() => api.pendingWrites()).toBeGreaterThanOrEqual(2);
        await api.releaseWrites();
        const contents = () => [...api.documents.values()].flatMap(record => record.document?.nodes.map((node: any) => node.metadata?.content) || []);
        await expect.poll(contents).toEqual(expect.arrayContaining(["标签 A 的修改", "标签 B 的修改"]));
        expect([...api.documents.values()].some(record => record.document?.persistenceConflict)).toBe(true);
        expect(api.conflicts).toBeGreaterThan(0);
        await page.goto("/canvas");
        await expect(page.getByText(/冲突副本/).first()).toBeVisible();
    } finally { await otherContext.close(); }
});

for (const type of ["config", "text"] as const) for (const scale of [.5, 1, 2]) {
    test(`选中${type}节点在${scale * 100}%缩放下连线与侧边缩放命中区互不遮挡`, async ({ page, api }, info) => {
        const id = `side-controls-${type}-${scale}`, now = new Date().toISOString();
        const height = type === "config" ? 480 : 240;
        const original = { id: "side-node", type, title: "独立控件", width: 400, height, position: { x: 700, y: 600 - height / 2 }, metadata: { content: type === "text" ? "保留文字" : "", generationMode: "image" } };
        api.documents.set(id, { id, revision: 1, deleted: false, updatedAt: now, document: { id, title: id, createdAt: now, updatedAt: now, nodes: [original], connections: [], groups: [], viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "dots", chatSessions: [], activeChatId: null } });
        await page.goto(`/canvas/${id}`);
        const node = page.locator('[data-node-id="side-node"]');
        await expect(node).toBeVisible();
        if (scale !== 1) {
            await page.getByRole("button", { name: "画布缩放与视图", exact: true }).click();
            const input = page.getByRole("spinbutton", { name: "画布缩放百分比", exact: true });
            await input.fill(String(scale * 100)); await input.press("Enter");
            await page.getByRole("button", { name: "画布缩放与视图", exact: true }).click();
            await expect.poll(async () => (await readCanvasViewState(page, id))?.viewport.k).toBe(scale);
        }
        await node.hover();
        await node.locator("[data-node-title]").click();
        await expect(node).toHaveAttribute("aria-label", /已选择/);
        for (const side of ["left", "right"]) for (const control of ["connection", "resize"]) {
            const handle = node.locator(`[data-canvas-${control}-handle="${side}"]`);
            await handle.hover();
            expect(await handle.evaluate(element => { const rect = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); })).toBe(true);
        }
        const resize = node.locator('[data-canvas-resize-handle="right"]');
        const box = (await resize.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 8 }); await page.mouse.up();
        await expect.poll(() => api.document(id)?.nodes[0].width).toBeCloseTo(original.width + 40 / scale, 0);
        expect(api.document(id)?.nodes[0].height).toBe(height);
        expect(api.document(id)?.connections).toEqual([]);
        await page.getByRole("button", { name: "撤销", exact: true }).click();
        await expect.poll(() => api.document(id)?.nodes[0].width).toBe(original.width);
        if (scale === 1) await page.screenshot({ path: info.outputPath(`${type}-side-controls.png`) });
        expect(api.submissions).toHaveLength(0);
    });
}

test("64px高文本在50%缩放隐藏冗余侧柄，连线中心与角柄仍可操作", async ({ page, api }) => {
    const id = "tiny-text-side-controls", now = new Date().toISOString();
    const original = { id: "tiny-node", type: "text", title: "短文本控件", width: 400, height: 64, position: { x: 700, y: 568 }, metadata: { content: "保留短文本" } };
    api.documents.set(id, { id, revision: 1, deleted: false, updatedAt: now, document: { id, title: id, createdAt: now, updatedAt: now, nodes: [original], connections: [], groups: [], viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "dots", chatSessions: [], activeChatId: null } });
    await page.goto(`/canvas/${id}`);
    const node = page.locator('[data-node-id="tiny-node"]');
    await expect(node).toBeVisible();
    await page.getByRole("button", { name: "画布缩放与视图", exact: true }).click();
    const zoom = page.getByRole("spinbutton", { name: "画布缩放百分比", exact: true });
    await zoom.fill("50"); await zoom.press("Enter");
    await page.getByRole("button", { name: "画布缩放与视图", exact: true }).click();
    await expect.poll(async () => (await readCanvasViewState(page, id))?.viewport.k).toBe(.5);
    await node.hover();
    await node.locator("[data-node-title]").click();
    await expect(node).toHaveAttribute("aria-label", /已选择/);
    const assertTinyControls = async () => {
        for (const side of ["left", "right"]) {
            await expect(node.locator(`[data-canvas-resize-handle="${side}"]`)).toBeHidden();
            const port = node.locator(`[data-canvas-connection-handle="${side}"]`);
            await port.hover();
            expect(await port.evaluate(element => { const rect = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); })).toBe(true);
        }
    };
    await assertTinyControls();
    const corner = node.locator('[data-canvas-resize-handle="bottom-right"]');
    await corner.hover();
    expect(await corner.evaluate(element => { const rect = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); })).toBe(true);
    const box = (await corner.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 20, { steps: 8 }); await page.mouse.up();
    await expect.poll(() => ({ width: api.document(id)?.nodes[0].width, height: api.document(id)?.nodes[0].height })).toEqual({ width: 480, height: 104 });
    expect(api.document(id)?.connections).toEqual([]);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(() => ({ width: api.document(id)?.nodes[0].width, height: api.document(id)?.nodes[0].height })).toEqual({ width: original.width, height: original.height });
    await assertTinyControls();
    expect(api.document(id)?.nodes[0].metadata.content).toBe(original.metadata.content);
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});
