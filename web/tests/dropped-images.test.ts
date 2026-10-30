import { expect, test } from "bun:test";
import { EXTERNAL_IMAGE_UNAVAILABLE, INTERNAL_IMAGE_DRAG, isExternalImageDrag, normalizeDroppedFile, readImageDrop, snapshotImageDrop } from "../src/lib/dropped-images";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
function transfer(files: File[] = [], items: Array<{ kind: string; getAsFile: () => File | null }> = [], values: Record<string, string> = {}, types = files.length || items.length ? ["Files"] : Object.keys(values)) {
    return { files, items, types, getData: (key: string) => values[key] || "" } as unknown as DataTransfer;
}

test("desktop files preserve bytes/order and do not duplicate the items/HTML view", async () => {
    const first = new File([png], "桌面图片.png", { type: "image/png" });
    const second = new File([png], "参考图.png", { type: "image/png" });
    const data = transfer([first, second], [{ kind: "file", getAsFile: () => { throw new Error("Duplicate view"); } }], { "text/html": "ignored" });
    expect(isExternalImageDrag(data)).toBe(true);
    const result = await readImageDrop(snapshotImageDrop(data));
    expect(result.files).toEqual([first, second]);
    expect(result.files[0]).toBe(first);
});

test("Windows/WeCom item-only unnamed images receive MIME without recoding", async () => {
    const file = new File([png], "企业微信图片", { lastModified: 123 });
    const data = transfer([], [{ kind: "file", getAsFile: () => file }]);
    const snapshot = snapshotImageDrop(data);
    // Simulate browser clearing the DataTransfer store after the event.
    Object.assign(data, { items: [], files: [] });
    const result = await readImageDrop(snapshot);
    expect(result.files[0]!.type).toBe("image/png");
    expect(result.files[0]!.name).toBe("企业微信图片");
    expect(result.files[0]!.lastModified).toBe(123);
    expect(new Uint8Array(await result.files[0]!.arrayBuffer())).toEqual(png);
});

test("extension alone never converts a non-image payload into an image", async () => {
    const file = new File(["not an image"], "pretend.png");
    expect(await normalizeDroppedFile(file)).toBe(file);
    await expect(readImageDrop({ files: [file], urls: [], expectedFiles: true })).rejects.toThrow(EXTERNAL_IMAGE_UNAVAILABLE);
});

test("mixed drops explain skipped non-images; canvas can retain original video/audio files", async () => {
    const image = new File([png], "image.png");
    const video = new File(["video bytes"], "clip.mp4", { type: "video/mp4" });
    const snapshot = { files: [image, video], urls: [], expectedFiles: true };
    expect((await readImageDrop(snapshot)).skipped).toBe(1);
    const result = await readImageDrop(snapshot, { allowNonImages: true });
    expect(result.files[1]).toBe(video);
});

test("ordinary text and reference reorder payloads are not external image drops", () => {
    expect(isExternalImageDrag(transfer([], [], { "text/plain": "正常选中文字" }))).toBe(false);
    expect(isExternalImageDrag(transfer([], [], { [INTERNAL_IMAGE_DRAG]: "ref-1", "text/html": "<img src='x'>" }))).toBe(false);
});

test("URI list snapshots deduplicate one native image location", () => {
    expect(snapshotImageDrop(transfer([], [], { "text/uri-list": "# comment\r\nhttps://example.com/a.png\r\nhttps://example.com/a.png" })).urls).toEqual(["https://example.com/a.png"]);
});

test("unavailable native virtual files report an actionable alternative", async () => {
    const data = transfer([], [{ kind: "file", getAsFile: () => null }]);
    await expect(readImageDrop(snapshotImageDrop(data))).rejects.toThrow("企业微信");
});

test("cross-origin image URLs omit credentials/referrer and keep downloaded bytes", async () => {
    let seen: RequestInit | undefined;
    const fetcher = (async (_url: unknown, init: RequestInit) => { seen = init; return new Response(png); }) as typeof fetch;
    const result = await readImageDrop({ files: [], urls: ["https://example.com/picture.png"], expectedFiles: false }, { origin: "http://127.0.0.1:5200", fetcher });
    expect(seen?.credentials).toBe("omit");
    expect(seen?.referrerPolicy).toBe("no-referrer");
    expect(seen?.redirect).toBe("error");
    expect(result.files[0]!.type).toBe("image/png");
    expect(new Uint8Array(await result.files[0]!.arrayBuffer())).toEqual(png);
});

test("drop does not fetch file paths, private remote hosts, script URLs or embedded credentials", async () => {
    let calls = 0;
    const fetcher = (async () => { calls++; return new Response(png); }) as typeof fetch;
    for (const url of ["file:///C:/desktop/image.png", "wxwork://file/image", "javascript:alert(1)", "http://192.168.3.1/x.png", "https://name:secret@example.com/x.png"]) {
        await expect(readImageDrop({ files: [], urls: [url], expectedFiles: false }, { origin: "https://canvas.example.com", fetcher })).rejects.toThrow();
    }
    expect(calls).toBe(0);
});

test("same-origin media retains only same-origin authentication and unknown bytes are refused", async () => {
    let seen: RequestInit | undefined;
    const fetcher = (async (_url: unknown, init: RequestInit) => { seen = init; return new Response("<html>login</html>", { headers: { "content-type": "image/png" } }); }) as typeof fetch;
    await expect(readImageDrop({ files: [], urls: ["https://canvas.example.com/api/assets/1/file"], expectedFiles: false }, { origin: "https://canvas.example.com", fetcher })).rejects.toThrow(EXTERNAL_IMAGE_UNAVAILABLE);
    expect(seen?.credentials).toBe("same-origin");
});

test("oversized remote responses and excessive file counts stop before allocation/import", async () => {
    let calls = 0;
    const fetcher = (async () => { calls++; return new Response(png, { headers: { "content-length": String(21 * 1024 * 1024) } }); }) as typeof fetch;
    await expect(readImageDrop({ files: [], urls: ["https://example.com/picture.png"], expectedFiles: false }, { origin: "https://canvas.example.com", fetcher })).rejects.toThrow("20 MB");
    await expect(readImageDrop({ files: Array.from({ length: 21 }, () => new File([png], "x.png")), urls: [], expectedFiles: true })).rejects.toThrow("20 个");
    expect(calls).toBe(1);
});

test("aborted scope never reaches a URL or imports local files", async () => {
    const controller = new AbortController(); controller.abort();
    let calls = 0;
    await expect(readImageDrop({ files: [], urls: ["https://example.com/picture.png"], expectedFiles: false }, { signal: controller.signal, fetcher: (async () => { calls++; return new Response(png); }) as typeof fetch })).rejects.toThrow();
    expect(calls).toBe(0);
});
