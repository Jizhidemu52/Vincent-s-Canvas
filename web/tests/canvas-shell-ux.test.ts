import { expect, test } from "bun:test";
import { canvasShortcutLabel } from "@/lib/canvas/canvas-shortcut-label";
import { quickMentionImages, quickMentionReferenceIndex } from "@/lib/canvas/canvas-quick-reference-mentions";

test("shortcut labels show the user's platform modifier without changing plain keys", () => {
    expect(canvasShortcutLabel("Ctrl / Cmd + Shift + Z", "MacIntel")).toBe("⌘ + Shift + Z");
    expect(canvasShortcutLabel("Ctrl / Cmd + V", "Win32")).toBe("Ctrl + V");
    expect(canvasShortcutLabel("F2", "Win32")).toBe("F2");
});

test("quick mentions keep current tray numbering and avoid duplicate canvas/history entries", () => {
    const references = [{ id: "first", name: "首图", type: "image/png", dataUrl: "blob:first", storageKey: "image:first" }];
    const candidates = [{ id: "canvas:first", label: "图7", name: "原图", dataUrl: "blob:first", source: "canvas" as const }, { id: "history:first", label: "图9", name: "历史图片", storageKey: "image:first", source: "conversation" as const }, { id: "history:next", label: "图2", name: "结果图", dataUrl: "blob:next", source: "conversation" as const }];
    expect(quickMentionReferenceIndex(references, candidates[0])).toBe(0);
    expect(quickMentionImages(references, candidates).map(item => ({ id: item.id, label: item.label }))).toEqual([{ id: "first", label: "图1" }, { id: "history:next", label: "图2" }]);
});
