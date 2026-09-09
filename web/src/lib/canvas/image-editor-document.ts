export type EditorPoint = { x: number; y: number };
export type EditorRect = EditorPoint & { width: number; height: number };
export type EditorSize = { width: number; height: number };
export type EditorResizeMode = "contain" | "cover" | "stretch";
export const EDITOR_MAX_DIMENSION = 8192;
export const EDITOR_MAX_PIXELS = 25_000_000;
type PaintStyle = { color: string; width: number; clip?: EditorRect };
export type ImageEditorMark =
    | ({ kind: "brush"; points: EditorPoint[] } & PaintStyle)
    | ({ kind: "rectangle" | "arrow"; start: EditorPoint; end: EditorPoint } & PaintStyle)
    | ({ kind: "text"; at: EditorPoint; text: string; fontSize: number } & PaintStyle);
export type ImageEditorOperation = ImageEditorMark
    | { kind: "crop"; rect: EditorRect }
    | { kind: "mosaic"; rect: EditorRect; blockSize: number }
    | { kind: "rotate" }
    | { kind: "resize"; width: number; height: number; mode: EditorResizeMode }
    | { kind: "move-rectangle"; index: number; dx: number; dy: number };

export function editorSizeError({ width, height }: EditorSize): string {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return "宽度和高度必须是大于 0 的整数像素";
    if (width > EDITOR_MAX_DIMENSION || height > EDITOR_MAX_DIMENSION) return "宽度和高度均不能超过 8192 像素";
    if (width * height > EDITOR_MAX_PIXELS) return "图片总像素不能超过 2500 万，请减小宽度或高度";
    return "";
}

/** Center the current document on a transparent target canvas; only stretch changes its aspect ratio. */
export function editorResizeGeometry(source: EditorSize, target: EditorSize, mode: EditorResizeMode = "contain") {
    const error = editorSizeError(source) || editorSizeError(target);
    if (error) throw new Error(error);
    let scaleX = target.width / source.width, scaleY = target.height / source.height;
    if (mode !== "stretch") scaleX = scaleY = mode === "cover" ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
    const width = source.width * scaleX, height = source.height * scaleY;
    return { x: (target.width - width) / 2, y: (target.height - height) / 2, width, height, scaleX, scaleY };
}

function positionedOperations(operations: readonly ImageEditorOperation[]) {
    return operations.map((op, index) => {
        if (op.kind !== "rectangle") return op;
        let dx = 0, dy = 0;
        for (const move of operations) if (move.kind === "move-rectangle" && move.index === index) { dx += move.dx; dy += move.dy; }
        return { ...op, start: { x: op.start.x + dx, y: op.start.y + dy }, end: { x: op.end.x + dx, y: op.end.y + dy } };
    });
}

/** Project annotation bounds through subsequent geometry edits for screen-space hit testing. */
export function editorRectangles(operations: readonly ImageEditorOperation[], original: { width: number; height: number }) {
    const positioned = positionedOperations(operations);
    return positioned.flatMap((op, index) => {
        if (op.kind !== "rectangle") return [];
        let start = { ...op.start }, end = { ...op.end };
        let size = editorDocumentSize(original, operations.slice(0, index));
        for (const next of operations.slice(index + 1)) {
            if (next.kind === "crop") {
                start = { x: start.x - next.rect.x, y: start.y - next.rect.y };
                end = { x: end.x - next.rect.x, y: end.y - next.rect.y };
                size = { width: next.rect.width, height: next.rect.height };
            } else if (next.kind === "rotate") {
                start = { x: size.height - start.y, y: start.x };
                end = { x: size.height - end.y, y: end.x };
                size = { width: size.height, height: size.width };
            } else if (next.kind === "resize") {
                const geometry = editorResizeGeometry(size, next, next.mode);
                start = { x: start.x * geometry.scaleX + geometry.x, y: start.y * geometry.scaleY + geometry.y };
                end = { x: end.x * geometry.scaleX + geometry.x, y: end.y * geometry.scaleY + geometry.y };
                size = { width: next.width, height: next.height };
            }
        }
        return [{ index, x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }];
    });
}

export function editorRectangleMove(operations: readonly ImageEditorOperation[], index: number, delta: EditorPoint, original: EditorSize): ImageEditorOperation {
    let { x: dx, y: dy } = delta;
    let size = editorDocumentSize(original, operations.slice(0, index + 1));
    const transforms: ({ kind: "rotate" } | { kind: "resize"; scaleX: number; scaleY: number })[] = [];
    for (const op of operations.slice(index + 1)) {
        if (op.kind === "rotate") {
            transforms.push(op);
            size = { width: size.height, height: size.width };
        } else if (op.kind === "resize") {
            transforms.push({ kind: "resize", ...editorResizeGeometry(size, op, op.mode) });
            size = { width: op.width, height: op.height };
        } else if (op.kind === "crop") size = { width: op.rect.width, height: op.rect.height };
    }
    // Translate the user's current-image drag back into the annotation's original coordinates.
    // Reverse the order as nonuniform scaling and rotation do not commute.
    for (const transform of transforms.reverse()) {
        if (transform.kind === "rotate") [dx, dy] = [dy, -dx];
        else { dx /= transform.scaleX; dy /= transform.scaleY; }
    }
    return { kind: "move-rectangle", index, dx, dy };
}

export function editorPoint(client: EditorPoint, bounds: EditorRect, size: { width: number; height: number }): EditorPoint {
    return {
        x: Math.max(0, Math.min(size.width, (client.x - bounds.x) * size.width / Math.max(1, bounds.width))),
        y: Math.max(0, Math.min(size.height, (client.y - bounds.y) * size.height / Math.max(1, bounds.height))),
    };
}

export function editorRect(start: EditorPoint, end: EditorPoint, size: { width: number; height: number }): EditorRect {
    const x = Math.max(0, Math.min(size.width - 1, Math.floor(Math.min(start.x, end.x))));
    const y = Math.max(0, Math.min(size.height - 1, Math.floor(Math.min(start.y, end.y))));
    return { x, y, width: Math.max(1, Math.min(size.width - x, Math.ceil(Math.max(start.x, end.x)) - x)), height: Math.max(1, Math.min(size.height - y, Math.ceil(Math.max(start.y, end.y)) - y)) };
}

export function editorDocumentSize(original: { width: number; height: number }, operations: readonly ImageEditorOperation[]) {
    let size = { ...original };
    for (const op of operations) {
        if (op.kind === "crop") size = { width: op.rect.width, height: op.rect.height };
        if (op.kind === "rotate") size = { width: size.height, height: size.width };
        if (op.kind === "resize") {
            const error = editorSizeError(op);
            if (error) throw new Error(error);
            size = { width: op.width, height: op.height };
        }
    }
    return size;
}

function context2d(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法创建图片编辑画面");
    return context;
}

export function paintEditorMark(context: CanvasRenderingContext2D, mark: ImageEditorMark) {
    context.save();
    if (mark.clip) {
        context.beginPath();
        context.rect(mark.clip.x, mark.clip.y, mark.clip.width, mark.clip.height);
        context.clip();
    }
    context.strokeStyle = mark.color;
    context.fillStyle = mark.color;
    context.lineWidth = mark.width;
    context.lineCap = "round";
    context.lineJoin = "round";
    if (mark.kind === "brush") {
        const first = mark.points[0];
        if (first) {
            context.beginPath();
            context.moveTo(first.x, first.y);
            for (const point of mark.points.slice(1)) context.lineTo(point.x, point.y);
            if (mark.points.length > 1) context.stroke();
            else { context.arc(first.x, first.y, mark.width / 2, 0, Math.PI * 2); context.fill(); }
        }
    } else if (mark.kind === "text") {
        context.font = `${mark.fontSize}px "Microsoft YaHei", sans-serif`;
        context.textBaseline = "top";
        mark.text.split("\n").forEach((line, index) => context.fillText(line, mark.at.x, mark.at.y + index * mark.fontSize * 1.3));
    } else {
        const { start, end } = mark;
        context.beginPath();
        if (mark.kind === "rectangle") context.rect(start.x, start.y, end.x - start.x, end.y - start.y);
        else { context.moveTo(start.x, start.y); context.lineTo(end.x, end.y); }
        context.stroke();
        if (mark.kind === "arrow") {
            const angle = Math.atan2(end.y - start.y, end.x - start.x);
            const length = Math.max(mark.width * 3, 12);
            context.beginPath();
            context.moveTo(end.x, end.y);
            context.lineTo(end.x - length * Math.cos(angle - Math.PI / 6), end.y - length * Math.sin(angle - Math.PI / 6));
            context.lineTo(end.x - length * Math.cos(angle + Math.PI / 6), end.y - length * Math.sin(angle + Math.PI / 6));
            context.closePath(); context.fill();
        }
    }
    context.restore();
}

/** Replay only on committed edits/undo. Pointer previews never repaint the source image. */
export function renderEditorDocument(canvas: HTMLCanvasElement, image: HTMLImageElement, operations: readonly ImageEditorOperation[]) {
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = context2d(canvas);
    context.drawImage(image, 0, 0);
    for (const op of positionedOperations(operations)) {
        if (op.kind === "move-rectangle") continue;
        if (op.kind === "crop" || op.kind === "rotate" || op.kind === "resize") {
            const geometry = op.kind === "resize" ? editorResizeGeometry(canvas, op, op.mode) : null;
            const copy = document.createElement("canvas");
            copy.width = op.kind === "crop" ? op.rect.width : op.kind === "resize" ? op.width : canvas.height;
            copy.height = op.kind === "crop" ? op.rect.height : op.kind === "resize" ? op.height : canvas.width;
            const target = context2d(copy);
            if (op.kind === "crop") target.drawImage(canvas, op.rect.x, op.rect.y, op.rect.width, op.rect.height, 0, 0, copy.width, copy.height);
            else if (geometry) {
                target.imageSmoothingQuality = "high";
                target.drawImage(canvas, geometry.x, geometry.y, geometry.width, geometry.height);
            }
            else { target.translate(copy.width, 0); target.rotate(Math.PI / 2); target.drawImage(canvas, 0, 0); }
            canvas.width = copy.width; canvas.height = copy.height;
            context.drawImage(copy, 0, 0);
            copy.width = 0; copy.height = 0;
        } else if (op.kind === "mosaic") {
            const small = document.createElement("canvas");
            small.width = Math.max(1, Math.ceil(op.rect.width / op.blockSize));
            small.height = Math.max(1, Math.ceil(op.rect.height / op.blockSize));
            context2d(small).drawImage(canvas, op.rect.x, op.rect.y, op.rect.width, op.rect.height, 0, 0, small.width, small.height);
            context.save(); context.imageSmoothingEnabled = false;
            context.clearRect(op.rect.x, op.rect.y, op.rect.width, op.rect.height);
            context.drawImage(small, op.rect.x, op.rect.y, op.rect.width, op.rect.height);
            context.restore(); small.width = 0; small.height = 0;
        } else paintEditorMark(context, op);
    }
}

export function editorPngBlob(canvas: HTMLCanvasElement) {
    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("图片导出失败，请保留编辑面板后重试")), "image/png");
    });
}
