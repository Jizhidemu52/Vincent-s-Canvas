import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { test, expect, type MockCanvasApi } from "./fixtures";
import { canvasExampleNodePrefix, type CanvasExampleLessonId } from "../src/lib/canvas/canvas-example-lessons";
import { parseCanvasClipboard } from "../src/lib/canvas/canvas-system-clipboard";
import type { CanvasNodeData } from "../src/types/canvas";
import { canvasArrangeOptions } from "../src/lib/canvas/canvas-node-arrange-options";

const assets = resolve(import.meta.dirname, "../public/design-examples/canvas-practice");
const captureAssets = process.env.CAPTURE_CANVAS_PRACTICE_ASSETS === "1";
async function seed(page: Page, api: MockCanvasApi, lesson: CanvasExampleLessonId, prepare?: (nodes: CanvasNodeData[]) => CanvasNodeData[]) {
    await page.goto("/canvas");
    const graph = await page.evaluate(async () => (await import("/src/lib/canvas/canvas-example-graph.ts")).createCanvasExampleGraph());
    const selected = graph.nodes.filter(node => node.id.startsWith(canvasExampleNodePrefix(lesson, "practice")));
    const nodes = prepare ? prepare(selected) : selected;
    const left = Math.min(...nodes.map(node => node.position.x)), top = Math.min(...nodes.map(node => node.position.y));
    for (const node of nodes) node.position = { x: node.position.x - left + 180, y: node.position.y - top + 140 };
    const ids = new Set(nodes.map(node => node.id));
    const id = `practice-capture-${lesson}`, now = new Date().toISOString();
    const document = { id, title: "操作案例 · 本地实操", createdAt: now, updatedAt: now, nodes, connections: graph.connections.filter(edge => ids.has(edge.fromNodeId) && ids.has(edge.toNodeId)), groups: graph.groups.filter(group => group.nodeIds.every(id => ids.has(id))), viewport: { x: 0, y: 0, k: .7 }, backgroundMode: "dots", showImageInfo: false, chatSessions: [], activeChatId: null };
    api.documents.set(id, { id, revision: 1, deleted: false, document, updatedAt: now });
    await page.goto(`/canvas/${id}`);
    await expect(page.locator("[data-node-id]")).toHaveCount(nodes.length);
    await page.keyboard.press("Shift+1");
    await page.mouse.move(20, 140);
    for (const image of await page.locator("[data-node-id] img").all()) await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    return { id, nodes };
}
async function snapshot(page: Page, info: TestInfo, key: string, publish = true) {
    await page.mouse.move(20, 140);
    await page.screenshot({ path: info.outputPath(`${key}.png`), animations: "disabled" });
    if (captureAssets && publish) {
        await mkdir(assets, { recursive: true });
        await page.screenshot({ path: resolve(assets, `${key}.jpg`), type: "jpeg", quality: 88, animations: "disabled" });
    }
}
const zeroGenerations = (api: MockCanvasApi) => { expect(api.submissions).toHaveLength(0); expect(api.batchSubmissions).toHaveLength(0); };

test("实操素材：选中与聚焦帽图", async ({ page, api }, info) => {
    const { nodes } = await seed(page, api, "view");
    const image = nodes.find(node => node.type === "image")!;
    await page.locator(`[data-node-id="${image.id}"]`).click({ position: { x: 90, y: 60 } });
    await page.keyboard.press("Shift+2");
    await expect(page.locator(`[data-node-id="${image.id}"] [data-canvas-image-frame]`)).toHaveAttribute("data-canvas-image-frame", "selected");
    await snapshot(page, info, "view"); zeroGenerations(api);
});

test("实操素材：编辑包款说明并保留图文节点", async ({ page, api }, info) => {
    const { id, nodes } = await seed(page, api, "nodes");
    const note = nodes.find(node => node.title.startsWith("包款要求"))!;
    const node = page.locator(`[data-node-id="${note.id}"]`);
    await node.dblclick();
    await node.locator("textarea").fill("包身改麂皮\n肩带皮革不变\n保留全部五金与连接位置");
    await node.locator("textarea").press("Escape");
    await expect.poll(() => api.document(id)?.nodes.find((item: any) => item.id === note.id)?.metadata.content).toContain("肩带皮革不变");
    await snapshot(page, info, "nodes"); zeroGenerations(api);
});

test("实操素材：双图角色提示词与合并参考草稿", async ({ page, api }, info) => {
    const { id, nodes } = await seed(page, api, "config");
    const config = nodes.find(node => node.type === "config")!;
    const panel = page.locator(`[data-node-id="${config.id}"]`);
    await panel.getByRole("textbox", { name: "提示词", exact: true }).fill("图1是毛衫款式，图2只参考围巾的深蓝色。毛衫仅改海军蓝，版型、领口、袖长和针织纹理保持不变，不带入围巾格纹。");
    await panel.locator(".ant-segmented-item-label").filter({ hasText: /^合并参考 · 1 个任务$/ }).click();
    await expect.poll(() => api.document(id)?.nodes.find((item: any) => item.id === config.id)?.metadata.composerContent).toContain("不带入围巾格纹");
    await snapshot(page, info, "config"); zeroGenerations(api);
});

test("实操素材：两步马甲工作流草稿", async ({ page, api }, info) => {
    const { id, nodes } = await seed(page, api, "connections");
    expect(nodes.filter(node => node.type === "config")).toHaveLength(2);
    expect(api.document(id)?.connections.some((edge: any) => edge.kind === "config-sequence")).toBe(true);
    await expect(page.getByRole("button", { name: "运行工作流", exact: true }).first()).toBeVisible();
    await snapshot(page, info, "connections"); zeroGenerations(api);
});

test("实操素材：三图切到逐图执行并显示任务数", async ({ page, api }, info) => {
    const { nodes } = await seed(page, api, "batch");
    const panel = page.locator(`[data-node-id="${nodes.find(node => node.type === "config")!.id}"]`);
    await panel.locator(".ant-segmented-item-label").filter({ hasText: /^合并参考 · 1 个任务$/ }).click();
    await panel.locator(".ant-segmented-item-label").filter({ hasText: /^逐图执行 · 3 个任务$/ }).click();
    await expect(panel.getByRole("button", { name: "执行 3 个任务", exact: true })).toBeVisible();
    await snapshot(page, info, "batch"); zeroGenerations(api);
});

test("实操素材：复制Polo原图形成独立副本", async ({ page, api }, info) => {
    const { id, nodes } = await seed(page, api, "versions");
    const image = nodes.find(node => node.type === "image")!;
    await page.locator(`[data-node-id="${image.id}"]`).click({ position: { x: 90, y: 60 } });
    await page.keyboard.press("Control+d");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(nodes.length + 1);
    const copy = api.document(id)!.nodes.find((node: any) => !nodes.some(original => original.id === node.id));
    expect(copy.metadata.content).toBe(image.metadata!.content);
    expect(copy.id).not.toBe(image.id);
    const box = (await page.locator(`[data-node-id="${copy.id}"]`).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 220, box.y + box.height / 2 + 180, { steps: 8 }); await page.mouse.up();
    await snapshot(page, info, "versions"); zeroGenerations(api);
});

test("实操素材：包款副本剪贴板与撤销重做删除恢复", async ({ page, context, api }, info) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const { id, nodes } = await seed(page, api, "nodes");
    const source = nodes.find(node => node.type === "image")!;
    const sourceValue = structuredClone(source);
    const originalIds = new Set(nodes.map(node => node.id));
    const node = (nodeId: string) => page.locator(`[data-node-id="${nodeId}"]`);
    const select = async (nodeId: string) => { await node(nodeId).click({ position: { x: 90, y: 60 } }); };
    const count = async (value: number) => { await expect.poll(() => api.document(id)?.nodes.length).toBe(value); };
    const current = (nodeId: string) => api.document(id)!.nodes.find((item: any) => item.id === nodeId);
    const drag = async (nodeId: string, dx: number, dy: number, alt = false) => {
        await select(nodeId);
        const box = (await node(nodeId).boundingBox())!;
        if (alt) await page.keyboard.down("Alt");
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 }); await page.mouse.up();
        if (alt) await page.keyboard.up("Alt");
    };
    const moveTo = async (nodeId: string, x: number, y: number) => {
        const box = (await node(nodeId).boundingBox())!;
        await drag(nodeId, x - box.x, y - box.y);
    };
    await snapshot(page, info, "copy-history-input", false);

    await select(source.id); await page.keyboard.press("Control+d"); await count(nodes.length + 1);
    const duplicate = api.document(id)!.nodes.find((item: any) => !originalIds.has(item.id));
    expect(duplicate.metadata.content).toBe(source.metadata!.content);
    await drag(duplicate.id, 300, 230);
    await snapshot(page, info, "copy-history-duplicate");

    const beforeAlt = new Set(api.document(id)!.nodes.map((item: any) => item.id));
    await drag(source.id, 600, 230, true); await count(nodes.length + 2);
    const altCopy = api.document(id)!.nodes.find((item: any) => !beforeAlt.has(item.id));
    expect(altCopy.metadata.content).toBe(source.metadata!.content);
    await page.keyboard.press("Shift+1");
    await snapshot(page, info, "copy-history-alt");

    await select(duplicate.id); await page.keyboard.press("Control+c");
    const copied = parseCanvasClipboard(await page.evaluate(() => navigator.clipboard.readText()));
    expect(copied?.nodes.map(item => item.id)).toEqual([duplicate.id]);
    expect(copied?.nodes[0]?.metadata?.content).toBe(source.metadata!.content);
    await count(nodes.length + 2);
    await snapshot(page, info, "copy-history-copy");
    const beforePaste = new Set(api.document(id)!.nodes.map((item: any) => item.id));
    await page.mouse.move(1200, 650);
    await page.keyboard.press("Control+v"); await count(nodes.length + 3);
    const pasted = api.document(id)!.nodes.find((item: any) => !beforePaste.has(item.id));
    expect(pasted.metadata.content).toBe(source.metadata!.content);
    expect(pasted.id).not.toBe(duplicate.id);
    await moveTo(pasted.id, 1050, 560);
    await snapshot(page, info, "copy-history-paste");

    await select(pasted.id); await page.keyboard.press("Control+x"); await count(nodes.length + 2);
    expect(current(pasted.id)).toBeUndefined(); expect(current(source.id)).toBeDefined();
    await snapshot(page, info, "copy-history-cut", false);
    const beforeCutPaste = new Set(api.document(id)!.nodes.map((item: any) => item.id));
    await page.mouse.move(350, 650);
    await page.keyboard.press("Control+v"); await count(nodes.length + 3);
    const cutPasted = api.document(id)!.nodes.find((item: any) => !beforeCutPaste.has(item.id));
    expect(cutPasted.metadata.content).toBe(source.metadata!.content);
    await moveTo(cutPasted.id, 60, 560);
    expect(cutPasted.position).not.toEqual(pasted.position);
    await snapshot(page, info, "copy-history-cut-paste");

    const beforeMove = { ...current(duplicate.id).position };
    await drag(duplicate.id, 0, 70);
    await expect.poll(() => current(duplicate.id).position).not.toEqual(beforeMove);
    const moved = { ...current(duplicate.id).position };
    await page.getByTestId("canvas-top-tool-rail").getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(() => current(duplicate.id).position).toEqual(beforeMove);
    await snapshot(page, info, "copy-history-undo");
    await page.getByTestId("canvas-top-tool-rail").getByRole("button", { name: "重做", exact: true }).click();
    await expect.poll(() => current(duplicate.id).position).toEqual(moved);
    await snapshot(page, info, "copy-history-redo");

    const deletedNode = structuredClone(current(cutPasted.id));
    await select(cutPasted.id); await page.keyboard.press("Delete"); await count(nodes.length + 2);
    expect(current(cutPasted.id)).toBeUndefined();
    await snapshot(page, info, "copy-history-delete");
    await page.keyboard.press("Control+z"); await count(nodes.length + 3);
    expect(current(cutPasted.id)).toEqual(deletedNode);
    await snapshot(page, info, "copy-history-restored", false);
    expect(current(source.id)).toEqual(sourceValue);
    for (const copy of api.document(id)!.nodes.filter((item: any) => !originalIds.has(item.id))) {
        for (const key of ["generationRecord", "generationOrigin", "sourceTaskId", "imageTask"]) expect(copy.metadata).not.toHaveProperty(key);
    }
    zeroGenerations(api);
});

test("实操素材：包图说明建组命名整体移动折叠复制和解组", async ({ page, api }, info) => {
    test.setTimeout(180_000);
    const { id, nodes } = await seed(page, api, "compare", source => {
        const images = source.filter(node => node.type === "image");
        const note = source.find(node => node.title === "比较包款变化")!;
        images[0]!.position = { x: 0, y: 0 }; images[1]!.position = { x: 880, y: 0 };
        note.position = { x: 0, y: 260 }; note.width = 420; note.height = 180;
        note.metadata!.content = "包款 A · 麂皮评审\n保留轮廓、肩带和五金。\n原图与说明一起分组。\n右侧麂皮图独立对照。";
        return [...images, note];
    });
    const members = [nodes.find(node => node.type === "image")!, nodes.find(node => node.title === "比较包款变化")!];
    const saved = () => api.document(id)!;
    const current = (nodeId: string) => saved().nodes.find((item: any) => item.id === nodeId);
    const group = (groupId: string) => page.locator(`[data-canvas-group-id="${groupId}"]`);
    const dragGroup = async (groupId: string, title: string, dx: number, dy: number, alt = false) => {
        const box = (await group(groupId).getByRole("button", { name: `选择款式组 ${title}`, exact: true }).boundingBox())!;
        if (alt) await page.keyboard.down("Alt");
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 }); await page.mouse.up();
        if (alt) await page.keyboard.up("Alt");
    };
    for (const [index, member] of members.entries()) await page.locator(`[data-node-id="${member.id}"]`).click({ position: { x: 80, y: 60 }, modifiers: index ? ["Shift"] : [] });
    await expect(page.getByTestId("canvas-multi-selection")).toContainText("已选 2 项");
    await page.keyboard.press("Control+g");
    const dialog = page.getByRole("dialog", { name: "款式组名称", exact: true });
    await expect(dialog).toBeVisible();
    await expect.poll(() => saved().groups.length).toBe(1);
    const groupId = saved().groups[0].id;
    expect(new Set(saved().groups[0].nodeIds)).toEqual(new Set(members.map(node => node.id)));
    await snapshot(page, info, "group-created");
    await dialog.getByRole("textbox", { name: "款式组名称", exact: true }).fill("包款A_麂皮评审");
    await snapshot(page, info, "group-name-draft");
    await dialog.getByRole("button", { name: "保存名称", exact: true }).click();
    await expect.poll(() => saved().groups[0].title).toBe("包款A_麂皮评审");
    await snapshot(page, info, "group-named");

    await group(groupId).getByRole("button", { name: "选择款式组 包款A_麂皮评审", exact: true }).click();
    await expect(page.getByTestId("canvas-multi-selection")).toContainText("已选 2 项");
    await snapshot(page, info, "group-selected");
    const beforeMove = members.map(node => structuredClone(current(node.id)));
    await dragGroup(groupId, "包款A_麂皮评审", 70, 130);
    await expect.poll(() => current(members[0]!.id).position).not.toEqual(beforeMove[0].position);
    const delta = { x: current(members[0]!.id).position.x - beforeMove[0].position.x, y: current(members[0]!.id).position.y - beforeMove[0].position.y };
    for (const member of beforeMove) {
        expect(current(member.id).position.x - member.position.x).toBeCloseTo(delta.x, 6);
        expect(current(member.id).position.y - member.position.y).toBeCloseTo(delta.y, 6);
        expect(current(member.id).metadata).toEqual(member.metadata);
    }
    await snapshot(page, info, "group-moved");
    await group(groupId).getByRole("button", { name: "重命名款式组 包款A_麂皮评审", exact: true }).click();
    await dialog.getByRole("textbox", { name: "款式组名称", exact: true }).fill("包款A_麂皮评审·已复核");
    await dialog.getByRole("textbox", { name: "款式组名称", exact: true }).press("Enter");
    await expect.poll(() => saved().groups[0].title).toBe("包款A_麂皮评审·已复核");
    const titleText = saved().groups[0].title;
    await snapshot(page, info, "group-renamed");

    const expandedNodes = structuredClone(saved().nodes);
    // Keep the group selected: its selection toolbar must not cover the fold arrow.
    await expect(page.getByTestId("canvas-multi-selection")).toContainText("已选 2 项");
    await group(groupId).getByRole("button", { name: `折叠款式组 ${titleText}`, exact: true }).click();
    await expect(group(groupId)).toHaveAttribute("data-group-collapsed", "true");
    await expect.poll(() => saved().groups[0].collapsed).toBe(true);
    expect(saved().nodes).toEqual(expandedNodes);
    for (const member of members) await expect(page.locator(`[data-node-id="${member.id}"]`)).toBeHidden();
    await snapshot(page, info, "group-collapsed");
    await group(groupId).getByRole("button", { name: `展开款式组 ${titleText}`, exact: true }).click();
    await expect(group(groupId)).toHaveAttribute("data-group-collapsed", "false");
    await expect.poll(() => saved().groups[0].collapsed).toBe(false);
    for (const member of members) await expect(page.locator(`[data-node-id="${member.id}"]`)).toBeVisible();
    await snapshot(page, info, "group-expanded");

    const originalGroup = structuredClone(saved().groups[0]);
    await group(groupId).getByRole("button", { name: `选择款式组 ${titleText}`, exact: true }).click({ button: "right" });
    await expect(page.getByRole("menu", { name: "画布操作", exact: true })).toBeHidden();
    expect(await page.getByRole("menuitem", { name: "复制整组", exact: true }).evaluate(element => document.querySelector("[data-canvas-viewport]")!.contains(element))).toBe(false);
    await page.getByRole("menuitem", { name: "复制整组", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "复制整组", exact: true })).toBeHidden();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect.poll(() => saved().groups.length).toBe(2);
    const copiedGroup = saved().groups.find((item: any) => item.id !== groupId);
    expect(saved().nodes).toHaveLength(nodes.length + members.length);
    expect(copiedGroup.nodeIds.every((nodeId: string) => !nodes.some(node => node.id === nodeId))).toBe(true);
    expect(copiedGroup.nodeIds.map((nodeId: string) => current(nodeId).metadata.content).sort()).toEqual(members.map(node => node.metadata!.content).sort());
    const copiedPosition = { ...current(copiedGroup.nodeIds[0]).position };
    // The default offset overlaps the old image; move the newly selected image,
    // keeping both copied members selected, before capturing the two groups.
    const copiedImage = page.locator(`[data-node-id="${copiedGroup.nodeIds.find((nodeId: string) => current(nodeId).type === "image")}"]`);
    const copyBox = (await copiedImage.boundingBox())!;
    await copiedImage.hover({ position: { x: copyBox.width / 2, y: copyBox.height / 2 } });
    await page.mouse.down(); await page.mouse.move(copyBox.x + copyBox.width / 2 + 520, copyBox.y + copyBox.height / 2 + 160, { steps: 8 }); await page.mouse.up();
    await expect.poll(() => current(copiedGroup.nodeIds[0]).position).not.toEqual(copiedPosition);
    await page.keyboard.press("Shift+1");
    await snapshot(page, info, "group-duplicated");
    const beforeDelete = { groups: structuredClone(saved().groups), nodes: structuredClone(saved().nodes) };
    await group(copiedGroup.id).getByRole("button", { name: `选择款式组 ${copiedGroup.title}`, exact: true }).click({ button: "right" });
    await expect(page.getByRole("menu", { name: "画布操作", exact: true })).toBeHidden();
    await page.getByRole("menuitem", { name: "删除整组", exact: true }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect.poll(() => saved().groups.length).toBe(1);
    expect(saved().nodes).toEqual(expandedNodes);
    expect(saved().groups[0]).toEqual(originalGroup);
    await page.keyboard.press("Shift+1");
    await snapshot(page, info, "group-deleted-copy");
    await page.getByTestId("canvas-top-tool-rail").getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(() => ({ groups: saved().groups, nodes: saved().nodes })).toEqual(beforeDelete);
    await snapshot(page, info, "group-delete-restored", false);
    await page.getByTestId("canvas-top-tool-rail").getByRole("button", { name: "重做", exact: true }).click();
    await expect.poll(() => saved().groups).toEqual([originalGroup]);
    expect(saved().nodes).toEqual(expandedNodes);

    await dragGroup(groupId, titleText, 520, 160, true);
    await expect.poll(() => saved().groups.length).toBe(2);
    const altGroup = saved().groups.find((item: any) => item.id !== groupId);
    expect(saved().nodes).toHaveLength(nodes.length + members.length);
    for (const member of expandedNodes) expect(current(member.id)).toEqual(member);
    expect(altGroup.nodeIds.map((nodeId: string) => current(nodeId).metadata.content).sort()).toEqual(members.map(node => node.metadata!.content).sort());
    await page.keyboard.press("Shift+1");
    await snapshot(page, info, "group-alt-duplicated");
    const beforeUngroup = structuredClone(saved().nodes);
    await group(altGroup.id).getByRole("button", { name: `取消分组 ${altGroup.title}`, exact: true }).click();
    await expect.poll(() => saved().groups.length).toBe(1);
    expect(saved().groups[0]).toEqual(originalGroup);
    expect(saved().nodes).toEqual(beforeUngroup);
    await snapshot(page, info, "group-ungrouped");
    await page.getByRole("button", { name: "移动画布", exact: true }).click();
    await group(groupId).getByRole("button", { name: `选择款式组 ${titleText}`, exact: true }).click({ button: "right" });
    await expect(page.getByRole("menu", { name: "画布操作", exact: true })).toBeHidden();
    await page.getByRole("menuitem", { name: "重命名款式组", exact: true }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "款式组名称", exact: true })).toHaveValue(titleText);
    await snapshot(page, info, "group-hand-menu", false);
    await dialog.getByRole("button", { name: /^取\s*消$/ }).click();
    await expect(dialog).toBeHidden();
    expect(saved().groups).toEqual([originalGroup]); expect(saved().nodes).toEqual(beforeUngroup);
    await page.getByRole("button", { name: "选择 / 框选", exact: true }).click();
    await info.attach("group-operation-state", { contentType: "application/json", body: JSON.stringify({ originalGroup, moveDelta: delta, beforeDelete, afterUngroup: { groups: saved().groups, nodes: saved().nodes }, generationSubmissions: api.submissions.length + api.batchSubmissions.length }) });
    zeroGenerations(api);
});

test("实操素材：四个包款评审单元的六种对齐与五种排列", async ({ page, api }, info) => {
    test.setTimeout(180_000);
    const { id, nodes } = await seed(page, api, "compare", source => {
        const images = source.filter(node => node.type === "image");
        const note = source.find(node => node.title === "比较包款变化")!;
        note.metadata!.content = "包款评审\n\n原图：保留轮廓、肩带和五金。\n麂皮图：作为材质对照。\n同源副本：仅用于排版，非生成。";
        const copy = structuredClone(images[0]!); copy.id += "-local-copy"; copy.title = "原版包款 · 排版用同源副本";
        const prepared = [images[0]!, images[1]!, copy, note];
        const geometry = [[0, 0, 280, 280 * 2 / 3], [480, 90, 340, 340 * 2 / 3], [160, 350, 220, 220 * 2 / 3], [950, 480, 420, 310]];
        prepared.forEach((node, index) => { const [x, y, width, height] = geometry[index]!; node.position = { x: x!, y: y! }; node.width = width!; node.height = height!; });
        return prepared;
    });
    const initial = structuredClone(nodes);
    const outcomes: { mode: string; nodes: CanvasNodeData[] }[] = [];
    const current = () => api.document(id)!.nodes as CanvasNodeData[];
    const sorted = (axis: "x" | "y") => [...current()].sort((a, b) => a.position[axis] - b.position[axis]);
    const aligned = (values: number[]) => expect(Math.max(...values) - Math.min(...values)).toBeLessThan(.001);
    const equalGaps = (axis: "x" | "y") => {
        const items = sorted(axis), dimension = axis === "x" ? "width" : "height";
        const gaps = items.slice(1).map((item, index) => item.position[axis] - items[index]!.position[axis] - items[index]![dimension]);
        aligned(gaps); expect(Math.min(...gaps)).toBeGreaterThanOrEqual(79.99);
    };
    await snapshot(page, info, "arrange-input", false);
    for (const mode of ["horizontal", "vertical", "right", "bottom", "center-x", "center-y", "grid", "row", "column", "distribute-x", "distribute-y"]) {
        await page.keyboard.press("Control+a");
        await expect(page.getByTestId("canvas-multi-selection")).toContainText("已选 4 项");
        await page.getByRole("combobox", { name: "对齐与排列所选节点", exact: true }).click();
        await expect(page.locator(".ant-select-dropdown:visible .ant-select-item-option").first()).toBeVisible();
        const option = page.locator(`.ant-select-dropdown:visible .ant-select-item-option[title="${canvasArrangeOptions.find(option => option.key === mode)!.label}"]`);
        // AntD retains the last selected item's scroll position between opens.
        // Reveal virtualized options above or below it through the real list.
        if (!await option.count()) {
            const optionIndex = canvasArrangeOptions.findIndex(option => option.key === mode);
            await page.locator(".ant-select-dropdown:visible .rc-virtual-list-holder").evaluate((element, index) => {
                element.scrollTop = index === 0 ? 0 : element.scrollHeight;
            }, optionIndex);
        }
        await option.click();
        await expect.poll(() => current().map(node => node.position)).not.toEqual(initial.map(node => node.position));
        const result = current();
        expect(result).toHaveLength(initial.length);
        for (const node of result) {
            const before = initial.find(item => item.id === node.id)!;
            expect({ ...node, position: before.position }).toEqual(before);
        }
        if (mode === "horizontal" || mode === "row") aligned(result.map(node => node.position.y));
        if (mode === "vertical" || mode === "column") aligned(result.map(node => node.position.x));
        if (mode === "right") aligned(result.map(node => node.position.x + node.width));
        if (mode === "bottom") aligned(result.map(node => node.position.y + node.height));
        if (mode === "center-x") aligned(result.map(node => node.position.x + node.width / 2));
        if (mode === "center-y") aligned(result.map(node => node.position.y + node.height / 2));
        if (mode === "grid") { expect(new Set(result.map(node => node.position.x)).size).toBe(2); expect(new Set(result.map(node => node.position.y)).size).toBe(2); }
        if (["row", "distribute-x"].includes(mode)) equalGaps("x");
        if (["column", "distribute-y"].includes(mode)) equalGaps("y");
        if (mode === "distribute-x") expect(result.map(node => node.position.y)).toEqual(initial.map(node => node.position.y));
        if (mode === "distribute-y") expect(result.map(node => node.position.x)).toEqual(initial.map(node => node.position.x));
        // Release AntD's combobox keyboard focus before canvas shortcuts.
        // Its native input correctly owns Shift+1 / Ctrl+Z while focused.
        await page.getByRole("button", { name: "选择 / 框选", exact: true }).click();
        await page.keyboard.press("Shift+1");
        await snapshot(page, info, `arrange-${mode}`);
        outcomes.push({ mode, nodes: structuredClone(result) });
        await page.getByRole("button", { name: "选择 / 框选", exact: true }).click();
        await page.keyboard.press("Control+z");
        await expect.poll(current).toEqual(initial);
        // Undo restores graph geometry, not the viewport used to photograph
        // the previous arrangement. Refit the restored graph for the next UI action.
        await page.keyboard.press("Shift+1");
    }
    await info.attach("arrange-operation-state", { contentType: "application/json", body: JSON.stringify({ initial, outcomes, restored: current(), generationSubmissions: api.submissions.length + api.batchSubmissions.length }) });
    zeroGenerations(api);
});

test("实操素材：准确裁出帽翻边并保留原图", async ({ page, api }, info) => {
    const { id, nodes } = await seed(page, api, "local");
    const image = nodes.find(node => node.type === "image")!;
    await page.locator(`[data-node-id="${image.id}"]`).click({ position: { x: 90, y: 60 } });
    await page.getByRole("button", { name: "更多图片工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "裁剪", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "裁剪图片", exact: true });
    for (const [label, value] of [["裁剪X（像素）", "310"], ["裁剪Y（像素）", "550"], ["裁剪宽度（像素）", "850"], ["裁剪高度（像素）", "350"]]) await dialog.getByLabel(label!, { exact: true }).fill(value!);
    await snapshot(page, info, "local-crop");
    await dialog.getByRole("button", { name: "确认裁剪", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(nodes.length + 1);
    const result = api.document(id)!.nodes.find((node: any) => !nodes.some(original => original.id === node.id));
    expect(result.metadata.naturalWidth).toBe(850); expect(result.metadata.naturalHeight).toBe(350);
    expect(api.document(id)!.nodes.find((node: any) => node.id === image.id).metadata.content).toBe(image.metadata!.content);
    if (captureAssets) {
        const assetId = /\/api\/assets\/([^/]+)\/content/.exec(result.metadata.content)?.[1];
        const bytes = api.assetBytes.get(assetId!);
        expect(bytes).toBeDefined();
        await writeFile(resolve(assets, "hat-crop.png"), bytes!);
    }
    await page.keyboard.press("Shift+1");
    await snapshot(page, info, "local"); zeroGenerations(api);
});

test("实操素材：包款四种对比模式和真实导出", async ({ page, api }, info) => {
    const { nodes } = await seed(page, api, "compare");
    const images = nodes.filter(node => node.type === "image");
    await page.locator(`[data-node-id="${images[1]!.id}"]`).click({ position: { x: 90, y: 60 } });
    await page.getByRole("button", { name: "更多图片工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "高级对比 · 差异图与导出", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "改款前后对比", exact: true });
    await dialog.getByRole("button", { name: "选择改款前图片", exact: true }).click();
    await page.locator(`[data-compare-candidate="${images[0]!.id}"]`).click();
    for (const [mode, name] of [["并排", "compare-side"], ["叠加", "compare-overlay"], ["差异图", "compare-difference"], ["滑块", "compare"]]) {
        await dialog.locator(".ant-segmented-item-label").filter({ hasText: new RegExp(`^${mode}$`) }).click();
        await expect(dialog.getByRole("radio", { name: mode!, exact: true })).toBeChecked();
        await snapshot(page, info, name!);
    }
    const received = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "导出预览 PNG", exact: true }).click();
    const download = await received;
    await download.saveAs(info.outputPath("bag-compare.png"));
    if (captureAssets) await download.saveAs(resolve(assets, "bag-compare.png"));
    zeroGenerations(api);
});

test("实操素材：选中毛衫并填写助手草稿但不发送", async ({ page, context, api }, info) => {
    await context.route("**/api/generation-capabilities*", route => route.fulfill({ json: { models: [] } }));
    const { nodes } = await seed(page, api, "assistant");
    const image = nodes.find(node => node.type === "image")!;
    await page.locator(`[data-node-id="${image.id}"]`).click({ position: { x: 90, y: 60 } });
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const input = page.locator(".cw-agent-panel").getByPlaceholder("理解画布、修改图片或批量编排…");
    await input.fill("只讨论这件毛衫：换成海军蓝时，哪些版型、领口和针织细节需要保留？");
    await expect(input).toHaveValue(/只讨论这件毛衫/);
    await snapshot(page, info, "assistant"); zeroGenerations(api);
});

test("实操素材：下载女装画布备份", async ({ page, api }, info) => {
    await seed(page, api, "delivery");
    await page.getByRole("button", { name: "打开画布菜单", exact: true }).click();
    const received = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "导出画布", exact: true }).click();
    const download = await received;
    expect(download.suggestedFilename()).toMatch(/\.zip$/);
    await download.saveAs(info.outputPath("canvas-backup.zip"));
    await page.getByRole("button", { name: "打开画布菜单", exact: true }).click();
    await snapshot(page, info, "delivery"); zeroGenerations(api);
});
