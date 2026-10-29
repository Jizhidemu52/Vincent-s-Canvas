import { expect, test } from "bun:test";
import { prepareCanvasImageFormat, validateImageBlob } from "@/lib/canvas/canvas-image-encoding";

const png = new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABAQMAAADO7O3JAAAAA1BMVEX/AAAZ4gk3AAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==", "base64")], { type: "image/png" });
const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });

test("original download retains exact bytes and follows the detected encoding rather than stale MIME", async () => {
    const mismatched = new Blob([png], { type: "image/jpeg" });
    const result = await prepareCanvasImageFormat(mismatched, "original", async () => { throw new Error("must not convert"); });
    expect(result.blob).toBe(mismatched);
    expect(result.mimeType).toBe("image/png");
    const converted = await prepareCanvasImageFormat(mismatched, "png", async () => { throw new Error("must not convert"); });
    expect(converted.blob.type).toBe("image/png");
    expect(await converted.blob.arrayBuffer()).toEqual(await mismatched.arrayBuffer());
});

test("PNG preserves existing PNG pixels without re-encoding while JPG performs a real conversion", async () => {
    const calls: string[] = [];
    const encode = async (input: Blob, target: string) => { expect(input).toBe(png); calls.push(target); return jpeg; };
    expect((await prepareCanvasImageFormat(png, "png", encode)).blob).toBe(png);
    expect((await prepareCanvasImageFormat(png, "jpg", encode)).blob).toBe(jpeg);
    expect(calls).toEqual(["image/jpeg"]);
});

test("conversion failure and wrong returned bytes cannot create a falsely labelled JPG", async () => {
    await expect(prepareCanvasImageFormat(png, "jpg", async () => new Blob([png], { type: "image/jpeg" }))).rejects.toThrow("未生成所选图片格式");
    await expect(prepareCanvasImageFormat(png, "jpg", async () => { throw new Error("decode failed"); })).rejects.toThrow("decode failed");
    await expect(prepareCanvasImageFormat(new Blob(), "png")).rejects.toThrow("图片内容为空");
    await expect(validateImageBlob(new Blob(['{"error":"denied"}'], { type: "image/png" }))).rejects.toThrow("不是图片");
});

test("cancelled original and converted exports never return a downloadable result", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(prepareCanvasImageFormat(png, "original", undefined, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    const active = new AbortController();
    await expect(prepareCanvasImageFormat(png, "jpg", async () => { active.abort(); return jpeg; }, { signal: active.signal })).rejects.toMatchObject({ name: "AbortError" });
});
