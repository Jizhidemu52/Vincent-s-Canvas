import { expect, test } from "bun:test";

import { applyCanvasStreamedTextUpdates, clearCanvasStreamedText } from "@/lib/canvas/canvas-streamed-text-state";

test("updates only changed streamed text entries", () => {
    const current = new Map([["node-a", "old"]]);
    const unchanged = applyCanvasStreamedTextUpdates(current, new Map([["node-a", "old"]]));
    const updated = applyCanvasStreamedTextUpdates(current, new Map([["node-a", "new"], ["node-b", "parallel"]]));

    expect(unchanged).toBe(current);
    expect([...updated.entries()]).toEqual([["node-a", "new"], ["node-b", "parallel"]]);
    expect([...current.entries()]).toEqual([["node-a", "old"]]);
});

test("clears only streamed entries that still exist", () => {
    const current = new Map([["node-a", "draft"], ["node-b", "draft"]]);

    expect(clearCanvasStreamedText(current, ["missing"])).toBe(current);
    expect([...clearCanvasStreamedText(current, ["node-a", "missing"]).entries()]).toEqual([["node-b", "draft"]]);
});
