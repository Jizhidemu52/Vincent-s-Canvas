import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { i18nHarness } from "./helpers/i18n-harness";
import { canvasArrangeOptions } from "../src/lib/canvas/canvas-node-arrange";

const componentUrl = new URL("../src/components/canvas/canvas-design-actions.tsx", import.meta.url);
const localRequire = createRequire(componentUrl);
const code = ts.transpileModule(readFileSync(componentUrl, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const module = { exports: {} as typeof import("../src/components/canvas/canvas-design-actions") };
new Function("require", "module", "exports", code)((name: string) => name === "@/lib/i18n" ? i18nHarness : name.endsWith(".css") ? {} : localRequire(name), module, module.exports);
const { CanvasDesignActions } = module.exports;

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
