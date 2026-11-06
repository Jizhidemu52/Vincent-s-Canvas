import { readFile } from "node:fs/promises";
import { test, expect, IMAGE } from "./fixtures";

test("manual third then second color creates one task per click and retains both frozen candidates after reload", async ({ page, api }) => {
    await page.goto("/creative/series-recipe");
    await page.getByLabel("上传参考底图（必需）", { exact: true }).setInputFiles({ name: "recipe-reference.png", mimeType: "image/png", buffer: IMAGE });
    await page.getByRole("combobox", { name: "配色数量", exact: true }).selectOption("6");
    await expect(page.getByRole("button", { name: /^编辑第 \d 色/ })).toHaveCount(6);
    await page.getByRole("button", { name: "编辑第 3 色 #b9827b", exact: true }).click();
    await page.getByRole("button", { name: "生成第 3 色 1 张", exact: true }).click();
    await expect(page.locator(".sr-result")).toHaveCount(1);
    await expect(page.locator(".sr-result").getByRole("img")).toBeVisible();
    expect(api.submissions).toHaveLength(1);
    expect(api.submissions[0]).toMatchObject({ toolKey: "series-recipe", promptInput: { fields: { variantIndex: 2, count: 6 } } });
    expect(api.submissions[0].promptInput.fields.palette).toHaveLength(6);
    expect(api.submissions[0].promptInput.fields.palette[2]).toEqual({ name: "陶粉", hex: "#b9827b" });
    expect(api.submissions[0].parameters.n).toBe(1);
    await expect(page.locator(".sr-result")).toContainText("陶粉 · #B9827B");

    await page.getByRole("button", { name: "编辑第 2 色 #cfb799", exact: true }).click();
    await page.getByRole("button", { name: "生成第 2 色 1 张", exact: true }).click();
    await expect(page.locator(".sr-result img")).toHaveCount(2);
    await expect(page.locator(".sr-result").last().getByRole("img")).toBeVisible();
    expect(api.submissions).toHaveLength(2);
    expect(api.submissions[1].promptInput.fields.variantIndex).toBe(1);
    expect(api.submissions[1].parameters.n).toBe(1);
    await expect(page.locator(".sr-result").first()).toContainText("历史候选");
    await page.getByRole("button", { name: "保存项目", exact: true }).click();
    await expect(page.getByText("已保存到当前员工的本地浏览器。", { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("combobox", { name: "配色数量", exact: true })).toHaveValue("6");
    await expect(page.getByRole("button", { name: "编辑第 2 色 #cfb799", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".sr-result img")).toHaveCount(2);
    await expect(page.locator(".sr-result").first()).toContainText("陶粉 · #B9827B");
    await expect(page.locator(".sr-result").last()).toContainText("沙杏 · #CFB799");
    expect(api.submissions).toHaveLength(2);
    expect(api.batchSubmissions).toHaveLength(0);

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出完整项目 JSON", exact: true }).click();
    const exported = JSON.parse(await readFile(await (await download).path(), "utf8"));
    expect(exported.form.count).toBe(6);
    expect(exported.form.palette).toHaveLength(6);
    expect(exported.history[0].branches[0].index).toBe(2);
    expect(exported.run.branches[0].index).toBe(1);
    expect(exported.history[0].branches[0].images[0].dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(exported.run.branches[0].images[0].dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(api.submissions).toHaveLength(2);
});

test("a stopped accepted color remains query-only after reload and pattern positions stay single", async ({ page, api }) => {
    api.taskStatus = "queued";
    await page.goto("/creative/series-recipe");
    await page.getByLabel("上传参考底图（必需）", { exact: true }).setInputFiles({ name: "recipe-reference.png", mimeType: "image/png", buffer: IMAGE });
    await page.getByRole("button", { name: "编辑第 3 色 #b9827b", exact: true }).click();
    await page.getByRole("button", { name: "生成第 3 色 1 张", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    await page.getByRole("button", { name: "停止", exact: true }).click();
    await expect(page.getByRole("button", { name: /查询原任务 \(1\)/ })).toBeEnabled();
    await page.getByRole("button", { name: "编辑第 2 色 #cfb799", exact: true }).click();
    await expect(page.getByRole("button", { name: "生成第 2 色 1 张", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "保存项目", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: /查询原任务 \(1\)/ })).toBeEnabled();
    await expect(page.getByRole("button", { name: "生成第 2 色 1 张", exact: true })).toBeDisabled();
    expect(api.submissions).toHaveLength(1);
    await page.getByRole("combobox", { name: "选择流程", exact: true }).selectOption("pattern");
    await expect(page.getByRole("combobox", { name: "配色数量", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: /^候选 \d 定位$/ })).toHaveCount(1);
    expect(api.submissions).toHaveLength(1);
});
