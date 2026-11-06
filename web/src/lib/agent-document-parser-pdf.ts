import type { AgentDocumentBuilder } from "./agent-document-parser";
import { AGENT_DOCUMENT_LIMITS } from "../../../shared/image-agent-documents";

/** Sequential rendering bounds decoded page memory; images are previews, never source replacements. */
export async function parsePdfDocument(bytes: Uint8Array, builder: AgentDocumentBuilder) {
    const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    if (typeof window !== "undefined") GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/legacy/build/pdf.worker.mjs?url")).default;
    const loading = getDocument({ data: bytes.slice(), useWorkerFetch: false, enableXfa: false });
    let pdf: Awaited<typeof loading.promise> | undefined;
    try {
        pdf = await loading.promise;
        if (pdf.numPages > AGENT_DOCUMENT_LIMITS.sections) throw new Error(`PDF 超过 ${AGENT_DOCUMENT_LIMITS.sections} 页，请拆分后上传；未仅保存前 ${AGENT_DOCUMENT_LIMITS.sections} 页`);
        for (let index = 1; index <= pdf.numPages; index++) {
            const page = await pdf.getPage(index);
            try {
                const content = await page.getTextContent();
                const text = content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
                const section = builder.section(`第 ${index} 页`, text || "（此页未提取到文字，请查看页面图像；可能是扫描页。）");
                if (!text) builder.warn(`PDF 第 ${index} 页没有文字层，须查看对应页面图像；未执行 OCR。`);
                if (!builder.canAddFigure()) continue;
                if (typeof document === "undefined") {
                    builder.warn("当前运行环境不支持页面画布，PDF 页面预览未生成；文字与原文件仍已保留，扫描页不能仅凭文字理解。");
                    continue;
                }
                const base = page.getViewport({ scale: 1 });
                const viewport = page.getViewport({ scale: Math.min(2, 1440 / Math.max(base.width, base.height)) });
                const canvas = document.createElement("canvas");
                canvas.width = Math.max(1, Math.ceil(viewport.width));
                canvas.height = Math.max(1, Math.ceil(viewport.height));
                try {
                    const context = canvas.getContext("2d");
                    if (!context) throw new Error("页面画布不可用");
                    await page.render({ canvas, canvasContext: context, viewport, background: "#ffffff" }).promise;
                    builder.figure(section, { name: `${builder.document.name}-page-${index}.jpg`, label: `第 ${index} 页页面图`, mimeType: "image/jpeg", dataUrl: canvas.toDataURL("image/jpeg", 0.82), width: canvas.width, height: canvas.height });
                } catch (error) {
                    builder.warn(`PDF 第 ${index} 页预览失败：${error instanceof Error ? error.message : "无法渲染"}；请查阅原文件，不能视为已查看此页图像。`);
                } finally { canvas.width = canvas.height = 0; }
            } finally { page.cleanup(); }
        }
    } finally { try { await pdf?.cleanup(); } finally { await loading.destroy(); } }
}
