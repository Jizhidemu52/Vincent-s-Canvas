import { PDFDocument } from "pdf-lib";
import { cropImageBlob, splitImageBlobs, upscaleImageBlob } from "../src/lib/canvas/canvas-image-data";
import { editorImageBlob } from "../src/lib/canvas/image-editor-document";
import { createCanvasImagePdfExport } from "../src/lib/canvas/canvas-image-pdf";
import { CanvasNodeType } from "../src/types/canvas";

export async function runImageToolsQA() {
    const canvas = document.createElement("canvas"); canvas.width = 80; canvas.height = 40;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#ef2f2f"; context.fillRect(0, 0, 40, 40); context.fillStyle = "#1e40ee"; context.fillRect(40, 0, 40, 40);
    const jpeg = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/jpeg", .96));
    const source = URL.createObjectURL(jpeg);
    try {
        const crop = await cropImageBlob(source, { x: 10 / 80, y: 12 / 40, width: 1 / 80, height: 1 / 40 }, { sourceMimeType: "image/jpeg" });
        const bitmap = await createImageBitmap(crop); const cropSize = [bitmap.width, bitmap.height]; bitmap.close();
        const split = await splitImageBlobs(source, { rows: 2, columns: 2 }, { sourceMimeType: "image/jpeg" });
        const upscale = await upscaleImageBlob(source, { targetLongEdge: 160, algorithm: "high" }, { sourceMimeType: "image/jpeg" });
        const opaqueEdit = await editorImageBlob(canvas, "image/jpeg");
        context.clearRect(1, 1, 1, 1);
        const transparentEdit = await editorImageBlob(canvas, "image/jpeg");
        // Test fixture APP1 (little endian TIFF, Orientation=6), not a production parser.
        const exif = new Uint8Array([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0]);
        const jpegBytes = new Uint8Array(await jpeg.arrayBuffer());
        const rotated = new Blob([jpegBytes.slice(0,2), exif, jpegBytes.slice(2)], { type: "image/jpeg" });
        const rotatedURL = URL.createObjectURL(rotated);
        const node = { id: "exif", type: CanvasNodeType.Image, title: "手机照片", width: 80, height: 40, position: { x: 0, y: 0 }, metadata: { content: rotatedURL, mimeType: "image/jpeg" } };
        try {
            const result = await createCanvasImagePdfExport({ nodes: [node], mode: "merged", setName: "EXIF检查" });
            const pdf = await PDFDocument.load(await result.blob.arrayBuffer());
            const page = pdf.getPage(0).getSize();
            const png = await editorImageBlob(canvas, "image/png");
            const pngURL = URL.createObjectURL(png);
            try {
                const pngResult = await createCanvasImagePdfExport({ nodes: [{ ...node, metadata: { content: pngURL, mimeType: "image/png" } }], mode: "merged", setName: "后台PNG" });
                const pngPdf = await PDFDocument.load(await pngResult.blob.arrayBuffer());
                return { cropSize, cropType: crop.type, splitTypes: split.map(piece => piece.blob.type), upscaleType: upscale.type, opaqueEdit: opaqueEdit.type, transparentEdit: transparentEdit.type, rotatedPDF: page, pngPDF: pngPdf.getPage(0).getSize() };
            } finally { URL.revokeObjectURL(pngURL); }
        } finally { URL.revokeObjectURL(rotatedURL); }
    } finally { URL.revokeObjectURL(source); }
}
