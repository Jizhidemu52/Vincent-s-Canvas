import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, IMAGE } from "./fixtures";
import { chooseAntSelect } from "./antd-select-helpers";
import { toolDefinitions } from "../../shared/feature-catalog";

const translations: Record<string, string> = {
    "隔离回归账号": "Isolated test account",
    "私有中文网页标题": "Original Chinese webpage title",
    "候选毛衫图片": "Candidate knitwear image",
    "中文毛衫原图.png": "Original knitwear image.png",
    "读取局部说明需要核对": "Check the partially read description",
    "独立中文色库": "Independent color library",
    "测试暖红色": "Test warm red",
    "独立中文色库 · 测试暖红色": "Independent color library · Test warm red",
    "测试毛衫参考.png": "Test knitwear reference.png",
    "中文标注层.png": "Original markup layer.png",
};
async function displayFixture(context: BrowserContext, sources: string[]) {
    await context.route("**/api/display-translations", route => {
        const body = route.request().postDataJSON() as { texts: string[]; target: string };
        expect(body.target).toBe("en-US"); sources.push(...body.texts);
        return route.fulfill({ json: { translations: body.texts.map(text => translations[text] ?? `Translated fixture: ${text.replace(/[\u3400-\u9fff]/g, "")}`) } });
    });
}
async function language(page: Page, locale: "en" | "zh-CN") {
    await page.getByTestId("language-switch").filter({ visible: true }).first().click();
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
}
/** Read only the isolated browser's native persisted values; never inject app stores. */
async function persistedState(page: Page) {
    return page.evaluate(async () => {
        const records: string[] = [], blobs: string[] = [];
        for (const entry of await indexedDB.databases()) {
            if (!entry.name?.startsWith("wireless-canvas")) continue;
            const database = await new Promise<IDBDatabase>((resolve, reject) => {
                const request = indexedDB.open(entry.name!);
                request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
            });
            for (const name of database.objectStoreNames) {
                const values = await new Promise<unknown[]>((resolve, reject) => {
                    const request = database.transaction(name, "readonly").objectStore(name).getAll();
                    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
                });
                for (const value of values) {
                    if (value instanceof Blob) {
                        const hash = await crypto.subtle.digest("SHA-256", await value.arrayBuffer());
                        blobs.push(Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join(""));
                    } else records.push(JSON.stringify(value));
                }
            }
            database.close();
        }
        return { text: records.join("\n"), blobs };
    });
}

test("reference import translates human labels while original scan IDs, upload metadata and PNG bytes stay unchanged", async ({ page, context, api }, info) => {
    const sources: string[] = [], reads: unknown[] = [];
    await displayFixture(context, sources);
    await context.route("**/api/reference-import/*", route => {
        const scan = route.request().url().endsWith("/scan");
        if (!scan) reads.push(route.request().postDataJSON());
        return route.fulfill({ json: { code: 0, msg: "", data: scan ? {
            scanId: "private-scan-identity", pageUrl: "https://example.com/gallery", pageTitle: "私有中文网页标题", expiresAt: new Date(Date.now() + 300_000).toISOString(), warnings: ["读取局部说明需要核对"],
            candidates: [{ id: "private-candidate-identity", name: "候选毛衫图片", sourceImage: "https://example.com/original.png" }],
        } : { id: "private-candidate-identity", name: "中文毛衫原图.png", mime: "image/png", base64: IMAGE.toString("base64"), sourcePage: "https://example.com/gallery", sourceImage: "https://example.com/original.png", pageTitle: "私有中文网页标题" } } });
    });
    await page.goto("/reference-import");
    const input = page.getByLabel("公开网页链接", { exact: true });
    await input.fill("https://example.com/gallery");
    await page.getByTestId("reference-scan").click();
    const choices = page.getByRole("region", { name: "网页候选图片", exact: true });
    await expect(choices.getByRole("checkbox", { name: "1. 候选毛衫图片", exact: true })).toBeChecked();
    await language(page, "en");
    await expect(page.getByRole("checkbox", { name: "1. Candidate knitwear image", exact: true })).toBeChecked();
    await expect(page.getByText("Original Chinese webpage title", { exact: true })).toBeVisible();
    await expect(page.getByText("Check the partially read description", { exact: true })).toBeVisible();
    await expect(page.getByText(/Isolated test account/)).toBeVisible();
    expect(reads).toEqual([]); expect(api.assets.size).toBe(0);
    const region = page.locator("section").filter({ has: page.getByRole("checkbox", { name: "1. Candidate knitwear image", exact: true }) });
    await region.locator("button").last().click();
    const card = page.getByTestId("reference-draft");
    await expect(card).toContainText("Original knitwear image.png");
    await expect(card.locator("img")).toHaveAttribute("alt", "Original knitwear image.png");
    expect(reads).toEqual([expect.objectContaining({ imageId: "private-candidate-identity", scanId: "private-scan-identity" })]);
    await page.screenshot({ path: info.outputPath("reference-import-English.png"), fullPage: true });
    await language(page, "zh-CN");
    await expect(card).toContainText("中文毛衫原图.png");
    await expect(card.locator("img")).toHaveAttribute("alt", "中文毛衫原图.png");
    await expect(page.getByRole("status").filter({ hasText: "私有中文网页标题" })).toContainText("已读取 1 张，请审核后确认导入");
    await expect(page.getByLabel("公开网页链接", { exact: true })).toHaveValue("https://example.com/gallery");
    await page.getByTestId("reference-confirm").click();
    await expect(page.getByText("已成功 1 张", { exact: true })).toBeVisible();
    const asset = [...api.assets.values()][0];
    expect(asset).toMatchObject({ filename: "中文毛衫原图.png", metadata: { title: "中文毛衫原图.png", originalFileName: "中文毛衫原图.png", sourcePageTitle: "私有中文网页标题", sourcePageUrl: "https://example.com/gallery", sourceImageUrl: "https://example.com/original.png" } });
    expect(api.assetBytes.get(asset.id)).toEqual(IMAGE);
    expect(sources).not.toContain("private-candidate-identity");
    expect(sources).not.toContain("https://example.com/gallery");
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("scene color labels and reference names switch languages without changing HEX, source identity or original upload", async ({ page, context, api }, info) => {
    const sources: string[] = []; await displayFixture(context, sources);
    const raw = Buffer.from(JSON.stringify([[77, "测试暖红色", "AA2233", 0, [0, 1], ""]]));
    const zipped = gzipSync(raw), hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    const chunk = { id: "chunk0", path: `chunks/colors-000-${hash(zipped).slice(0, 12)}.json.gz`, count: 1, bytes: zipped.length, rawBytes: raw.length, sha256: hash(zipped), rawSha256: hash(raw) };
    await context.route("**/color-library/**", route => route.request().url().endsWith("manifest.json") ? route.fulfill({ json: {
        schemaVersion: 1, version: "original-color-dataset", format: "tuple-gzip-v1", total: 1, source: "测试原始色库", sourceUrlPrefix: "https://example.com/color/",
        libraries: ["PANTONE TCX", "独立中文色库"].map(name => ({ name, count: 1, chunks: ["chunk0"] })), chunks: [chunk],
    } }) : route.fulfill({ body: zipped, contentType: "application/octet-stream" }));
    await page.goto("/creative/garment-colorway");
    await page.getByLabel("上传服装参考图", { exact: true }).setInputFiles({ name: "测试毛衫参考.png", mimeType: "image/png", buffer: IMAGE });
    await expect(page.locator(".cs-upload-file")).toContainText("测试毛衫参考.png");
    await page.getByRole("radio", { name: "指定颜色", exact: true }).check();
    await page.getByRole("button", { name: "从标准色库选择颜色 1", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "测试暖红色 #AA2233", exact: true })).toBeVisible();
    await dialog.locator(".sc-footer button").first().click();
    await language(page, "en");
    await page.locator(".cs-color-library").first().click();
    await expect(dialog.getByRole("button", { name: "Test warm red #AA2233", exact: true })).toBeVisible();
    await chooseAntSelect(dialog.getByRole("combobox").first(), "Independent color library（1）");
    await dialog.getByRole("button", { name: "Test warm red #AA2233", exact: true }).click();
    await expect(dialog.locator(".sc-selection")).toContainText("Independent color library");
    await expect(dialog.locator(".sc-selection")).toContainText("#AA2233");
    await expect(dialog.getByRole("button", { name: "Apply to Color 1", exact: true })).toBeEnabled();
    await expect(dialog).not.toContainText(/[\u3400-\u9fff]/);
    await page.screenshot({ path: info.outputPath("standard-color-English.png") });
    await dialog.locator(".sc-footer button").last().click();
    await expect(page.locator(".cs-color-source")).toContainText("Independent color library · Test warm red");
    await expect(page.locator(".cs-upload-file")).toContainText("Test knitwear reference.png");
    await expect(page.locator(".cs-upload-preview")).toHaveAttribute("alt", "Test knitwear reference.png");
    await expect(page.locator(".cs-color-input").first()).toHaveValue("#AA2233");
    await language(page, "zh-CN");
    await expect(page.locator(".cs-color-source")).toContainText("独立中文色库 · 测试暖红色");
    await expect(page.locator(".cs-upload-file")).toContainText("测试毛衫参考.png");
    await expect(page.locator(".cs-color-input").first()).toHaveValue("#AA2233");
    await page.reload();
    await expect(page.locator(".cs-color-source")).toContainText("独立中文色库 · 测试暖红色");
    await expect(page.locator(".cs-color-input").first()).toHaveValue("#AA2233");
    const stored = await persistedState(page);
    expect(stored.text).toContain("测试毛衫参考.png"); expect(stored.text).toContain("独立中文色库");
    expect(stored.text).not.toContain("Test knitwear reference.png"); expect(stored.text).not.toContain("Independent color library");
    expect(stored.blobs).toContain(hash(IMAGE));
    expect(sources).not.toContain("qtc-77"); expect(sources).not.toContain("#AA2233");
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("image settings translates visible markup and validation without altering the original PNG or saved settings", async ({ page, context, api }, info) => {
    const sources: string[] = []; await displayFixture(context, sources);
    await context.route("**/api/models", route => route.fulfill({ json: { models: [{
        id: "10000000-0000-4000-8000-000000000001", modelId: "gpt-image-2.6-flare", name: "aplmart-gpt2.6-flare", publicName: "aplmart-gpt2.6-flare", imageParameterProfile: "quality-resolution-v2", capabilities: ["generate", "edit", "upscale"], creditCost: 0, rmbCost: 0,
    }], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: null, configurationVersion: 1 })) } }));
    await page.goto("/image");
    const pane = page.getByRole("tabpanel");
    await pane.locator("input[type=file][accept='image/*']").setInputFiles({ name: "测试毛衫参考.png", mimeType: "image/png", buffer: IMAGE });
    await pane.getByRole("button", { name: "切换生成图片模型", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("summary", { hasText: "高级参数" }).click();
    const markup = dialog.locator("[data-image-field=markup_reference]");
    await markup.locator("input[type=file]").setInputFiles({ name: "中文标注层.png", mimeType: "image/png", buffer: IMAGE });
    await expect(markup).toContainText("中文标注层.png");
    await dialog.locator("summary", { hasText: "高级参数" }).click();
    await dialog.locator("[data-igsd-complete]").click();
    await language(page, "en");
    await pane.getByRole("button", { name: "Switch image generation model", exact: true }).click();
    await expect(markup).not.toBeVisible();
    expect(sources).not.toContain("中文标注层.png");
    await dialog.locator("summary", { hasText: "Advanced parameters" }).click();
    await expect(markup).toContainText("Original markup layer.png");
    await markup.locator("input[type=file]").setInputFiles({ name: "bad.png", mimeType: "image/png", buffer: Buffer.from("not a PNG") });
    await expect(markup.getByRole("alert")).not.toHaveText(/[\u3400-\u9fff]/);
    await expect(markup.getByRole("alert")).not.toBeEmpty();
    await dialog.locator("summary", { hasText: "Custom dimensions" }).click();
    const width = dialog.locator("details").filter({ has: page.locator("summary", { hasText: "Custom dimensions" }) }).locator("input[type=number]").first();
    await width.fill("1537"); await width.press("Tab");
    await expect(dialog.locator("p[role=alert]")).toContainText("multiples of 16");
    await width.fill("1536"); await width.press("Tab");
    await expect(dialog.locator("p[role=alert]")).toHaveCount(0);
    await expect(dialog).not.toContainText(/[\u3400-\u9fff]/);
    await markup.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("image-settings-English.png") });
    await dialog.locator("[data-igsd-complete]").click();
    await language(page, "zh-CN");
    await pane.getByRole("button", { name: "切换生成图片模型", exact: true }).click();
    await dialog.locator("summary", { hasText: "高级参数" }).click();
    await expect(markup).toContainText("中文标注层.png");
    const stored = await persistedState(page);
    expect(stored.text).toContain("中文标注层.png"); expect(stored.text).toContain("测试毛衫参考.png");
    expect(stored.text).not.toContain("Original markup layer.png"); expect(stored.text).not.toContain("Test knitwear reference.png");
    expect(stored.text).toContain("1536x1024");
    expect(stored.blobs).toEqual(expect.arrayContaining([createHash("sha256").update(IMAGE).digest("hex")]));
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});
