import { expect, test } from "bun:test";
import { MARK_IMAGE_PROVIDER_ID, MARK_PLATFORM_MODELS } from "../../shared/mark-image-models";
import { imageParameterProfile } from "../src/image-parameter-profile";
import { presentAdminModel, presentPublicModel, selectCreativeModels } from "../src/model-presentation";

const mark = {
  id: "30000000-0000-4000-8000-000000000001", providerId: MARK_IMAGE_PROVIDER_ID,
  name: "renamed", modelId: "gpt-image-2.5-flare", protocol: "apimart",
  providerName: "Mark 出图", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0,
};

test("Mark choices require the fixed provider and exact supported IDs, without collapsing OpenToken choices", () => {
  const openToken = { ...mark, id: "opentoken-flare", providerId: "opentoken-provider", providerName: "OpenToken", protocol: "openai" };
  const models = [
    mark, openToken,
    { ...mark, id: "sunburst", modelId: "gpt-image-2.5-sunburst" },
    { ...mark, id: "nano", modelId: "gemini-nano-banana-2.1" },
    { ...mark, id: "duplicate" },
    { ...mark, id: "spoofed", providerId: "different-provider" },
    { ...mark, id: "unsupported", modelId: "gpt-image-2.5-ext" },
    { ...mark, id: "wrong-protocol", protocol: "openai" },
  ];
  expect(selectCreativeModels(models).map(model => model.id)).toEqual([mark.id, "sunburst", "nano", "opentoken-flare"]);
  expect(models).toHaveLength(8);
});

test("all nine platform models retain distinct UUIDs, exact display prefixes and explicit mask capabilities", () => {
  expect(MARK_PLATFORM_MODELS).toHaveLength(9);
  for (const [index, preset] of MARK_PLATFORM_MODELS.entries()) {
    const row = { ...mark, ...preset, id: `mark-model-${index}` };
    for (const role of ["designer", "super_admin"]) {
      const shown = presentPublicModel(row, role);
      expect(shown.modelId).toBe(row.id);
      expect(shown.name).toBe(preset.name);
      expect(shown.name).toStartWith("aplmart-");
      expect(shown.publicDescription).toBe(preset.description);
      if ((preset.capabilities as readonly string[]).includes("generate")) expect(shown.imageSupportsMask).toBe(index < 2);
      else expect(shown.imageSupportsMask).toBeUndefined();
    }
  }
});

test("Nano2 Official exposes neutral capability limits, independently of Nano2.1", () => {
  const preset = MARK_PLATFORM_MODELS.at(-1)!;
  const shown = presentPublicModel({ ...mark, ...preset, id: "nano-two-official" }, "designer");
  expect(shown).toMatchObject({ modelId: "nano-two-official", name: "aplmart-nano2", imageParameterProfile: "resolution", imageSupportsMask: false, imageSupportsOfficialFallback: false });
  expect(shown).not.toHaveProperty("parameterModelId");
});

test.each(["designer", "super_admin", "department_admin"])("%s selects Mark by configuration UUID and receives neutral parameter profiles", role => {
  const shown = presentPublicModel(mark, role);
  expect(shown).toMatchObject({ id: mark.id, modelId: mark.id, name: "aplmart-gpt2.5-flare", publicName: "aplmart-gpt2.5-flare", imageParameterProfile: "quality-resolution" });
  expect(shown).not.toHaveProperty("providerId");
  expect(shown).not.toHaveProperty("protocol");
  expect(presentAdminModel(mark)).toMatchObject({ modelId: "gpt-image-2.5-flare", providerId: MARK_IMAGE_PROVIDER_ID });
});

test("new parameter profiles are scoped to Mark without changing existing adapters", () => {
  for (const model of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) {
    expect(imageParameterProfile("apimart", model, MARK_IMAGE_PROVIDER_ID)).toBe("quality-resolution");
    expect(imageParameterProfile("apimart", model, "other-provider")).toBe("gpt");
    expect(imageParameterProfile("openai", model, MARK_IMAGE_PROVIDER_ID)).toBe("standard-flex-plus");
  }
  expect(imageParameterProfile("apimart", "gemini-nano-banana-2.1", MARK_IMAGE_PROVIDER_ID)).toBe("resolution-1k");
  expect(imageParameterProfile("apimart", "gemini-nano-banana-2.1", "other-provider")).toBe("gemini");
});
