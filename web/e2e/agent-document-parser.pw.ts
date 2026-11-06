import { test, expect } from "@playwright/test";
import { PDFDocument, rgb } from "pdf-lib";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { wordDocumentFixture } from "../tests/fixtures/agent-document-fixtures";

test("PDF text and scanned pages both retain visual previews and exact original bytes without remote reads", async ({ page }) => {
    const pdf = await PDFDocument.create();
    pdf.addPage([400, 300]).drawText("KEEP_CABLE_KNIT_731", { x: 20, y: 220, color: rgb(0.1, 0.2, 0.9) });
    const embedded = await pdf.embedPng(readFileSync(new URL("./media/reference.png", import.meta.url)));
    pdf.addPage([400, 300]).drawImage(embedded, { x: 20, y: 20, width: 350, height: 240 });
    const bytes = Buffer.from(await pdf.save());
    const external: string[] = [];
    page.on("request", request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== "127.0.0.1") external.push(request.url()); });
    await page.goto("/e2e/agent-document-parser.fixture.html");
    await page.locator("#document-file").setInputFiles({ name: "款式与扫描.pdf", mimeType: "application/pdf", buffer: bytes });
    await expect(page.locator("#status")).toHaveText("complete");
    const result = await page.evaluate(async () => {
        const document = (window as any).attachment.document;
        const binary = atob(document.source.dataUrl.split(",")[1]);
        const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(binary, value => value.charCodeAt(0)));
        const image = new Image(); image.src = document.figures[1].dataUrl; await image.decode();
        const canvas = window.document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let darkPixels = 0; for (let index = 0; index < pixels.length; index += 4) if (pixels[index] < 220 || pixels[index + 1] < 220 || pixels[index + 2] < 220) darkPixels++;
        return { sections: document.sections, figures: document.figures.map((figure: any) => ({ sectionId: figure.sectionId, id: figure.id, mimeType: figure.mimeType, width: figure.width, height: figure.height })), warnings: document.warnings, sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join(""), darkPixels };
    });
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].text).toContain("KEEP_CABLE_KNIT_731");
    expect(result.sections[1].text).toContain("扫描页");
    expect(result.figures).toHaveLength(2);
    expect(result.sections[1].figureIds).toEqual([result.figures[1].id]);
    expect(result.figures[1].sectionId).toBe(result.sections[1].id);
    expect(result.figures[1].width).toBeGreaterThan(0);
    expect(result.darkPixels).toBeGreaterThan(100);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.warnings.join("\n")).toContain("未执行 OCR");
    expect(external).toEqual([]);
});

test("PDF visual-budget overflow preserves all page sections and explicitly flags unviewed pages", async ({ page }) => {
    const pdf = await PDFDocument.create();
    for (let index = 0; index < 81; index++) pdf.addPage([60, 60]).drawRectangle({ width: 20, height: 20, color: rgb(0.4, 0.1, 0.2) });
    await page.goto("/e2e/agent-document-parser.fixture.html");
    await page.locator("#document-file").setInputFiles({ name: "81页.pdf", mimeType: "application/pdf", buffer: Buffer.from(await pdf.save()) });
    await expect(page.locator("#status")).toHaveText("complete");
    const result = await page.evaluate(() => {
        const document = (window as any).attachment.document;
        return { sections: document.sections.length, figures: document.figures.length, lastFigureIds: document.sections.at(-1).figureIds, warnings: document.warnings };
    });
    expect(result.sections).toBe(81);
    expect(result.figures).toBe(80);
    expect(result.lastFigureIds).toEqual([]);
    expect(result.warnings.join("\n")).toContain("不能视为已完整看过全部图像");
});

test("Word browser parser keeps embedded images in the correct section and never fetches external images", async ({ page }) => {
    const { original, png } = wordDocumentFixture();
    const external: string[] = [];
    page.on("request", request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== "127.0.0.1") external.push(request.url()); });
    await page.goto("/e2e/agent-document-parser.fixture.html");
    await page.locator("#document-file").setInputFiles({ name: "款式.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from(original) });
    await expect(page.locator("#status")).toHaveText("complete");
    const result = await page.evaluate(() => (window as any).attachment.document);
    expect(result.figures).toHaveLength(1);
    expect(result.sections).toHaveLength(2);
    expect(result.figures[0].sectionId).toBe(result.sections[0].id);
    expect(result.sections[0].text).toContain("图示颜色必须保留");
    expect(result.sections[1].text).toContain("不要口袋");
    expect(Buffer.from(result.figures[0].dataUrl.split(",")[1], "base64")).toEqual(Buffer.from(png));
    expect(result.warnings.join("\n")).toMatch(/外部|外链/);
    expect(external).toEqual([]);
});

test("PDF section overflow is rejected explicitly without exposing a partial document", async ({ page }) => {
    const pdf = await PDFDocument.create();
    for (let index = 0; index < 201; index++) pdf.addPage([60, 60]);
    await page.goto("/e2e/agent-document-parser.fixture.html");
    await page.locator("#document-file").setInputFiles({ name: "201页.pdf", mimeType: "application/pdf", buffer: Buffer.from(await pdf.save()) });
    await expect(page.locator("#status")).toContainText("超过 200 页");
    expect(await page.evaluate(() => (window as any).attachment)).toBeUndefined();
});
