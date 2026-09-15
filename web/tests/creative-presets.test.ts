import { describe, expect, test } from "bun:test";
import { buildCreativePresetHref, CREATIVE_REQUIREMENT_PLACEHOLDER, creativePresetGroups, creativePresets, getCreativePreset } from "@/lib/creative-presets";

describe("creative design presets", () => {
    test("offers nine uniquely addressable presets across the three design groups", () => {
        expect(creativePresets).toHaveLength(9);
        expect(new Set(creativePresets.map((preset) => preset.id)).size).toBe(creativePresets.length);
        expect(creativePresetGroups.map((group) => group.title)).toEqual(["新款设计", "改款设计", "图案设计"]);
        for (const preset of creativePresets) {
            expect(preset.id).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
            expect(preset.title.trim()).not.toBe("");
            expect(preset.description.trim()).not.toBe("");
            expect(creativePresetGroups.some((group) => group.id === preset.group)).toBe(true);
            expect(getCreativePreset(preset.id)).toBe(preset);
            expect(["image-generation", "image-edit"]).toContain(preset.tool);
            expect(Boolean(preset.garment) !== Boolean(preset.prompt)).toBe(true);
        }
    });

    test.each([null, "", "unknown", "constructor", "__proto__"])("unknown identifier %j cannot select a preset", (id) => {
        expect(getCreativePreset(id)).toBeUndefined();
    });

    test("every card opens its own creative route without using the original image page or query parameters", () => {
        const links = creativePresets.map(buildCreativePresetHref);
        expect(new Set(links).size).toBe(creativePresets.length);
        for (const preset of creativePresets) {
            const url = new URL(buildCreativePresetHref(preset), "https://canvas.test");
            expect(url.pathname).toBe(`/creative/${preset.id}`);
            expect(url.pathname.startsWith("/image")).toBe(false);
            expect(url.search).toBe("");
            expect(url.hash).toBe("");
            expect(getCreativePreset(url.pathname.split("/")[2]!)).toBe(preset);
        }
    });

    test("clothing edits have separate creative pages while retaining their structured workflow metadata", () => {
        const restyle = getCreativePreset("local-restyle")!;
        const colorway = getCreativePreset("garment-colorway")!;
        expect(buildCreativePresetHref(restyle)).toBe("/creative/local-restyle");
        expect(buildCreativePresetHref(colorway)).toBe("/creative/garment-colorway");
        expect(restyle).toMatchObject({ tool: "image-edit", garment: "restyle" });
        expect(colorway).toMatchObject({ tool: "image-edit", garment: "colorway" });
    });

    test("tasks requiring user choices expose the same explicit placeholder without inventing a garment", () => {
        const required = creativePresets.filter((preset) => preset.prompt?.includes(CREATIVE_REQUIREMENT_PLACEHOLDER));
        expect(required.map((preset) => preset.id)).toEqual(["text-to-style", "pattern-colorway", "pattern-craft"]);
        expect(getCreativePreset("text-to-style")!.prompt).not.toMatch(/连衣裙|衬衫|夹克|西装|圆领|长袖/);
    });

    test("concept presets preserve important production and unseen-content boundaries", () => {
        for (const preset of creativePresets.filter((item) => item.prompt)) {
            expect(preset.prompt).toContain("概念");
            expect(preset.prompt).toMatch(/不是.*生产|不保证.*生产/);
        }
        expect(getCreativePreset("back-design")!.prompt).toContain("不宣称还原原款真实背面");
        expect(getCreativePreset("style-to-sketch")!.prompt).toContain("不增加看不见的结构");
        expect(getCreativePreset("pattern-extract")!.prompt).toContain("不要把遮挡或缺失区域当作已知原稿");
        expect(getCreativePreset("pattern-colorway")!.prompt).toContain("不保证精确色值");
        expect(getCreativePreset("pattern-craft")!.prompt).toContain("不承诺真实工艺可行性");
    });
});
