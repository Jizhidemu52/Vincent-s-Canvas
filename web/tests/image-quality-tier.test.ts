import { expect, test } from "bun:test";
import { availableQualityTiers, currentQualityTier, qualityTierPatch, qualityTiers } from "../src/lib/image-quality-tier";

test("presets round-trip without rewriting unrelated output options", () => {
    for (const tier of qualityTiers) {
        const patch = qualityTierPatch(tier, '{"output_format":"webp","complexity":"low"}');
        expect(currentQualityTier(patch.quality, patch.imageOptions)).toBe(tier.id);
        expect(JSON.parse(patch.imageOptions)).toEqual({ output_format: "webp", complexity: "low", resolution: tier.resolution });
    }
    expect(currentQualityTier("high", '{"resolution":"1k"}')).toBe("custom");
    expect(currentQualityTier("medium")).toBe("custom");
});

test("advertises only quality and resolution pairs the selected adapter actually supports", () => {
    expect(availableQualityTiers({ qualities: ["low","medium","high"], resolutions: ["1k","2k"] }).map(tier => tier.id)).toEqual(["draft","standard","hd"]);
    expect(availableQualityTiers({ qualities: ["low","medium"], resolutions: ["1k","2k","4k"] }).map(tier => tier.id)).toEqual(["draft","standard"]);
    expect(availableQualityTiers({ qualities: ["1k","2k","4k"], resolutions: [] })).toEqual([]);
});
