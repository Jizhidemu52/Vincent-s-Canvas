import { test, expect } from "./fixtures";

test("restyle starts from the written request, keeps explicit area on reload and allows clearing it", async ({ page, api }, info) => {
    await page.goto("/creative/local-restyle");
    const area = page.getByRole("textbox", { name: "改动部位", exact: true });
    await expect(area).toHaveValue("");
    await page.getByRole("textbox", { name: /要改成什么样/ }).fill("把袖口改成喇叭袖");
    await area.fill("帽缘");
    await expect(area).toHaveValue("帽缘");
    await page.reload();
    await expect(area).toHaveValue("帽缘");
    await area.fill("");
    await expect(area).toHaveValue("");
    await expect(page.getByRole("textbox", { name: /要改成什么样/ })).toHaveValue("把袖口改成喇叭袖");
    expect(api.submissions).toHaveLength(0);
    await area.screenshot({ path: info.outputPath("restyle-area.png") });
});
