import { expect, test } from "bun:test";
import { canvasImageBaseName, canvasImageVersion, canvasImageExportStem, canvasImageReferenceIdentity, canvasImageDownloadFileName, originalReferenceFileName } from "@/lib/canvas/canvas-image-filename";
import { syncCanvasSelectionReferences } from "@/lib/canvas/canvas-selection-references";
import { prepareCanvasImageDownload } from "@/lib/canvas/canvas-export";
import { moveImageReference } from "@/lib/image-reference-policy";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = (name: string): CanvasNodeData => ({ id: name, title: name, type: CanvasNodeType.Image, width: 10, height: 10, position: { x: 0, y: 0 }, metadata: { content: "blob:test", mimeType: "image/png" } });

test("exports retain the original basename with a version and an extension matching the actual image", () => {
    const image = { ...node("款号 001.正面.JPG"), metadata: { mimeType: "image/jpeg" } };
    expect(canvasImageDownloadFileName(image)).toBe("款号 001.正面_v1.JPG");
    expect(canvasImageDownloadFileName({ ...image, title: "新提示词标题", metadata: { ...image.metadata, originalFileName: image.title, mimeType: "image/png", imageVersion: 2 } })).toBe("款号 001.正面_v2.png");
});
test("an edited result inherits the first ordered original reference, including repeated edits", () => {
    const images = [node("款号A.png"), node("款号B.jpg")];
    const references = syncCanvasSelectionReferences([], new Set(images.map((item) => item.id)), new Map(images.map((item) => [item.id, item])));
    expect(originalReferenceFileName(references)).toBe("款号A.png");
    expect(originalReferenceFileName(moveImageReference(references, 1, 0))).toBe("款号B.jpg");
    const edited = { ...images[0]!, title: "AI生成的提示词", metadata: { ...images[0]!.metadata, originalFileName: "款号A.png" } };
    expect(originalReferenceFileName(syncCanvasSelectionReferences([], new Set([edited.id]), new Map([[edited.id, edited]])))).toBe("款号A.png");
});
test("no invented source name for an image generated without a file reference", () => {
    expect(originalReferenceFileName([])).toBeUndefined();
    expect(canvasImageDownloadFileName(node("generated"))).toBe("generated_v1.png");
});

test("renaming changes exports but not the version; unsafe filename characters cannot form paths", () => {
    const image = { ...node("source.png"), metadata: { imageName: "春夏/款号:A", imageVersion: 4, mimeType: "image/png" } };
    expect(canvasImageBaseName(image)).toBe("春夏/款号:A");
    expect(canvasImageExportStem(image)).toBe("春夏_款号_A_v4");
    expect(canvasImageVersion({ ...image, metadata: { imageVersion: -1 } })).toBe(1);
    expect(canvasImageExportStem({ ...image, metadata: { imageName: ".." } })).toBe("图片_v1");
});

test("reference identity survives selection and repeated derived edits", () => {
    const image = { ...node("source.jpg"), metadata: { imageName: "品牌横幅", imageVersion: 3, content: "blob:result", mimeType: "image/png" } };
    const refs = syncCanvasSelectionReferences([], new Set([image.id]), new Map([[image.id, image]]));
    expect(canvasImageReferenceIdentity(refs[0])).toEqual({ imageName: "品牌横幅", imageVersion: 4 });
    expect(canvasImageReferenceIdentity()).toEqual({ imageVersion: 1 });
});
test("downloading an original file keeps its bytes without unnecessary re-encoding", async () => {
    const blob = new Blob(["original"], { type: "image/jpeg" });
    expect(await prepareCanvasImageDownload(blob, "款号.JPG", async () => { throw new Error("must not encode"); })).toBe(blob);
});
test("a generated PNG inherited from a JPG is truly encoded as JPEG and retains the filename", async () => {
    const blob = new Blob(["png"], { type: "image/png" });
    const encoded = new Blob(["jpeg"], { type: "image/jpeg" });
    const calls: string[] = [];
    expect(await prepareCanvasImageDownload(blob, "款号.JPG", async (_source, type) => { calls.push(type); return encoded; })).toBe(encoded);
    expect(calls).toEqual(["image/jpeg"]);
});
test("unsupported encoding never silently saves PNG bytes with a fake extension", async () => {
    const blob = new Blob(["png"], { type: "image/png" });
    await expect(prepareCanvasImageDownload(blob, "款号.gif")).rejects.toThrow("未修改原文件名");
    await expect(prepareCanvasImageDownload(blob, "款号.webp", async () => blob)).rejects.toThrow("未修改原文件名");
});
