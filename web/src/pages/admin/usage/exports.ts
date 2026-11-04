import { saveAs } from "file-saver";
import { excelSafeCell } from "./format";
export type ExportRow = Record<string, string | number | boolean | null>;
export async function exportExcel(rows: ExportRow[], title: string, notes: ExportRow[]) {
    const XLSX = await import("xlsx");
    const safe = (values: ExportRow[]) => values.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [excelSafeCell(key), excelSafeCell(value)])));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(safe(rows)), "当前页明细");
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(safe(notes)), "筛选与口径");
    const bytes = XLSX.write(book, { type: "array", bookType: "xlsx" });
    saveAs(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${title}.xlsx`);
}
function wrap(ctx: CanvasRenderingContext2D, value: string, width: number) {
    const lines: string[] = [];
    let line = "";
    for (const char of value) {
        if (ctx.measureText(line + char).width > width && line) {
            lines.push(line);
            line = char;
        } else line += char;
    }
    if (line) lines.push(line);
    return lines;
}
/** Draw an explicit report: never capture hidden prompts, thumbnails, modals, or private DOM details. */
export async function exportDashboard(root: HTMLElement, format: "png" | "pdf", title: string, scope: string, colors: { background: string; text: string; muted: string }, reportNotes: string[] = []) {
    if (root.querySelector("[data-usage-chart-loading]")) throw new Error("图表仍在加载，请稍后再导出，避免保存不完整看板。");
    const charts = Array.from(root.querySelectorAll<HTMLElement>("[data-usage-chart]"));
    if (charts.some((chart) => !chart.querySelector("canvas"))) throw new Error("部分图表尚未准备好，请稍后再导出。");
    const metrics = Array.from(root.querySelectorAll<HTMLElement>("[data-usage-metric]")).map((element) => element.dataset.usageMetric || "");
    const width = 1440,
        chartHeight = 380;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器无法创建导出画布。");
    ctx.font = "18px Microsoft YaHei, sans-serif";
    const scopeLines = wrap(ctx, scope, width - 80),
        metricLines = metrics.flatMap((value) => wrap(ctx, value, width - 80)),
        noteLines = reportNotes.flatMap((value) => wrap(ctx, value, width - 80));
    const headerHeight = 120 + scopeLines.length * 26 + metricLines.length * 30 + noteLines.length * 24;
    canvas.height = headerHeight + charts.length * (chartHeight + 55) + 100;
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, canvas.height);
    ctx.fillStyle = colors.text;
    ctx.font = "bold 32px Microsoft YaHei, sans-serif";
    ctx.fillText(title, 40, 55);
    ctx.font = "18px Microsoft YaHei, sans-serif";
    ctx.fillStyle = colors.muted;
    scopeLines.forEach((line, index) => ctx.fillText(line, 40, 90 + index * 26));
    let textY = 110 + scopeLines.length * 26;
    ctx.fillStyle = colors.text;
    metricLines.forEach((line) => {
        ctx.fillText(line, 40, textY);
        textY += 30;
    });
    ctx.fillStyle = colors.muted;
    noteLines.forEach((line) => {
        ctx.fillText(line, 40, textY);
        textY += 24;
    });
    let y = headerHeight;
    for (const chart of charts) {
        ctx.fillStyle = colors.text;
        ctx.font = "bold 20px Microsoft YaHei, sans-serif";
        ctx.fillText(chart.dataset.usageChart || "图表", 40, y + 28);
        const layers = chart.querySelectorAll("canvas");
        for (const layer of layers) {
            if (layer.width && layer.height) ctx.drawImage(layer, 40, y + 45, width - 80, chartHeight);
        }
        y += chartHeight + 55;
    }
    ctx.font = "16px Microsoft YaHei, sans-serif";
    ctx.fillStyle = colors.muted;
    ctx.fillText("已记账金额不等于供应商实付；使用信号与正式采纳分开；缺失数据不补零。", 40, y + 35);
    ctx.fillText("仅导出当前指标与图表，不包含原始提示词、私有缩略图或隐藏内容。", 40, y + 62);
    if (format === "png") {
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("图片导出失败。"))), "image/png"));
        saveAs(blob, `${title}.png`);
        return;
    }
    const { PDFDocument } = await import("pdf-lib");
    const pdf = await PDFDocument.create();
    // Slice the rendered report to readable A4 landscape pages, not one extremely tall PDF page.
    const pageWidth = 842,
        pageHeight = 595,
        pixelPageHeight = Math.floor((width * pageHeight) / pageWidth);
    for (let offset = 0; offset < canvas.height; offset += pixelPageHeight) {
        const slice = document.createElement("canvas");
        slice.width = width;
        slice.height = Math.min(pixelPageHeight, canvas.height - offset);
        slice.getContext("2d")!.drawImage(canvas, 0, offset, width, slice.height, 0, 0, width, slice.height);
        const bytes = await (await fetch(slice.toDataURL("image/png"))).arrayBuffer();
        const image = await pdf.embedPng(bytes);
        const page = pdf.addPage([pageWidth, pageHeight]);
        const drawnHeight = (slice.height * pageWidth) / width;
        page.drawImage(image, { x: 0, y: pageHeight - drawnHeight, width: pageWidth, height: drawnHeight });
    }
    saveAs(new Blob([new Uint8Array(await pdf.save())], { type: "application/pdf" }), `${title}.pdf`);
}
