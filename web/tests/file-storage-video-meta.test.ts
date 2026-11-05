import { afterEach, expect, test } from "bun:test";
import { readVideoMeta } from "../src/services/file-storage";

const originalDocument = globalThis.document;
const originalSetTimeout = globalThis.setTimeout;
afterEach(() => { globalThis.document = originalDocument; globalThis.setTimeout = originalSetTimeout; });
function mediaElement(values: { videoWidth: number; videoHeight: number; duration: number }) {
    let removed = false;
    const element = { ...values, onloadedmetadata: null as null | (() => void), onerror: null as null | (() => void), src: "", preload: "", removeAttribute() { removed = true; }, load() {} };
    globalThis.document = { createElement: () => element } as unknown as Document;
    return { element, removed: () => removed };
}

test("unsupported browser decoding yields unknown metadata instead of invented landscape dimensions", async () => {
    const media = mediaElement({ videoWidth: 0, videoHeight: 0, duration: NaN });
    const pending = readVideoMeta("blob:original-hevc");
    media.element.onerror!();
    expect(await pending).toEqual({});
    expect(media.removed()).toBe(true);
    expect(media.element.onerror).toBeNull();
});

test("a readable original retains the actual dimensions and duration", async () => {
    const media = mediaElement({ videoWidth: 1248, videoHeight: 1664, duration: 6.048 });
    const pending = readVideoMeta("blob:original");
    media.element.onloadedmetadata!();
    expect(await pending).toEqual({ width: 1248, height: 1664, durationMs: 6048 });
});

test("a browser that never reports metadata cannot indefinitely block an already generated video", async () => {
    const media = mediaElement({ videoWidth: 0, videoHeight: 0, duration: NaN });
    globalThis.setTimeout = ((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => originalSetTimeout(callback, ms === 8000 ? 1 : ms, ...args)) as typeof setTimeout;
    expect(await readVideoMeta("blob:original-hevc")).toEqual({});
    expect(media.removed()).toBe(true);
});
