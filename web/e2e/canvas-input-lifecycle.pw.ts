import { test, expect, newCanvas } from "./fixtures";

test("同一图片的左右提示词同步，直接从节点编辑转到左侧生成提交最新输入", async ({ page, api }, info) => {
    const errors: string[] = [];
    page.on("console", event => { if (event.type() === "error") errors.push(event.text()); });
    const id = await newCanvas(page);
    await page.getByRole("button", { name: "更多工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "图片节点", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const nodeId = api.document(id)!.nodes[0].id;
    const node = page.locator(`[data-node-id="${nodeId}"]`);
    const lower = node.locator(".top-full textarea");
    const open = page.getByRole("button", { name: "展开创建面板", exact: true });
    if (await open.isVisible()) await open.click();
    const left = page.locator(".cw-create-panel");
    const editor = left.locator("textarea.cw-prompt");
    await expect(lower).toBeVisible();
    await expect(editor).toBeVisible();

    await editor.fill("A RED knit hat");
    // Focus first, then select and replace as a user does. fill() selects before
    // focus, so the intentional focus-time sync can collapse its stale selection.
    // Do not wait for either 180 ms draft timer.
    await lower.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("B BLUE knit hat");
    await left.locator(".cw-generate-button").click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(api.submissions[0].prompt).toBe("B BLUE knit hat");
    await expect(editor).toHaveValue("B BLUE knit hat");
    await expect.poll(() => api.document(id)?.nodes.find((item: any) => item.id === nodeId)?.metadata.draftPrompt).toBe("B BLUE knit hat");
    expect(errors.filter(error => /Cannot update|Maximum update depth|Rendered .*hooks/.test(error))).toEqual([]);
    expect(api.pageErrors).toEqual([]);
    expect(api.blocked).toEqual([]);
    await page.screenshot({ path: info.outputPath("two-editors-latest-prompt.png") });
});

test("两个真实输入框快速交接与清空不被旧延迟草稿覆盖", async ({ page, api }) => {
    const id = await newCanvas(page);
    await page.getByRole("button", { name: "更多工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "图片节点", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const nodeId = api.document(id)!.nodes[0].id;
    const lower = page.locator(`[data-node-id="${nodeId}"] .top-full textarea`);
    const open = page.getByRole("button", { name: "展开创建面板", exact: true });
    if (await open.isVisible()) await open.click();
    const editor = page.locator(".cw-create-panel textarea.cw-prompt");

    await editor.fill("first left draft");
    await lower.fill("second lower draft");
    await editor.fill("newest left draft");
    await editor.press("Tab");
    await expect.poll(() => api.document(id)?.nodes.find((item: any) => item.id === nodeId)?.metadata.draftPrompt).toBe("newest left draft");
    await expect(lower).toHaveValue("newest left draft");
    await expect(editor).toHaveValue("newest left draft");

    await lower.fill("");
    await editor.click();
    await expect(editor).toHaveValue("");
    await expect.poll(() => api.document(id)?.nodes.find((item: any) => item.id === nodeId)?.metadata.draftPrompt).toBe("");
    await editor.fill("final draft after clear");
    await lower.click();
    await expect(lower).toHaveValue("final draft after clear");
    expect(api.submissions).toHaveLength(0);
    expect(api.pageErrors).toEqual([]);
    expect(api.blocked).toEqual([]);
});
