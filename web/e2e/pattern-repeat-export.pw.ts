import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

async function exportedPng(page: Page, kind: "unit" | "preview") {
    const downloaded = page.waitForEvent("download");
    await page.getByTestId(`repeat-export-${kind}`).click();
    const download = await downloaded;
    const stream = await download.createReadStream();
    if (!stream) throw new Error("Missing PNG export");
    const parts: Buffer[] = [];
    for await (const part of stream) parts.push(Buffer.from(part));
    const bytes = Buffer.concat(parts);
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    return { src: `data:image/png;base64,${bytes.toString("base64")}`, name: download.suggestedFilename() };
}

// Keep each mode/background pair in its own browser context. A single loop can
// complete 10 downloads in less than a second and hit Chromium's per-frame
// burst limit on the 11th, before Playwright receives a download event.
for (const mode of ["straight", "half", "mirror"] as const) {
    for (const transparent of [false, true]) {
        test(`downloaded ${mode} repeat (transparent=${transparent}) tiles on all four edges like an uninterrupted field`, async ({ page, api }) => {
            await page.goto("/creative/pattern-repeat");
            await expect(page.getByRole("combobox", { name: "本地工程" })).toBeEnabled();
            const src = await page.evaluate(() => {
                const canvas = document.createElement("canvas"); canvas.width = canvas.height = 32;
                const ctx = canvas.getContext("2d")!;
                ctx.fillStyle = "#e86040"; ctx.fillRect(0, 0, 32, 18);
                ctx.fillStyle = "#346b90"; ctx.fillRect(0, 18, 14, 14);
                return canvas.toDataURL("image/png");
            });
            const project = { version: 1, widthCm: 2.54, heightCm: 2.54, dpi: 128, mode, background: "#f6f0df", transparent,
                elements: [
                    { src, name: "Four-edge marker", x: 0, y: 0, size: 0.5, angle: 0 },
                    { src, name: "Asymmetric interior", x: 0.625, y: 0.375, size: 0.25, angle: 90 },
                ] };
            await page.locator('input[data-role="json-file"]').setInputFiles({ name: `${mode}-${transparent}.json`, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(project)) });
            await expect(page.getByText("已导入为新工程，原有工程保留。", { exact: true })).toBeVisible();
            await expect(page.getByTestId(`repeat-mode-${mode}`)).toHaveAttribute("aria-pressed", "true");
            await expect(page.getByTestId("repeat-transparent")).toBeChecked({ checked: transparent });
            const tile = await exportedPng(page, "unit"), preview = await exportedPng(page, "preview");
            const result = await page.evaluate(async ({ tile, preview }) => {
                const load = async (src: string) => { const img = new Image(); img.src = src; await img.decode(); return img; };
                const [unit, field] = await Promise.all([load(tile.src), load(preview.src)]);
                const canvas = document.createElement("canvas"); canvas.width = field.width; canvas.height = field.height;
                const ctx = canvas.getContext("2d")!;
                ctx.fillStyle = ctx.createPattern(unit, "repeat")!; ctx.fillRect(0, 0, canvas.width, canvas.height);
                const tiled = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(field, 0, 0);
                const direct = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                let differences = 0, alphaMin = 255;
                for (let i = 0; i < direct.length; i++) { if (direct[i] !== tiled[i]) differences++; if (i % 4 === 3) alphaMin = Math.min(alphaMin, direct[i]!); }
                return { width: unit.width, height: unit.height, fieldWidth: field.width, fieldHeight: field.height, differences, alphaMin };
            }, { tile, preview });
            expect(result, `${mode}, transparent=${transparent}`).toEqual({ width: mode === "straight" ? 128 : 256, height: mode === "mirror" ? 256 : 128, fieldWidth: 384, fieldHeight: 384, differences: 0, alphaMin: transparent ? 0 : 255 });
            expect(tile.name).toContain("无缝周期");
            expect(api.submissions).toHaveLength(0);
            expect(api.assetBytes.size).toBe(0);
        });
    }
}
