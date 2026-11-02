import { test, expect } from "./fixtures";

function seed(api: any, id: string, withEdges = true) {
    const now = new Date().toISOString();
    const nodes = [
        { id: "a", type: "image", title: "参考A", width: 160, height: 160, position: { x: 350, y: 300 }, metadata: { content: "/api/assets/a/content" } },
        { id: "b", type: "image", title: "参考B", width: 160, height: 160, position: { x: 850, y: 300 }, metadata: { content: "/api/assets/b/content" } },
        { id: "c", type: "image", title: "参考C", width: 160, height: 160, position: { x: 1200, y: 620 }, metadata: { content: "/api/assets/c/content" } },
        { id: "d", type: "image", title: "参考D", width: 160, height: 160, position: { x: 350, y: 620 }, metadata: { content: "/api/assets/d/content" } },
    ];
    const document = { id, title: "连线与边缘拖拽", createdAt: now, updatedAt: now, nodes,
        connections: withEdges ? [{ id: "edge-ab", fromNodeId: "a", toNodeId: "b", kind: "reference" }] : [],
        groups: [], viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "dots", showImageInfo: false, chatSessions: [], activeChatId: null };
    api.documents.set(id, { id, revision: 1, deleted: false, document, updatedAt: now });
    return document;
}

test("连线两端可改接，取消和无效落点保留原线，成功改接一步撤销", async ({ page, api }, info) => {
    const id = "connection-rewire-v518"; const original = seed(api, id);
    await page.goto(`/canvas/${id}`);
    await expect(page.locator('[data-node-id="b"]')).toBeVisible();
    await page.mouse.click(680, 380);
    const end = page.getByRole("button", { name: "拖动改接终点", exact: true });
    await expect(end).toBeVisible();
    let box = (await end.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(1205, 700, { steps: 8 });
    await expect(page.locator('[data-connection-kind]')).toContainText("作为输入参考");
    await page.mouse.up();
    await expect.poll(() => api.document(id)?.connections).toEqual([{ id: "edge-ab", fromNodeId: "a", toNodeId: "c", kind: "reference" }]);
    await page.keyboard.press("Control+z");
    await expect.poll(() => api.document(id)?.connections).toEqual(original.connections);
    await page.mouse.click(680, 380);
    const start = page.getByRole("button", { name: "拖动改接起点", exact: true });
    await expect(start).toBeVisible(); box = (await start.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(505, 700, { steps: 8 }); await page.mouse.up();
    await expect.poll(() => api.document(id)?.connections).toEqual([{ id: "edge-ab", fromNodeId: "d", toNodeId: "b", kind: "reference" }]);
    box = (await page.getByRole("button", { name: "拖动改接终点", exact: true }).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(1100, 850, { steps: 8 }); await page.keyboard.press("Escape"); await page.mouse.up();
    expect(api.document(id)?.connections[0]).toEqual({ id: "edge-ab", fromNodeId: "d", toNodeId: "b", kind: "reference" });
    await expect(page.locator("[data-connection-create-menu]")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("rewire-retained.png") });
    expect(api.submissions).toHaveLength(0);
});

test("拖动节点到边缘自动平移，静止指针仍跟随，松手停止且可撤销移动", async ({ page, api }) => {
    const id = "node-edge-pan-v518"; const original = seed(api, id, false);
    await page.goto(`/canvas/${id}`);
    const node = page.locator('[data-node-id="b"]'); await expect(node).toBeVisible();
    let box = (await node.boundingBox())!;
    await page.mouse.move(box.x + 80, box.y + 80); await page.mouse.down();
    await page.mouse.move(1782, 520, { steps: 12 });
    await page.waitForTimeout(650);
    box = (await node.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - 1782)).toBeLessThan(5);
    expect(Math.abs(box.y + box.height / 2 - 520)).toBeLessThan(5);
    await page.mouse.up();
    const viewX = () => page.locator("[data-canvas-viewport] > .origin-top-left").evaluate(element => new DOMMatrix(getComputedStyle(element).transform).m41);
    await expect.poll(viewX).toBeLessThan(-80);
    const settled = await viewX();
    await page.waitForTimeout(250);
    expect(await viewX()).toBe(settled);
    await page.keyboard.press("Control+z");
    await expect.poll(() => api.document(id)?.nodes.find((item: any) => item.id === "b")?.position).toEqual(original.nodes[1].position);
    expect(api.submissions).toHaveLength(0);
});

test("拖线到边缘平移，Esc停止并保留原图与空连线", async ({ page, api }) => {
    const id = "connection-edge-pan-v518"; const original = seed(api, id, false);
    await page.goto(`/canvas/${id}`);
    const node = page.locator('[data-node-id="b"]'); await expect(node).toBeVisible(); await node.hover();
    const port = node.locator('[data-canvas-connection-handle="right"]'); await expect(port).toBeVisible();
    const box = (await port.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(1782, 520, { steps: 12 }); await page.waitForTimeout(500);
    await page.keyboard.press("Escape"); await page.mouse.up();
    const viewX = () => page.locator("[data-canvas-viewport] > .origin-top-left").evaluate(element => new DOMMatrix(getComputedStyle(element).transform).m41);
    await expect.poll(viewX).toBeLessThan(-50);
    const settled = await viewX();
    await page.waitForTimeout(250); expect(await viewX()).toBe(settled);
    expect(api.document(id)?.nodes).toEqual(original.nodes);
    expect(api.document(id)?.connections).toEqual([]);
    await expect(page.locator("[data-connection-create-menu]")).toHaveCount(0);
    expect(api.submissions).toHaveLength(0);
});
