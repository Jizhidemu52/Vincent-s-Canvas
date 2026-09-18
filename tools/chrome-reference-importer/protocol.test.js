import { expect, test } from "bun:test";
import { canvasOrigin, cleanUrl, readImage, sniffMime } from "./protocol.js";
test("only HTTPS or explicit localhost/private IP permits canvas destination", () => {
    expect(canvasOrigin("http://192.168.1.115:5188/")).toBe("http://192.168.1.115:5188");
    expect(canvasOrigin("https://canvas.example.com")).toBe("https://canvas.example.com");
    expect(() => canvasOrigin("http://public.example.com")).toThrow();
    expect(() => canvasOrigin("https://user:pass@example.com")).toThrow();
    expect(() => canvasOrigin("https://example.com?token=secret")).toThrow();
    expect(() => canvasOrigin("https://example.com/path")).toThrow();
    expect(cleanUrl("https://user:pass@example.com/img?secret=x#secret")).toBe("https://example.com/img");
});
test("streams enforce limits even without a content-length and preserve original bytes", async () => {
    const bytes = new Uint8Array([255, 216, 255, 12]);
    const result = await readImage(new Response(bytes), new AbortController().signal);
    expect(result.bytes).toEqual(bytes); expect(result.mime).toBe("image/jpeg");
    await expect(readImage(new Response(bytes), new AbortController().signal, 3)).rejects.toThrow();
    expect(() => sniffMime(new TextEncoder().encode("<svg/>"))).toThrow();
    const abort = new AbortController(); abort.abort();
    await expect(readImage(new Response(bytes), abort.signal)).rejects.toThrow();
});
