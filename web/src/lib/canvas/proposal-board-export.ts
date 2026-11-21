import { renderProposalBoard, type BoardImageLoader } from "./proposal-board-render";
import type { AnyProposalBoard } from "./proposal-board";

function encode(canvas: HTMLCanvasElement, mime: "image/png" | "image/jpeg") {
    return new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("提案板图片编码失败"))), mime, 0.92),
    );
}

export async function exportBoardPng(spec: AnyProposalBoard, load: BoardImageLoader, options: { hd: boolean; signal?: AbortSignal }) {
    const canvas = await renderProposalBoard(spec, load, { scale: options.hd ? 2 : 1, signal: options.signal });
    try {
        const blob = await encode(canvas, "image/png");
        options.signal?.throwIfAborted();
        return blob;
    } finally {
        canvas.width = canvas.height = 0;
    }
}

export async function exportBoardsPdf(
    specs: readonly AnyProposalBoard[],
    load: BoardImageLoader,
    options: { hd: boolean; signal?: AbortSignal },
) {
    if (!specs.length) throw new Error("请选择提案板");
    options.signal?.throwIfAborted();
    const { PDFDocument } = await import("pdf-lib");
    const pdf = await PDFDocument.create();
    for (const spec of specs) {
        const canvas = await renderProposalBoard(spec, load, { scale: options.hd ? 2 : 1, signal: options.signal });
        try {
            const jpeg = await encode(canvas, "image/jpeg");
            options.signal?.throwIfAborted();
            const image = await pdf.embedJpg(await jpeg.arrayBuffer());
            const [width, height] =
                spec.version === 1 && spec.page === "wide-16-9" ? [960, 540] : (spec.version === 2 ? spec.orientation === "portrait" : spec.page === "a4-portrait") ? [595.28, 841.89] : [841.89, 595.28];
            pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
            await pdf.flush();
        } finally {
            canvas.width = canvas.height = 0;
        }
    }
    pdf.setTitle(specs[0].title);
    const bytes = await pdf.save();
    options.signal?.throwIfAborted();
    return new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
}
