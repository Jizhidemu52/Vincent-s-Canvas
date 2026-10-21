import { describe, expect, test } from "bun:test";
import { moduleDefinitions, moduleKeys, toolDefinitions, moduleIsEnabled } from "../../shared/feature-catalog";
import { isModuleAvailable } from "@/stores/use-module-store";
import { canvasActionModules } from "@/lib/canvas/tool-availability";
import { creativePresets } from "@/lib/creative-presets";

const flags = Object.fromEntries(moduleKeys.map(key => [key, true]));

describe("formal feature visibility", () => {
    test("covers existing scenes, promoted design workbenches and distinct canvas capabilities", () => {
        const creativeTools = toolDefinitions.filter(item => item.toolKey.startsWith("creative-"));
        const aiPresets = creativePresets.filter(preset => preset.engine !== "vector");
        const vectorPresets = creativePresets.filter(preset => preset.engine === "vector");
        expect(creativePresets).toHaveLength(27);
        expect(creativeTools).toHaveLength(25);
        expect(creativeTools.map(item => item.toolKey).sort()).toEqual(aiPresets.map(preset => `creative-${preset.id}`).sort());
        expect(vectorPresets.map(preset => preset.id)).toEqual(["sketch-vectorization", "pattern-vectorization"]);
        for (const preset of creativePresets) {
            const definitions = moduleDefinitions.filter(item => item.moduleKey === `creative-${preset.id}`);
            expect(definitions).toHaveLength(1);
            expect(definitions[0]).toMatchObject({ parent: "creative", kind: preset.engine === "vector" ? "local" : "ai" });
        }
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
    test("all 27 creative features retain independent switches under the creative parent", () => {
        for (const preset of creativePresets) {
            const definition = moduleDefinitions.find(item => item.moduleKey === `creative-${preset.id}`)!;
            const key = definition.moduleKey;
            expect(moduleIsEnabled(flags, key)).toBe(true);
            expect(moduleIsEnabled({ ...flags, [key]: false }, key)).toBe(false);
            expect(moduleIsEnabled({ ...flags, creative: false }, key)).toBe(false);
            expect(isModuleAvailable({ ...flags, "image-edit": false }, [], key)).toBe(true);
            if (definition.kind === "ai") expect(isModuleAvailable(flags, [{ toolKey: key, enabled: false }], key)).toBe(false);
        }
    });
    test("disabled binding is hidden, including a disabled chat parent", () => {
        expect(isModuleAvailable(flags, [{ toolKey: "creative-pattern-craft", enabled: false }], "creative-pattern-craft")).toBe(false);
        expect(isModuleAvailable(flags, [{ toolKey: "gpt-chat", enabled: false }], "gpt-chat-image")).toBe(false);
        expect(isModuleAvailable(flags, [], "canvas-image")).toBe(true);
    });
    test("local tools are separate from paid AI and do not lock away backups", () => {
        const disabledAiBindings = toolDefinitions.map(item => ({ toolKey: item.toolKey, enabled: false }));
        for (const key of ["creative-sketch-vectorization", "creative-pattern-vectorization"] as const) {
            expect(toolDefinitions.map(item => item.toolKey)).not.toContain(key);
            expect(isModuleAvailable(flags, disabledAiBindings, key)).toBe(true);
        }
        expect(canvasActionModules.crop).toBe("canvas-local-tools");
        expect(canvasActionModules.maskEdit).toBe("canvas-mask-edit");
        expect(canvasActionModules.angle).toBe("canvas-angle");
        expect(canvasActionModules.download).toBeUndefined();
    });
});
