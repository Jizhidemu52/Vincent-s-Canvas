import { test, expect, IMAGE } from "./fixtures";
import { activeWorkbench } from "./headless-workbench";

for (const scene of ["garment-colorway", "pattern-colorway"]) test(`${scene} previews, cycles and restores the palette before any generation`, async ({ page, api }, info) => {
    const requests: string[] = [];
    const promptFields: Record<string, unknown>[] = [];
    page.on("request", request => {
        const path = new URL(request.url()).pathname;
        if (!path.startsWith("/api/") || request.method() !== "POST") return;
        requests.push(path);
        if (!request.headers()["content-type"]?.includes("application/json")) return;
        const body = request.postDataJSON();
        if (body?.promptInput?.fields) promptFields.push(body.promptInput.fields);
    });
    await page.goto(`/creative/${scene}`);
    const pane = activeWorkbench(page);
    const change = pane.getByRole("button", { name: "换一组" });
    const preview = change.locator("..").getByRole("status");
    await expect(preview).toHaveText("鼠尾草绿、燕麦色、米白");
    await change.click();
    await expect(preview).toHaveText("雾蓝、沙色、暖灰");
    await pane.getByRole("radio", { name: "沉稳经典" }).check();
    await expect(preview).toHaveText("炭灰、酒红、暖白");
    await page.reload();
    await expect(preview).toHaveText("炭灰、酒红、暖白");
    await expect(pane.getByLabel("设计输入清单").getByText("炭灰、酒红、暖白", { exact: true })).toHaveCount(1);
    expect(requests.filter(path => /prompt|tasks|provider/.test(path))).toEqual([]);
    await change.locator("..").screenshot({ path: info.outputPath("visible-palette.png") });
    await pane.locator('input[type="file"]').first().setInputFiles({ name: "original.png", mimeType: "image/png", buffer: IMAGE });
    await pane.locator("button.cs-generate").click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(promptFields).toContainEqual(expect.objectContaining({ colorMode: "smart", colorMood: "沉稳经典", presetColors: "炭灰、酒红、暖白" }));
});
