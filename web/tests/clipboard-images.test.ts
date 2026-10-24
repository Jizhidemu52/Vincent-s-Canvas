import { expect, test } from "bun:test";
import { readClipboardImages } from "../src/lib/clipboard-images";

test("image clipboard distinguishes unsupported, denied and empty content", async () => {
    await expect(readClipboardImages(undefined)).rejects.toThrow("不支持");
    await expect(readClipboardImages({})).rejects.toThrow("不支持");
    for (const name of ["NotAllowedError", "SecurityError"]) {
        await expect(readClipboardImages({ read: async () => { throw new DOMException("denied", name); } })).rejects.toThrow("权限");
    }
    await expect(readClipboardImages({ read: async () => [] })).rejects.toThrow("没有图片");
});

test("one clipboard image item with multiple encodings only produces one reference", async () => {
    const calls: string[] = [];
    const files = await readClipboardImages({ read: async () => [
        { types: ["text/plain"], getType: async () => new Blob(["text"]) },
        { types: ["image/png", "image/jpeg"], getType: async type => { calls.push(type); return new Blob(["first"], { type }); } },
        { types: ["image/webp"], getType: async type => { calls.push(type); return new Blob(["second"], { type }); } },
    ] });
    expect(calls).toEqual(["image/png", "image/webp"]);
    expect(await Promise.all(files.map(file => file.text()))).toEqual(["first", "second"]);
});

test("read failures keep their actual cause instead of reporting an empty clipboard", async () => {
    await expect(readClipboardImages({ read: async () => { throw new Error("读取连接中断"); } })).rejects.toThrow("读取连接中断");
});
