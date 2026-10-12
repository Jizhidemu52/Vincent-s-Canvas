import { expect, test } from "bun:test";
import { createCanvasImageOperationRunner } from "@/lib/canvas/canvas-image-operation";
import { readCanvasSystemClipboard } from "@/lib/canvas/canvas-system-clipboard";

function feedback() {
    const state = { busy: false, starts: 0, finishes: 0, errors: [] as unknown[] };
    return { state, callbacks: { start: () => { state.busy = true; state.starts++; }, finish: () => { state.busy = false; state.finishes++; }, error: (error: unknown) => { state.errors.push(error); } } };
}

test("successful operation waits for persistence, suppresses duplicate clicks, and clears busy", async () => {
    const runner = createCanvasImageOperationRunner(); const info = feedback();
    let persist: () => void = () => {}; let published = false;
    const saving = new Promise<void>(resolve => { persist = resolve; });
    const task = runner.run("crop:1", async signal => { await saving; signal.throwIfAborted(); published = true; }, info.callbacks);
    expect(info.state.busy).toBe(true); expect(published).toBe(false);
    expect(await runner.run("crop:1", async () => {}, info.callbacks)).toBe(false);
    expect(info.state.starts).toBe(1);
    persist(); expect(await task).toBe(true);
    expect(published).toBe(true); expect(info.state.busy).toBe(false); expect(info.state.finishes).toBe(1);
});

test("processing/persistence rejection produces error and finally restores busy for a retry", async () => {
    const runner = createCanvasImageOperationRunner(); const info = feedback();
    expect(await runner.run("split:1", async () => { throw new Error("磁盘已满"); }, info.callbacks)).toBe(false);
    expect(info.state.busy).toBe(false); expect(info.state.errors).toHaveLength(1);
    expect(await runner.run("split:1", async () => {}, info.callbacks)).toBe(true);
    expect(info.state.starts).toBe(2); expect(info.state.finishes).toBe(2);
});

test("project cancellation clears busy without error toast or publishing a stale result", async () => {
    const runner = createCanvasImageOperationRunner(); const info = feedback();
    let finish: () => void = () => {}; let published = false;
    const delayed = new Promise<void>(resolve => { finish = resolve; });
    const task = runner.run("upscale:1", async signal => { await delayed; signal.throwIfAborted(); published = true; }, info.callbacks);
    await Promise.resolve(); runner.cancelAll();
    expect(await task).toBe(false); expect(info.state.busy).toBe(false); expect(info.state.errors).toHaveLength(0);
    finish(); await Promise.resolve();
    expect(published).toBe(false); expect(info.state.finishes).toBe(1);
});

test("stalled import is bounded and cannot publish after its timeout", async () => {
    const runner = createCanvasImageOperationRunner(); const info = feedback();
    let finish: () => void = () => {}; let published = false;
    const delayed = new Promise<void>(resolve => { finish = resolve; });
    const task = runner.run("clipboard", async signal => { await delayed; signal.throwIfAborted(); published = true; }, info.callbacks, 5);
    expect(await task).toBe(false);
    expect(info.state.errors[0]).toMatchObject({ name: "TimeoutError" });
    expect(info.state.busy).toBe(false);
    finish(); await Promise.resolve(); expect(published).toBe(false);
});

test("clipboard permission denial is caught, translated, and leaves operation retryable", async () => {
    const runner = createCanvasImageOperationRunner(); const info = feedback();
    let fallbackReads = 0;
    const reader = { read: async () => { throw new DOMException("denied", "NotAllowedError"); }, readText: async () => { fallbackReads++; return ""; } };
    expect(await runner.run("clipboard", async () => { await readCanvasSystemClipboard(reader); }, info.callbacks)).toBe(false);
    expect(String(info.state.errors[0])).toContain("浏览器未允许读取剪切板");
    expect(info.state.busy).toBe(false); expect(fallbackReads).toBe(0);
});

test("image clipboard content remains a Blob and text uses the already-granted item", async () => {
    const blob = new Blob(["source bytes"], { type: "image/png" });
    expect(await readCanvasSystemClipboard({ read: async () => [{ types: ["image/png"], getType: async () => blob }] })).toEqual({ kind: "image", blob, type: "image/png" });
    let extraReads = 0;
    expect(await readCanvasSystemClipboard({ read: async () => [{ types: ["text/plain"], getType: async () => new Blob(["设计说明"]) }], readText: async () => { extraReads++; return ""; } })).toEqual({ kind: "text", text: "设计说明" });
    expect(extraReads).toBe(0);
});

test("text-only clipboard support still works and unsupported/failed item reads reject", async () => {
    expect(await readCanvasSystemClipboard({ readText: async () => "text" })).toEqual({ kind: "text", text: "text" });
    await expect(readCanvasSystemClipboard(undefined)).rejects.toThrow("不支持读取剪切板");
    await expect(readCanvasSystemClipboard({ read: async () => [{ types: ["image/png"], getType: async () => { throw new Error("图片格式损坏"); } }] })).rejects.toThrow("图片格式损坏");
});
