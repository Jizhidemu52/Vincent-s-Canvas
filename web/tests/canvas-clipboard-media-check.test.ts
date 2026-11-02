import { expect, test } from "bun:test";
import { unavailableCanvasClipboardMedia } from "../src/lib/canvas/canvas-clipboard-media-check";
import type { CanvasNodeData } from "../src/types/canvas";

test("clipboard checks only browser-local references, retains readable keys and never fetches remote bytes", async () => {
    const calls: string[] = [];
    const io = {
        getImageBlob: async (key: string) => { calls.push(`image:${key}`); return key === "local" ? new Blob(["ok"]) : null; },
        getMediaBlob: async (key: string) => { calls.push(`media:${key}`); return null; },
        readMediaSource: async (key: string) => { calls.push(`source:${key}`); return key === "remote-link" ? { assetId: "known", contentUrl: "/api/assets/known/content" } : null; },
    };
    const nodes = [
        { id: "missing", type: "image", metadata: { content: "blob:unavailable", storageKey: "absent" } },
        { id: "local", type: "image", metadata: { storageKey: "local" } },
        { id: "linked", type: "video", metadata: { content: "blob:old", storageKey: "remote-link" } },
        { id: "remote", type: "image", metadata: { content: "/api/assets/protected/content" } },
        { id: "data", type: "image", metadata: { content: "data:image/png;base64,AA" } },
        { id: "empty", type: "image" },
    ] as CanvasNodeData[];
    const before = JSON.stringify(nodes);
    expect(await unavailableCanvasClipboardMedia(nodes, io as any)).toEqual(["missing"]);
    expect(calls.sort()).toEqual(["image:absent", "image:local", "media:remote-link", "source:absent", "source:remote-link"].sort());
    expect(JSON.stringify(nodes)).toBe(before);
});
