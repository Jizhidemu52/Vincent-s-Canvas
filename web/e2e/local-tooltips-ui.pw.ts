import type { Locator, Page } from "@playwright/test";
import { test, expect, type MockCanvasApi } from "./fixtures";

const control = (page: Page, key: string) => page.locator(`[data-workbench-tooltip-control="${key}"] .local-workbench-tooltip-trigger`);
const button = (page: Page, key: string) => page.locator(`.local-workbench-host button[data-action="${key}"]`);
const tooltip = (page: Page) => page.locator(".ant-tooltip:visible").getByRole("tooltip");

async function ready(page: Page) {
    await page.goto("/creative/pattern-placement");
    await expect(page.locator('[data-workbench-select-control="project"]').getByRole("combobox")).toBeEnabled();
    await expect(page.locator("[data-workbench-tooltip-control]")).toHaveCount(7);
    await expect(page.locator("[data-workbench-tooltip-control] [title], button[data-workbench-tooltip][title]")).toHaveCount(0);
}
async function exportProject(page: Page) {
    const event = page.waitForEvent("download"); await button(page, "export-json").click();
    const stream = await (await event).createReadStream();
    if (!stream) throw new Error("Missing placement project export");
    const parts: Buffer[] = []; for await (const part of stream) parts.push(Buffer.from(part));
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
}
async function hover(page: Page, target: Locator, text: string) {
    await page.mouse.move(0, 0);
    await expect(tooltip(page)).toHaveCount(0);
    await target.hover();
    // AntD can keep the previous popup visible during its exit animation.
    await expect(tooltip(page)).toHaveText([text]);
}
function mockProjectDisplay(api: MockCanvasApi, initial: any) {
    api.displayTranslationValues.set(initial.base.name, "Blue short-sleeved shirt · sample base");
    api.displayTranslationValues.set(initial.layers[0].name, "Chest flower");
    api.displayTranslationValues.set(`${initial.layers[0].name} 副本`, "Chest flower copy");
    for (const [source, translated] of [
        [`Selected: ${initial.layers[0].name}`, "Selected: Chest flower"],
        [`Selected: ${initial.layers[0].name} (hidden)`, "Selected: Chest flower (hidden)"],
        [`Selected: ${initial.layers[0].name} 副本`, "Selected: Chest flower copy"],
        ["未命名工程", "Untitled project"],
        ["生成 AI 效果图", "Generate AI preview"],
        ["带入定位合成图、服装原图与图案原稿，选择模型后点击开始编辑。此处不自动生成；原图片编辑草稿保留。", "Use the placement composite, original garment image and original motif. Select a model and click Start editing. Nothing is generated automatically here; the original image-editing draft is preserved."],
        ["图案定位 · 菱形放到帽子翻边", "Pattern placement · diamond on the hat cuff"],
        ["输入 · 针织帽底图", "Input · knitted hat base image"],
    ]) api.displayTranslationValues.set(source, translated);
}
async function assertProjectDisplay(page: Page, api: MockCanvasApi, initial: any) {
    await expect(page.locator(".placement-base-name")).toHaveText("Blue short-sleeved shirt · sample base");
    await expect(page.locator(".placement-layer-select").first()).toHaveText("Chest flower");
    for (const source of [initial.base.name, initial.layers[0].name]) {
        const call = api.displayTranslationCalls.find(item => item.input.texts.includes(source));
        expect(call).toMatchObject({ ownerId: "00000000-0000-4000-8000-000000000099", input: { target: "en-US" }, status: 200 });
        expect(call!.response).toEqual({ translations: call!.input.texts.map(text => api.displayTranslationValues.get(text)) });
    }
}

test("all seven local button classes use AntD tooltips, including disabled and bilingual states, without changing artwork", async ({ page, api }, info) => {
    await ready(page);
    const initial = await exportProject(page);
    mockProjectDisplay(api, initial);
    const labels = [
        ["duplicate", "复制选中图层", "Duplicate selected layer"],
        ["up", "已经是最上层", "Already at the top layer"],
        ["down", "已经是最下层", "Already at the bottom layer"],
        ["delete", "删除选中图层", "Delete selected layer"],
        ["undo", "还没有可撤销的操作", "No actions to undo"],
        ["redo", "还没有可重做的操作", "No actions to redo"],
        ["visibility", "隐藏图层", "Hide layer"],
    ];
    for (const key of ["up", "down", "undo", "redo"]) await expect(button(page, key)).toBeDisabled();
    for (const [key, chinese] of labels) await hover(page, control(page, key), chinese);
    expect(await exportProject(page)).toEqual(initial);

    await page.getByTestId("language-switch").filter({ visible: true }).first().click();
    await assertProjectDisplay(page, api, initial);
    for (const [key, , english] of labels) await hover(page, control(page, key), english);
    expect(await page.locator(".placement-layer-actions button > span").evaluateAll(labels => labels.every(label => label.getBoundingClientRect().width <= label.parentElement!.clientWidth))).toBe(true);
    await expect(page.locator("[data-workbench-tooltip-control] [title], button[data-workbench-tooltip][title]")).toHaveCount(0);
    await page.mouse.move(0, 0);
    await expect(tooltip(page)).toHaveCount(0);
    await button(page, "duplicate").focus();
    await expect(button(page, "duplicate")).toBeFocused();
    await expect(tooltip(page)).toHaveText(["Duplicate selected layer"]);
    expect(await exportProject(page)).toEqual(initial);
    await hover(page, control(page, "up"), "Already at the top layer");
    await page.screenshot({ path: info.outputPath("disabled-local-tooltip-en.png"), animations: "disabled" });
    await page.getByTestId("language-switch").filter({ visible: true }).first().click();
    await hover(page, control(page, "duplicate"), "复制选中图层");
    expect(await exportProject(page)).toEqual(initial);
    expect(api.submissions).toHaveLength(0); expect(api.assetBytes.size).toBe(0);
});

test("dynamic visibility and original toolbar actions retain exact project data and clean up tooltips on remount", async ({ page, api }) => {
    await ready(page);
    const initial = await exportProject(page);
    mockProjectDisplay(api, initial);
    await page.locator(".placement-eye").click();
    await expect(page.locator("[data-workbench-tooltip-control]")).toHaveCount(7);
    await hover(page, control(page, "visibility"), "显示图层");
    expect(await exportProject(page)).toEqual({ ...initial, layers: initial.layers.map((layer: any) => ({ ...layer, visible: false })) });
    await page.getByTestId("language-switch").filter({ visible: true }).first().click();
    await assertProjectDisplay(page, api, initial);
    await hover(page, control(page, "visibility"), "Show layer");
    await page.locator(".placement-eye").click();
    await hover(page, control(page, "visibility"), "Hide layer");
    expect(await exportProject(page)).toEqual(initial);

    await button(page, "duplicate").click();
    await expect(page.locator("[data-workbench-tooltip-control]")).toHaveCount(8);
    const duplicated = await exportProject(page);
    expect(duplicated.layers).toHaveLength(2);
    expect(duplicated.layers[0]).toEqual(initial.layers[0]);
    expect(duplicated.layers[1]).toEqual({ ...initial.layers[0], id: duplicated.layers[1].id, name: `${initial.layers[0].name} 副本`, x: initial.layers[0].x + 25, y: initial.layers[0].y + 25 });
    await button(page, "down").click();
    expect((await exportProject(page)).layers).toEqual([...duplicated.layers].reverse());
    await button(page, "up").click();
    expect(await exportProject(page)).toEqual(duplicated);
    await button(page, "delete").click();
    expect(await exportProject(page)).toEqual(initial);
    await button(page, "undo").click();
    expect(await exportProject(page)).toEqual(duplicated);
    await button(page, "redo").click();
    expect(await exportProject(page)).toEqual(initial);
    await expect(page.locator("[data-workbench-tooltip-control]")).toHaveCount(7);
    await expect(page.locator("[data-workbench-tooltip-control] [title], button[data-workbench-tooltip][title]")).toHaveCount(0);

    await expect(page.locator("[data-project-status]")).toHaveText("Autosaved locally");
    await hover(page, control(page, "visibility"), "Hide layer");
    await page.locator('.local-workbench-heading a[href="/creative"]').click();
    await page.locator('a[href="/creative/pattern-repeat"]').click();
    await expect(page.locator(".repeat-workspace")).toBeVisible();
    await expect(page.locator("[data-workbench-tooltip-control]")).toHaveCount(0);
    await expect(tooltip(page)).toHaveCount(0);
    await page.locator('.local-workbench-heading a[href="/creative"]').click();
    await page.locator('a[href="/creative/pattern-placement"]').click();
    await expect(page.locator("[data-workbench-tooltip-control]")).toHaveCount(7);
    await hover(page, control(page, "visibility"), "Hide layer");
    expect(await exportProject(page)).toEqual(initial);
    expect(api.submissions).toHaveLength(0); expect(api.assetBytes.size).toBe(0);
});
