import { test, expect } from "./fixtures";

test("repeat exports and saved-project controls remain fully reachable at 390px without changing export dimensions", async ({ page, api }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/creative/pattern-repeat");
    await expect(page.getByRole("combobox", { name: "本地工程" })).toBeEnabled();
    await page.getByRole("spinbutton", { name: "宽度 / 厘米", exact: true }).fill("12");
    await page.getByRole("spinbutton", { name: "高度 / 厘米", exact: true }).fill("8");
    await page.getByRole("combobox", { name: "输出分辨率 / DPI", exact: true }).selectOption("150");
    await page.getByTestId("repeat-mode-mirror").click();
    const exports = page.locator(".repeat-right .panel-body");
    await expect(exports).toContainText("1418 × 944");
    const exportButton = page.getByTestId("repeat-export-unit");
    await exportButton.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    const normalColors = await exportButton.evaluate(button => ({ background: getComputedStyle(button).backgroundColor, foreground: getComputedStyle(button).color }));
    await exportButton.hover();
    expect(await exportButton.evaluate(button => ({ background: getComputedStyle(button).backgroundColor, foreground: getComputedStyle(button).color }))).toEqual(normalColors);
    const measurements = await exports.evaluate(panel => {
        const rect = panel.getBoundingClientRect();
        return { width: panel.clientWidth, scrollWidth: panel.scrollWidth,
            controls: Array.from(panel.querySelectorAll("button")).filter(button => button.getBoundingClientRect().width > 0).map(button => {
                const control = button.getBoundingClientRect();
                return { text: button.textContent, inside: control.left >= rect.left && control.right <= rect.right + 1,
                    fitsText: button.scrollWidth <= button.clientWidth + 1 };
            }) };
    });
    expect(measurements.scrollWidth).toBeLessThanOrEqual(measurements.width + 1);
    expect(measurements.controls.length).toBeGreaterThanOrEqual(7);
    expect(measurements.controls.every(control => control.inside && control.fitsText), JSON.stringify(measurements)).toBe(true);
    await page.screenshot({ path: info.outputPath("repeat-export-390.png"), fullPage: true });
    const downloadEvent = page.waitForEvent("download");
    await page.getByTestId("repeat-export-unit").click();
    const download = await downloadEvent;
    const stream = await download.createReadStream();
    if (!stream) throw new Error("Missing repeat PNG export");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1418, 944]);
    await page.setViewportSize({ width: 1800, height: 1200 });
    await expect(exports).toContainText("1418 × 944");
    expect(await exports.evaluate(panel => panel.scrollWidth <= panel.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("repeat-export-desktop.png"), fullPage: true });
    expect(api.submissions).toEqual([]);
    expect(api.assetBytes.size).toBe(0);
});
