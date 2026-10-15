import { describe, expect, test } from "bun:test";
import { CanvasDesignActions } from "../src/components/canvas/canvas-design-actions";
import { canvasArrangeOptions } from "../src/lib/canvas/canvas-node-arrange";

function menu(selectedCount: number, selectedImages: number, calls: string[]) {
    return CanvasDesignActions({ selectedCount, selectedImages, onCompare: () => calls.push("compare"), onTemplate: () => calls.push("template"), onArrange: mode => calls.push(mode) }).props.menu.items;
}

describe("compact canvas design menu", () => {
    test("keeps compare and template discoverable with their original selection requirements", () => {
        const empty = menu(0, 0, []);
        expect(empty.find(item => item?.key === "compare")?.disabled).toBe(true);
        expect(empty.find(item => item?.key === "template")?.disabled).toBe(false);
        const selected = menu(2, 2, []);
        expect(selected.find(item => item?.key === "compare")?.disabled).toBe(false);
        expect(selected.find(item => item?.key === "template")?.disabled).toBe(true);
    });

    test("retains original callbacks and every arrange mode in the labelled submenu", () => {
        const calls: string[] = [];
        const selected = menu(2, 2, calls);
        selected.find(item => item?.key === "compare")?.onClick();
        menu(0, 0, calls).find(item => item?.key === "template")?.onClick();
        const arrangement = selected.find(item => item?.key === "arrange")?.children;
        expect(arrangement.map(item => item.key)).toEqual(canvasArrangeOptions.map(option => option.key));
        arrangement.forEach(item => item.onClick());
        expect(calls).toEqual(["compare", "template", ...canvasArrangeOptions.map(option => option.key)]);
    });
});
