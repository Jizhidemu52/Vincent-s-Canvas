import { test, expect } from "./fixtures";

test("focused composer repairs pending, ready and invalid chips without changing the draft or source token", async ({ page, api }, info) => {
    await page.route("**/template-placeholder-fixture", route => route.fulfill({ contentType: "text/html", body: `<div id="root"></div>
        <script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script>
        <script type="module" src="/e2e/canvas-template-placeholder-mount.tsx"></script>` }));
    await page.goto("/template-placeholder-fixture");
    const editor = page.getByRole("textbox");
    const chip = editor.locator('[data-reference-node-id="original"]');
    await expect(chip).toHaveText("待上传原图");
    await page.locator("main").screenshot({ path: info.outputPath("template-pending-chip.png") });
    await editor.click();
    await editor.press("Control+End");
    await editor.pressSequentially(" keep this draft");
    await page.getByRole("button", { name: "Receive original", exact: true }).click();
    await expect(editor).toBeFocused();
    await expect(chip).toHaveAttribute("data-reference-state", "image");
    await expect(chip.locator("img")).toBeVisible();
    await expect(page.getByTestId("source-draft")).toHaveText("参考款：@[node:original]\n保留结构 keep this draft");
    await page.getByRole("button", { name: "Delete original", exact: true }).click();
    await expect(editor).toBeFocused();
    await expect(chip).toHaveText("已失效引用 ×");
    await page.getByRole("button", { name: "Restore upload slot", exact: true }).click();
    await expect(editor).toBeFocused();
    await expect(chip).toHaveText("待上传原图");
    await page.getByRole("button", { name: "Switch language", exact: true }).click();
    await expect(chip).toHaveText("Original image pending");
    await expect(chip).toHaveAttribute("title", "Set the reference style's original image first");
    await expect(page.getByTestId("source-draft")).toHaveText("参考款：@[node:original]\n保留结构 keep this draft");
    await page.getByRole("button", { name: "Delete original", exact: true }).click();
    await expect(chip).toHaveText("Unavailable reference ×");
    await chip.click();
    await expect(chip).toHaveCount(0);
    await expect(page.getByTestId("source-draft")).toHaveText("参考款：\n保留结构 keep this draft");
    expect(api.submissions).toEqual([]);
    expect(api.batchSubmissions).toEqual([]);
});
