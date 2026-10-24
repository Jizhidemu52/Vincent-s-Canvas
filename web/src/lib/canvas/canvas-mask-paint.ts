type Size = { width: number; height: number };
type Point = { x: number; y: number };

/** Display-only raster. The authoritative mask always retains the source dimensions. */
export function canvasMaskPreviewSize(image: Size) {
    const scale = Math.min(1, 1200 / Math.max(image.width, image.height));
    return { width: Math.max(1, Math.round(image.width * scale)), height: Math.max(1, Math.round(image.height * scale)) };
}

export function canvasMaskBrushPixels(screenPixels: number, source: Size, rect: Size) {
    return screenPixels * source.width / Math.max(1, rect.width);
}

export function canvasMaskPoint(source: Size, rect: Size & { left: number; top: number }, clientX: number, clientY: number): Point {
    return {
        x: Math.max(0, Math.min(source.width, (clientX - rect.left) * source.width / Math.max(1, rect.width))),
        y: Math.max(0, Math.min(source.height, (clientY - rect.top) * source.height / Math.max(1, rect.height))),
    };
}

export function clearMaskCanvas(canvas: HTMLCanvasElement | null) {
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
}

export function drawMaskStroke(context: CanvasRenderingContext2D, from: Point, to: Point, size: number) {
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = size;
    context.strokeStyle = "#000";
    context.fillStyle = "#000";
    context.beginPath();
    if (from.x === to.x && from.y === to.y) {
        context.arc(to.x, to.y, size / 2, 0, Math.PI * 2);
        context.fill();
    } else {
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.stroke();
    }
}

export function renderMaskPreview(mask: HTMLCanvasElement, preview: HTMLCanvasElement | null, withBorder = false) {
    const context = preview?.getContext("2d");
    if (!preview || !context) return;
    const { width, height } = preview;
    context.clearRect(0, 0, width, height);
    context.fillStyle = "rgba(37, 99, 235, .38)";
    context.fillRect(0, 0, width, height);
    context.globalCompositeOperation = "destination-in";
    context.drawImage(mask, 0, 0, width, height);
    context.globalCompositeOperation = "source-over";
    if (!withBorder) return;
    // Read only the bounded display raster once, never full source pixels per stroke.
    const data = context.getImageData(0, 0, width, height).data;
    context.save();
    context.fillStyle = "rgba(255, 255, 255, .72)";
    context.shadowColor = "rgba(0, 0, 0, .24)";
    context.shadowBlur = 1.5;
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
        const alpha = (y * width + x) * 4 + 3;
        if (!data[alpha] || (x + y) % 13 > 8) continue;
        if (!data[alpha - width * 4] || !data[alpha + width * 4] || !data[alpha - 4] || !data[alpha + 4]) context.fillRect(x - 0.5, y - 0.5, 1.5, 1.5);
    }
    context.restore();
}

/** Export original-pixel alpha: any painted pixel is editable, untouched pixels stay opaque. */
export function buildCanvasEditMask(selectionCanvas: HTMLCanvasElement) {
    const selectionContext = selectionCanvas.getContext("2d");
    const canvas = document.createElement("canvas");
    canvas.width = selectionCanvas.width;
    canvas.height = selectionCanvas.height;
    const context = canvas.getContext("2d");
    if (!selectionContext || !context) throw new Error("无法读取蒙版，请重新打开后重试");
    const selection = selectionContext.getImageData(0, 0, canvas.width, canvas.height).data;
    const mask = context.createImageData(canvas.width, canvas.height);
    mask.data.fill(255);
    let painted = false;
    for (let index = 3; index < selection.length; index += 4) if (selection[index] > 0) {
        mask.data[index] = 0;
        painted = true;
    }
    if (!painted) throw new Error("请先涂抹局部区域");
    context.putImageData(mask, 0, 0);
    return canvas.toDataURL("image/png");
}
