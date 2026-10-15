import { describe, expect, test } from "bun:test";
import { moduleKeys, toolDefinitions, moduleIsEnabled } from "../../shared/feature-catalog";
import { isModuleAvailable } from "@/stores/use-module-store";
import { canvasActionModules } from "@/lib/canvas/tool-availability";

const flags = Object.fromEntries(moduleKeys.map(key => [key, true]));

describe("formal feature visibility", () => {
    test("covers existing scenes, promoted design workbenches and distinct canvas capabilities", () => {
        expect(toolDefinitions.filter(item => item.toolKey.startsWith("creative-"))).toHaveLength(9);
        expect(toolDefinitions.filter(item => item.toolKey.startsWith("canvas-"))).toHaveLength(8);
        expect(moduleKeys).toContain("pattern-placement");
        expect(moduleKeys).toContain("pattern-repeat");
        expect(moduleKeys).toContain("series-recipe");
    });
    test("disabling one scene does not disable another or depend on old image-edit gate", () => {
        const changed = { ...flags, "image-edit": false, "creative-pattern-craft": false };
        expect(moduleIsEnabled(changed, "creative-pattern-colorway")).toBe(true);
        expect(moduleIsEnabled(changed, "creative-pattern-craft")).toBe(false);
        expect(moduleIsEnabled({ ...flags, creative: false }, "creative-pattern-colorway")).toBe(false);
    });
    test("disabled binding is hidden, including a disabled chat parent", () => {
        expect(isModuleAvailable(flags, [{ toolKey: "creative-pattern-craft", enabled: false }], "creative-pattern-craft")).toBe(false);
        expect(isModuleAvailable(flags, [{ toolKey: "gpt-chat", enabled: false }], "gpt-chat-image")).toBe(false);
        expect(isModuleAvailable(flags, [], "canvas-image")).toBe(true);
    });
    test("local tools are separate from paid AI and do not lock away backups", () => {
        expect(canvasActionModules.crop).toBe("canvas-local-tools");
        expect(canvasActionModules.maskEdit).toBe("canvas-mask-edit");
        expect(canvasActionModules.angle).toBe("canvas-angle");
        expect(canvasActionModules.download).toBeUndefined();
    });
});
