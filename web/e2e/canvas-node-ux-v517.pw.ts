import { test, expect, newCanvas, uploadImage, IMAGE } from "./fixtures";

test("精确缩放、H/V工具、300ms连续微移一次撤销和空白双击文本", async ({ page, api }, info) => {
    const id = await newCanvas(page);
    await uploadImage(page);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const original = structuredClone(api.document(id)!.nodes[0]);
    await page.keyboard.press("Escape");
    await page.locator(`[data-node-id="${original.id}"]`).click();
    for (let i = 0; i < 3; i++) { await page.keyboard.press("ArrowRight"); if (i < 2) await page.waitForTimeout(300); }
    await expect.poll(() => api.document(id)?.nodes[0].position.x).toBe(original.position.x + 3);
    await page.keyboard.press("Control+z");
    await expect.poll(() => api.document(id)?.nodes[0].position.x).toBe(original.position.x);
    await page.getByRole("button", { name: "画布缩放与视图", exact: true }).click();
    const exact = page.getByRole("spinbutton", { name: "画布缩放百分比", exact: true });
    await exact.fill("75"); await exact.press("Enter");
    await expect(page.getByRole("button", { name: "画布缩放与视图", exact: true })).toContainText("75%");
    await page.getByRole("button", { name: "画布缩放与视图", exact: true }).dblclick();
    await expect(page.getByRole("button", { name: "画布缩放与视图", exact: true })).toContainText("100%");
    await page.keyboard.press("h");
    await expect(page.locator("[data-canvas-viewport]")).toHaveAttribute("data-cursor-mode", "grab");
    await page.keyboard.press("v");
    await expect(page.locator("[data-canvas-viewport]")).toHaveAttribute("data-cursor-mode", "select");
    await page.locator("[data-canvas-viewport]").dblclick({ position: { x: 1400, y: 400 } });
    await expect(page.locator("[data-node-id]")).toHaveCount(2);
    await expect(page.locator('[data-node-id][tabindex="0"]')).toHaveCount(1);
    const editor = page.locator("[data-node-id] textarea").first();
    await expect(editor).toBeFocused(); await editor.fill("双击新建的文本"); await editor.press("Escape");
    await expect.poll(() => api.document(id)?.nodes.some((node: any) => node.metadata?.content === "双击新建的文本")).toBe(true);
    await page.screenshot({ path: info.outputPath("zoom-keys-text.png") });
    expect(api.submissions).toHaveLength(0);
});

test("折叠组保留外部连线，悬停可删除并撤销，组卡片不随缩放变小", async ({ page, api }, info) => {
    const id = "root-collapsed-connections", now = new Date().toISOString();
    const nodes = [
        { id: "a", type: "image", title: "组内A", width: 160, height: 160, position: { x: 200, y: 260 }, metadata: { content: "/api/assets/a/content" } },
        { id: "b", type: "image", title: "组内B", width: 160, height: 160, position: { x: 200, y: 500 }, metadata: { content: "/api/assets/b/content" } },
        { id: "c", type: "image", title: "组外C", width: 160, height: 160, position: { x: 800, y: 300 }, metadata: { content: "/api/assets/c/content" } },
    ];
    const document = { id, title: "折叠连线", createdAt: now, updatedAt: now, nodes, connections: [{ id: "inside", fromNodeId: "a", toNodeId: "b", kind: "reference" }, { id: "outside", fromNodeId: "a", toNodeId: "c", kind: "reference" }], groups: [{ id: "group", title: "参考组", nodeIds: ["a", "b"], collapsed: true }], viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "dots", showImageInfo: false, chatSessions: [], activeChatId: null };
    api.documents.set(id, { id, revision: 1, deleted: false, document, updatedAt: now });
    await page.goto(`/canvas/${id}`);
    const group = page.locator('[data-canvas-group-id="group"]');
    await expect(group).toBeVisible();
    await expect(page.locator('[data-node-id="a"]')).toHaveCount(0);
    const a = (await group.boundingBox())!, c = (await page.locator('[data-node-id="c"]').boundingBox())!;
    expect(a.width).toBeCloseTo(300, 0);
    await page.mouse.move((a.x + a.width + c.x) / 2, (a.y + a.height / 2 + c.y + c.height / 2) / 2);
    await expect(page.getByRole("button", { name: "删除连线", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "删除连线", exact: true }).click();
    await expect.poll(() => api.document(id)?.connections.map((edge: any) => edge.id)).toEqual(["inside"]);
    await page.keyboard.press("Control+z");
    await expect.poll(() => api.document(id)?.connections.length).toBe(2);
    await page.getByRole("button", { name: "画布缩放与视图", exact: true }).click();
    await page.getByRole("spinbutton", { name: "画布缩放百分比", exact: true }).fill("25");
    await page.getByRole("spinbutton", { name: "画布缩放百分比", exact: true }).press("Enter");
    await expect.poll(async () => Math.round((await group.boundingBox())!.width)).toBe(300);
    expect(api.document(id)?.nodes).toEqual(nodes);
    expect(api.submissions).toHaveLength(0);
    await page.screenshot({ path: info.outputPath("collapsed-group-25.png") });
});

test("点选改款图仅显示缩略图，操作对比滑条才读取历史原图且不修改节点", async ({ page, api }) => {
    const id = "root-lazy-inline-compare", now = new Date().toISOString();
    const before = "/api/assets/33333333-3333-4333-8333-333333333333/content";
    const after = "/api/assets/44444444-4444-4444-8444-444444444444/content";
    const nodes = [{ id: "result", type: "image", title: "改款结果", width: 256, height: 256, position: { x: 750, y: 250 }, metadata: { content: after, compareSources: [{ type: "image", content: before, label: "历史原图" }] } }];
    const document = { id, title: "按需对比", createdAt: now, updatedAt: now, nodes, connections: [], groups: [], viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "dots", showImageInfo: false, chatSessions: [], activeChatId: null };
    api.documents.set(id, { id, revision: 1, deleted: false, document, updatedAt: now });
    let originalReads = 0;
    page.on("request", request => { if (new URL(request.url()).pathname === before) originalReads++; });
    await page.goto(`/canvas/${id}`);
    await page.locator('[data-node-id="result"]').click();
    const inline = page.locator('[data-inline-image-compare="result"]');
    await expect(inline).toBeVisible();
    await expect(inline.getByRole("img", { name: "历史原图", exact: true })).toBeVisible();
    expect(originalReads).toBe(0);
    const range = inline.getByRole("slider", { name: "原图与修改后对比", exact: true });
    await range.fill("50");
    await expect(inline.getByRole("img", { name: "对比原图", exact: true })).toBeVisible();
    expect(originalReads).toBe(1);
    await range.fill("25"); await range.fill("75");
    await expect(range).toHaveValue("75");
    expect(originalReads).toBe(1);
    expect(api.document(id)?.nodes).toEqual(nodes);
    expect(api.submissions).toHaveLength(0);
});

test("多图导入一次撤销，选中追加参考不改提示词，Shift取消单项", async ({ page, api }) => {
    const id = await newCanvas(page);
    await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    const prompt = page.getByRole("textbox", { name: "描述图像", exact: true });
    await prompt.fill("保留当前创作草稿");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传素材", exact: true }).click();
    await (await chooser).setFiles(["first.png", "second.png", "third.png"].map(name => ({ name, mimeType: "image/png", buffer: IMAGE })));
    await expect.poll(() => api.document(id)?.nodes.length).toBe(3);
    await expect(page.locator("[data-node-id].is-selected")).toHaveCount(3);
    await expect(prompt).toHaveValue("保留当前创作草稿");
    const ids = api.document(id)!.nodes.map((node: any) => node.id);
    await page.keyboard.press("Escape");
    await page.locator(`[data-node-id="${ids[0]}"]`).click();
    await page.locator(`[data-node-id="${ids[1]}"]`).click({ modifiers: ["Shift"] });
    await expect(page.locator("[data-node-id].is-selected")).toHaveCount(2);
    await page.locator(`[data-node-id="${ids[0]}"]`).click({ modifiers: ["Shift"] });
    await expect(page.locator("[data-node-id].is-selected")).toHaveCount(1);
    await expect(page.locator(`[data-node-id="${ids[1]}"]`)).toHaveClass(/is-selected/);
    await expect(prompt).toHaveValue("保留当前创作草稿");
    await page.keyboard.press("Control+z");
    await expect(page.locator("[data-node-id]")).toHaveCount(0);
    await page.keyboard.press("Control+Shift+z");
    await expect(page.locator("[data-node-id]")).toHaveCount(3);
    expect(api.submissions).toHaveLength(0);
});

test("多选等比缩放可一次撤销，锁定节点不移动或删除", async ({ page, api }, info) => {
    const id = await newCanvas(page);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传素材", exact: true }).click();
    await (await chooser).setFiles(["a.png", "b.png"].map(name => ({ name, mimeType: "image/png", buffer: IMAGE })));
    await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
    await expect(page.getByTestId("canvas-multi-selection")).toBeVisible();
    const original = structuredClone(api.document(id)!.nodes);
    const handle = page.getByRole("button", { name: "缩放选区 bottom-right", exact: true });
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y + 60, { steps: 8 }); await page.mouse.up();
    await expect.poll(() => api.document(id)!.nodes[0].width).toBeGreaterThan(original[0].width + 10);
    expect(api.document(id)!.nodes[0].width / api.document(id)!.nodes[0].height).toBeCloseTo(1);
    await page.keyboard.press("Control+z");
    await expect.poll(() => api.document(id)!.nodes[0].width).toBe(original[0].width);
    await page.keyboard.press("Control+Shift+l");
    await expect(page.locator('[data-node-locked="true"]')).toHaveCount(2);
    const lockedNode = page.locator(`[data-node-id="${original[0].id}"]`);
    await lockedNode.click({ position: { x: 30, y: 40 } });
    await expect(page.locator("[data-node-id].is-selected")).toHaveCount(1);
    await expect(lockedNode).toHaveClass(/is-selected/);
    const lockedBox = (await lockedNode.boundingBox())!;
    await page.mouse.move(lockedBox.x + 30, lockedBox.y + 40); await page.mouse.down();
    await page.mouse.move(lockedBox.x + 130, lockedBox.y + 100, { steps: 8 }); await page.mouse.up();
    await page.keyboard.press("ArrowRight"); await page.keyboard.press("Delete");
    await expect(page.locator("[data-node-id]")).toHaveCount(2);
    expect(api.document(id)!.nodes.map((node: any) => node.position)).toEqual(original.map((node: any) => node.position));
    await page.screenshot({ path: info.outputPath("multi-selection-locked.png") });
    expect(api.submissions).toHaveLength(0);
});

test("放大文字只补足溢出高度，缩小字号和手动大框保持尺寸", async ({ page, api }, info) => {
    const id = "font-size-overflow", now = new Date().toISOString();
    const nodes = [
        { id: "short-text", type: "text", title: "自动补足文字", width: 300, height: 120, position: { x: 500, y: 250 }, metadata: { content: "第一行文字\n第二行文字\n第三行文字", fontSize: 14 } },
        { id: "large-text", type: "text", title: "保留手动尺寸", width: 300, height: 480, position: { x: 1000, y: 250 }, metadata: { content: "第一行文字\n第二行文字\n第三行文字", fontSize: 14 } },
    ];
    const document = { id, title: "文字尺寸回归", createdAt: now, updatedAt: now, nodes, connections: [], groups: [], viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "dots", showImageInfo: false, chatSessions: [], activeChatId: null };
    api.documents.set(id, { id, revision: 1, deleted: false, document, updatedAt: now });
    await page.goto(`/canvas/${id}`);
    const short = page.locator('[data-node-id="short-text"]');
    await short.click({ position: { x: 100, y: 60 } });
    await page.getByRole("combobox", { name: "文字字号", exact: true }).selectOption("32");
    await expect.poll(() => api.document(id)?.nodes[0].height).toBeGreaterThan(120);
    await expect.poll(() => short.locator(".whitespace-pre-wrap").evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
    const grown = api.document(id)!.nodes[0].height;
    expect(api.document(id)!.nodes[0].position).toEqual(nodes[0].position);
    await page.getByRole("combobox", { name: "文字字号", exact: true }).selectOption("14");
    await expect.poll(() => api.document(id)?.nodes[0].metadata.fontSize).toBe(14);
    expect(api.document(id)!.nodes[0].height).toBe(grown);
    await page.locator('[data-node-id="large-text"]').click({ position: { x: 100, y: 60 } });
    await page.getByRole("combobox", { name: "文字字号", exact: true }).selectOption("32");
    await expect.poll(() => api.document(id)?.nodes[1].metadata.fontSize).toBe(32);
    expect(api.document(id)!.nodes[1].height).toBe(480);
    expect(api.document(id)!.nodes[1].position).toEqual(nodes[1].position);
    expect(api.submissions).toHaveLength(0);
    await page.screenshot({ path: info.outputPath("font-size-overflow-retains-user-size.png") });
});
