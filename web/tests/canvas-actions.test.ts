import { expect, test } from "bun:test";
import { canvasActionShortcut, matchCanvasActionShortcut, canvasNodeKeyAction } from "@/lib/canvas/canvas-actions";
import { canvasCommandCatalog as canvasActions, filterCanvasCommands } from "@/lib/canvas/canvas-command-catalog";

test("command definitions expose twenty common actions and real keyboard bindings", () => {
    expect(canvasActions.length).toBeGreaterThanOrEqual(20);
    expect(new Set(canvasActions.map(action => action.id)).size).toBe(canvasActions.length);
    expect(canvasActionShortcut("undo")).toContain("Z");
    expect(canvasActionShortcut("upload")).toBe("");
    expect(matchCanvasActionShortcut({ key: "k", ctrlKey: true })).toBe("commands");
    expect(matchCanvasActionShortcut({ key: "z", metaKey: true, shiftKey: true })).toBe("redo");
    expect(matchCanvasActionShortcut({ key: "g", ctrlKey: true, altKey: true })).toBeUndefined();
});

test("command search supports keyword terms and excludes unavailable actions", () => {
    const commands = canvasActions.map(action => ({ ...action, enabled: action.id !== "group" }));
    expect(filterCanvasCommands(commands, "undo").map(action => action.id)).toEqual(["undo"]);
    expect(filterCanvasCommands(commands, "创建 款式")).toEqual([]);
    expect(filterCanvasCommands(commands, "图片").length).toBeGreaterThan(1);
});

test("canvas search reaches theme and the existing toolbar and context actions", () => {
    for (const query of ["切换主题", "清空画布", "重命名", "画布背景", "显示图片信息", "导出图片", "快捷键"]) {
        expect(filterCanvasCommands(canvasActions, query).length).toBeGreaterThan(0);
    }
});

test("node keyboard editing and movement never hijack modified shortcuts", () => {
    expect(canvasNodeKeyAction({ key: "ArrowRight" })).toEqual({ x: 1, y: 0 });
    expect(canvasNodeKeyAction({ key: "ArrowUp", shiftKey: true })).toEqual({ x: 0, y: -10 });
    expect(canvasNodeKeyAction({ key: "Enter" })).toBe("edit");
    expect(canvasNodeKeyAction({ key: "ArrowDown", ctrlKey: true })).toBeNull();
});

test("continuing an image has one plain E binding without stealing modified keys", () => {
    expect(matchCanvasActionShortcut({ key: "e" })).toBe("continueFromImage");
    expect(matchCanvasActionShortcut({ key: "E" })).toBe("continueFromImage");
    expect(matchCanvasActionShortcut({ key: "e", ctrlKey: true })).toBeUndefined();
    expect(matchCanvasActionShortcut({ key: "e", altKey: true })).toBeUndefined();
    expect(canvasActionShortcut("continueFromImage")).toBe("e");
});
