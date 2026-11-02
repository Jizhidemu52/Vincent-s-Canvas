import { PDFDocument } from "pdf-lib";

export type CanvasPdfPage = { image: Blob; name: string };

/** Runs in the image Worker; never decodes PNG on the UI thread when Workers are available. */
export async function renderCanvasImagePdf(pages: CanvasPdfPage[], title: string, progress?: (completed: number) => void) {
    const pdf = await PDFDocument.create();
    for (const [index, page] of pages.entries()) {
        try {
            const bytes = await page.image.arrayBuffer();
            const signature = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 2));
            const image = signature[0] === 0xff && signature[1] === 0xd8 ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
            if (!image.width || !image.height || image.width * image.height > 40_000_000) throw new Error("单张图片超过 4000 万像素或尺寸无效");
            const scale = Math.min(72 / 96, 14_400 / Math.max(image.width, image.height));
            const width = image.width * scale, height = image.height * scale;
            pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
            await pdf.flush();
            progress?.(index + 1);
        } catch (error) { throw new Error(`第 ${index + 1} 张「${page.name}」：${error instanceof Error ? error.message : "PDF 编码失败"}`); }
    }
    pdf.setTitle(title);
    return new Blob([new Uint8Array(await pdf.save())], { type: "application/pdf" });
}
