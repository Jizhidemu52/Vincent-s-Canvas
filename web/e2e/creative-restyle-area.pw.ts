import { test, expect } from "./fixtures";

test("restyle starts from the written request, keeps explicit area on reload and allows clearing it", async ({ page, api }, info) => {
    await page.goto("/creative/local-restyle");
    const area = page.getByRole("group", { name: "改动部位", exact: true });
    await expect(area.getByRole("radio", { name: "按描述判断" })).toBeChecked();
    await page.getByRole("textbox", { name: /要改成什么样/ }).fill("把袖口改成喇叭袖");
    await area.getByRole("radio", { name: "袖子", exact: true }).check();
    await expect(area.getByRole("radio", { name: "袖子" })).toBeChecked();
    await page.reload();
    await expect(area.getByRole("radio", { name: "袖子" })).toBeChecked();
    await area.getByRole("radio", { name: "按描述判断", exact: true }).check();
    await expect(area.getByRole("radio", { name: "领口" })).not.toBeChecked();
    await expect(page.getByRole("textbox", { name: /要改成什么样/ })).toHaveValue("把袖口改成喇叭袖");
    expect(api.submissions).toHaveLength(0);
    await area.screenshot({ path: info.outputPath("restyle-area.png") });
});
