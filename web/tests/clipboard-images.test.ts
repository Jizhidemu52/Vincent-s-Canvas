import { expect, test } from "bun:test";
import { pastedImageFiles, readClipboardImages } from "../src/lib/clipboard-images";

function pasteData(files: File[], items: Array<{ kind: string; type: string; getAsFile: () => File | null }> = []) {
    return { files, items } as unknown as DataTransfer;
}

test("paste uses image files once, preserving identity and order without also reading items", () => {
    const first = new File(["first"], "first.png", { type: "image/png" });
    const second = new File(["second"], "second.webp", { type: "image/webp" });
    const text = new File(["text"], "text.txt", { type: "text/plain" });
    const files = pastedImageFiles(pasteData([first, text, second], [{ kind: "file", type: "image/png", getAsFile: () => { throw new Error("duplicate clipboard item"); } }]));
    expect(files).toEqual([first, second]);
    expect(files[0]).toBe(first);
});

test("paste falls back to image items and ignores unavailable files and text-only clipboards", () => {
    const file = new File(["png"], "screenshot.png", { type: "image/png" });
    expect(pastedImageFiles(pasteData([], [
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "image/png", getAsFile: () => file },
        { kind: "file", type: "image/jpeg", getAsFile: () => null },
    ]))).toEqual([file]);
    expect(pastedImageFiles(pasteData([]))).toEqual([]);
    expect(pastedImageFiles(pasteData([new File(["text"], "text.txt", { type: "text/plain" })]))).toEqual([]);
});

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
