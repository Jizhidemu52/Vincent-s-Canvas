import { compositeSelectedPixels, recolorPixels, selectionHasPixels, type PixelImage, type RecolorRule } from "./image-processing";

export type ImageProcessingTask =
    | { kind: "recolor"; image: PixelImage; rules: readonly RecolorRule[]; tolerance: number }
    | { kind: "selection-guide"; image: PixelImage }
    | { kind: "composite"; original: PixelImage; generated: PixelImage; selection: PixelImage };
export type RecolorResult = ReturnType<typeof recolorPixels>;
export type SelectionImageTask =
    | { kind: "selection-guide-image"; source: ImageBitmap; selection: ImageBitmap }
    | { kind: "composite-image"; source: ImageBitmap; generated: ImageBitmap; selection: ImageBitmap };
export type SelectionUrlTask =
    | { kind: "selection-guide-url"; source: string; selection: string }
    | { kind: "composite-url"; source: string; generated: string; selection: string };
export type ImageWorkerTask = ImageProcessingTask | SelectionImageTask | SelectionUrlTask;

export function executeImageProcessingTask(task: ImageProcessingTask): PixelImage | RecolorResult {
    if (task.kind === "recolor") return recolorPixels(task.image, task.rules, task.tolerance);
    if (task.kind === "composite") return compositeSelectedPixels(task.original, task.generated, task.selection);
    if (!selectionHasPixels(task.image)) throw new Error("选区为空，请先涂选修改区域");
    const data = new Uint8ClampedArray(task.image.data);
    for (let offset = 0; offset < data.length; offset += 4) {
        data[offset] = 42; data[offset + 1] = 119; data[offset + 2] = 246;
        data[offset + 3] = Math.round(data[offset + 3]! * .55);
    }
    return { width: task.image.width, height: task.image.height, data };
}
