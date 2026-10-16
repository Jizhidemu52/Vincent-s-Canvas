export type ImageCropRect = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type ImageAngleTransform = {
    horizontalAngle: number;
    pitchAngle: number;
    cameraDistance: number;
    wideAngle: boolean;
};

export type ImageUpscaleAlgorithm = "nearest" | "bilinear" | "high";

export const MAX_UPSCALE_LONG_EDGE = 4096;

export type ImageUpscaleParams = {
    targetLongEdge: number;
    algorithm: ImageUpscaleAlgorithm;
};

export type ImageSplitParams = {
    rows: number;
    columns: number;
};

export type ImageSplitPiece = {
    row: number;
    column: number;
    dataUrl: string;
};

export type ImageToolOptions = { signal?: AbortSignal; timeoutMs?: number };
export type ImageSplitBlobPiece = { row: number; column: number; blob: Blob };
export const IMAGE_TOOL_TIMEOUT_MS = 15_000;

export async function cropDataUrl(dataUrl: string, crop?: ImageCropRect, options?: ImageToolOptions) {
    return canvasToDataUrl(await cropCanvas(dataUrl, crop, options));
}

/** Keep edited pixels binary through persistence instead of PNG → base64 → Blob. */
export async function cropImageBlob(dataUrl: string, crop?: ImageCropRect, options?: ImageToolOptions) {
    return canvasToBlob(await cropCanvas(dataUrl, crop, options), options);
}

async function cropCanvas(dataUrl: string, crop?: ImageCropRect, options?: ImageToolOptions) {
    const image = await loadImage(dataUrl, options);
    options?.signal?.throwIfAborted();
    if (crop) {
        return drawCropCanvas(image, Math.floor(crop.x * image.width), Math.floor(crop.y * image.height), Math.ceil(crop.width * image.width), Math.ceil(crop.height * image.height));
    }
    const size = Math.min(image.width, image.height);
    const sx = Math.max(0, Math.floor((image.width - size) / 2));
    const sy = Math.max(0, Math.floor((image.height - size) / 2));
    return drawCropCanvas(image, sx, sy, size, size);
}

export async function splitDataUrl(dataUrl: string, params: ImageSplitParams, options?: ImageToolOptions): Promise<ImageSplitPiece[]> {
    const pieces: ImageSplitPiece[] = [];
    for await (const piece of splitCanvases(dataUrl, params, options)) {
        pieces.push({ row: piece.row, column: piece.column, dataUrl: canvasToDataUrl(piece.canvas) });
    }
    return pieces;
}

export async function splitImageBlobs(dataUrl: string, params: ImageSplitParams, options?: ImageToolOptions): Promise<ImageSplitBlobPiece[]> {
    const pieces: ImageSplitBlobPiece[] = [];
    for await (const piece of splitCanvases(dataUrl, params, options)) {
        // Encoding each piece asynchronously yields to input/paint and bounds canvas memory.
        pieces.push({ row: piece.row, column: piece.column, blob: await canvasToBlob(piece.canvas, options) });
    }
    return pieces;
}

async function* splitCanvases(dataUrl: string, params: ImageSplitParams, options?: ImageToolOptions) {
    const image = await loadImage(dataUrl, options);
    if (!Number.isFinite(params.rows) || !Number.isFinite(params.columns)) throw new Error("切分行列数无效");
    const rows = Math.max(1, Math.floor(params.rows));
    const columns = Math.max(1, Math.floor(params.columns));
    if (rows > image.height || columns > image.width) throw new Error("切分行列数不能超过原图像素尺寸，请减少行数或列数");

    for (let row = 0; row < rows; row += 1) {
        const sy = Math.floor((row * image.height) / rows);
        const sh = Math.floor(((row + 1) * image.height) / rows) - sy;
        for (let column = 0; column < columns; column += 1) {
            options?.signal?.throwIfAborted();
            const sx = Math.floor((column * image.width) / columns);
            const sw = Math.floor(((column + 1) * image.width) / columns) - sx;
            yield { row, column, canvas: drawCropCanvas(image, sx, sy, sw, sh) };
        }
    }
}

export async function transformAngleDataUrl(dataUrl: string, params: ImageAngleTransform, options?: ImageToolOptions) {
    const image = await loadImage(dataUrl, options);
    const canvas = document.createElement("canvas");
    const padding = Math.round(Math.max(image.width, image.height) * 0.18);
    canvas.width = image.width + padding * 2;
    canvas.height = image.height + padding * 2;
    const context = requireContext(canvas);
    context.clearRect(0, 0, canvas.width, canvas.height);

    const horizontal = params.horizontalAngle / 60;
    const pitch = params.pitchAngle / 45;
    const distanceScale = 1.12 - params.cameraDistance * 0.035;
    const wideScale = params.wideAngle ? 0.88 : 1;
    const scale = Math.max(0.64, Math.min(1.1, distanceScale * wideScale));
    const width = image.width * scale * (1 - Math.abs(horizontal) * 0.28);
    const height = image.height * scale * (1 - Math.abs(pitch) * 0.18);
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const skewX = horizontal * image.width * 0.18;
    const skewY = pitch * image.height * 0.12;
    const x = cx - width / 2 + horizontal * padding * 0.5;
    const y = cy - height / 2 + pitch * padding * 0.45;

    context.save();
    context.setTransform(1, pitch * 0.08, horizontal * -0.1, 1, 0, 0);
    context.drawImage(image, x + skewX, y + skewY, width, height);
    context.restore();

    if (params.wideAngle) {
        const gradient = context.createRadialGradient(cx, cy, Math.min(canvas.width, canvas.height) * 0.2, cx, cy, Math.max(canvas.width, canvas.height) * 0.62);
        gradient.addColorStop(0, "rgba(255,255,255,0)");
        gradient.addColorStop(1, "rgba(0,0,0,0.18)");
        context.fillStyle = gradient;
        context.fillRect(0, 0, canvas.width, canvas.height);
    }

    return canvasToDataUrl(canvas);
}

export async function upscaleDataUrl(dataUrl: string, params: ImageUpscaleParams, options?: ImageToolOptions) {
    return canvasToDataUrl(await upscaleCanvas(dataUrl, params, options));
}

export async function upscaleImageBlob(dataUrl: string, params: ImageUpscaleParams, options?: ImageToolOptions) {
    return canvasToBlob(await upscaleCanvas(dataUrl, params, options), options);
}

async function upscaleCanvas(dataUrl: string, params: ImageUpscaleParams, options?: ImageToolOptions) {
    const image = await loadImage(dataUrl, options);
    options?.signal?.throwIfAborted();
    const { width, height } = resolveUpscaleSize(image.width, image.height, params.targetLongEdge);
    return params.algorithm === "high" ? drawStepUpscale(image, width, height) : drawResizeCanvas(image, image.width, image.height, width, height, params.algorithm);
}

export function resolveUpscaleSize(width: number, height: number, targetLongEdge: number) {
    const longEdge = Math.max(1, width, height);
    const target = Math.min(MAX_UPSCALE_LONG_EDGE, Math.max(1, Math.round(targetLongEdge)));
    const scale = target / longEdge;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function drawCropCanvas(image: HTMLImageElement, sx: number, sy: number, sw: number, sh: number) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, sw);
    canvas.height = Math.max(1, sh);
    const context = requireContext(canvas);
    try { context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height); }
    catch (error) { releaseCanvas(canvas); throw error; }
    return canvas;
}

function drawStepUpscale(image: HTMLImageElement, width: number, height: number) {
    let source: CanvasImageSource = image;
    let sourceWidth = image.width;
    let sourceHeight = image.height;

    try {
        while (sourceWidth * 2 < width && sourceHeight * 2 < height) {
            const nextWidth = sourceWidth * 2;
            const nextHeight = sourceHeight * 2;
            const next = drawResizeCanvas(source, sourceWidth, sourceHeight, nextWidth, nextHeight, "high");
            if (source !== image) releaseCanvas(source as HTMLCanvasElement);
            source = next;
            sourceWidth = nextWidth;
            sourceHeight = nextHeight;
        }
        return drawResizeCanvas(source, sourceWidth, sourceHeight, width, height, "high");
    }
    finally { if (source !== image) releaseCanvas(source as HTMLCanvasElement); }
}

function drawResizeCanvas(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number, algorithm: ImageUpscaleAlgorithm) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = requireContext(canvas);
    context.imageSmoothingEnabled = algorithm !== "nearest";
    context.imageSmoothingQuality = algorithm === "bilinear" ? "medium" : "high";
    try { context.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height); }
    catch (error) { releaseCanvas(canvas); throw error; }
    return canvas;
}

function requireContext(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) { releaseCanvas(canvas); throw new Error("无法创建图片处理画布，请重试"); }
    return context;
}

function releaseCanvas(canvas: HTMLCanvasElement) {
    canvas.width = 0;
    canvas.height = 0;
}

function canvasToDataUrl(canvas: HTMLCanvasElement) {
    try {
        const result = canvas.toDataURL("image/png");
        if (result === "data:,") throw new Error("图片编码失败，请重试");
        return result;
    } finally { releaseCanvas(canvas); }
}

function canvasToBlob(canvas: HTMLCanvasElement, options: ImageToolOptions = {}) {
    return new Promise<Blob>((resolve, reject) => {
        let settled = false;
        const finish = (blob?: Blob | null, error?: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", abort);
            releaseCanvas(canvas);
            if (error) reject(error);
            else if (!blob || !blob.size) reject(new Error("图片编码失败，请重试"));
            else resolve(blob);
        };
        const abort = () => finish(null, options.signal?.reason || new DOMException("图片处理已取消", "AbortError"));
        const timer = setTimeout(() => finish(null, new Error("图片编码超时，请重试")), options.timeoutMs ?? IMAGE_TOOL_TIMEOUT_MS);
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) { abort(); return; }
        try { canvas.toBlob(blob => finish(blob), "image/png"); }
        catch (error) { finish(null, error); }
    });
}

function loadImage(dataUrl: string, options: ImageToolOptions = {}) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        let settled = false;
        const finish = (error?: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            image.onload = null;
            image.onerror = null;
            options.signal?.removeEventListener("abort", abort);
            if (error) { image.src = ""; reject(error); }
            else resolve(image);
        };
        const abort = () => finish(options.signal?.reason || new DOMException("图片处理已取消", "AbortError"));
        const timer = setTimeout(() => finish(new Error("图片读取超时，请重新添加原图后重试")), options.timeoutMs ?? IMAGE_TOOL_TIMEOUT_MS);
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) { abort(); return; }
        image.onload = () => finish(image.width > 0 && image.height > 0 ? undefined : new Error("图片尺寸无效，请重新添加原图"));
        image.onerror = () => finish(new Error("无法读取图片，文件可能已损坏或失效，请重新添加原图"));
        try { image.src = dataUrl; }
        catch (error) { finish(error); }
    });
}
