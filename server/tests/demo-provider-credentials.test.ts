import { describe, expect, test } from "bun:test";
import { applyDemoProviderCredentials } from "../src/demo-provider-credentials";
import { listAvailableDemoModels, resolveDemoExternalProviders, videoModelConfigIds } from "../src/demo-provider-configuration";

describe("demo provider credentials", () => {
  test("updates only the selected provider's runtime key", () => {
    const result = applyDemoProviderCredentials(
      { apiMartApiKey: "old-apimart", openTokenApiKey: "old-opentoken" },
      "apimart-provider",
      { apiKey: "new-apimart" },
      { apiMartProviderId: "apimart-provider", openTokenProviderId: "opentoken-provider" },
    );

    expect(result).toEqual({ apiMartApiKey: "new-apimart", openTokenApiKey: "old-opentoken" });
  });

  test("does not erase a working runtime key when no api key is submitted", () => {
    const result = applyDemoProviderCredentials(
      { apiMartApiKey: "working-key", openTokenApiKey: "" },
      "apimart-provider",
      {},
      { apiMartProviderId: "apimart-provider", openTokenProviderId: "opentoken-provider" },
    );

    expect(result.apiMartApiKey).toBe("working-key");
  });

  test("keeps video configuration IDs distinct from OpenToken image models", () => {
    const models = resolveDemoExternalProviders({});
    const imageIds = [models.openTokenGptImage2ModelId, models.officialNanoBanana2ModelId];

    expect(Object.values(videoModelConfigIds)).not.toContain(imageIds[0]);
    expect(Object.values(videoModelConfigIds)).not.toContain(imageIds[1]);
  });

  test("hides models whose provider has no configured credential", () => {
    const visible = listAvailableDemoModels(
      [
        { id: "opentoken-gpt", providerId: "opentoken", enabled: true },
        { id: "apimart-gpt", providerId: "apimart", enabled: true },
        { id: "disabled", providerId: "opentoken", enabled: false },
        { id: "placeholder", modelId: "demo-image", providerId: "opentoken", enabled: true },
      ],
      [
        { id: "opentoken", hasCredentials: true },
        { id: "apimart", hasCredentials: false },
      ],
    );

    expect(visible.map((model) => model.id)).toEqual(["opentoken-gpt"]);
  });
});
