export const videoModelConfigIds = {
  "MiniMax-H3": "40000000-0000-4000-8000-000000000110",
  "doubao-seedance-2.5": "40000000-0000-4000-8000-000000000111",
  "wan2.7": "40000000-0000-4000-8000-000000000112",
  "happyhorse-1.1": "40000000-0000-4000-8000-000000000113",
} as const;

export function listAvailableDemoModels<T extends Record<string, unknown>>(
  models: T[],
  providers: Array<Record<string, unknown>>,
) {
  const configuredProviderIds = new Set(
    providers
      .filter((provider) => provider.hasCredentials === true)
      .map((provider) => String(provider.id)),
  );

  return models.filter(
    (model) => model.enabled === true && !String(model.modelId).startsWith("demo-") && configuredProviderIds.has(String(model.providerId)),
  );
}

export function resolveDemoExternalProviders(input: {
  openTokenApiKey?: string;
  apiMartApiKey?: string;
}) {
  return {
    hasOpenToken: Boolean(input.openTokenApiKey?.trim()),
    hasApiMart: Boolean(input.apiMartApiKey?.trim()),
    openTokenGptImage2ModelId: "40000000-0000-4000-8000-000000000105",
    openTokenGptImage2ApiModelId: "gpt-image-2",
    openTokenGptImage2DisplayName: "open gpt2",
    officialNanoBanana2ModelId: "40000000-0000-4000-8000-000000000106",
    openTokenGeminiDisplayName: "gemini",
    officialNanoBanana2Capabilities: ["generate", "edit"],
    apiMartGptImage2ModelId: "40000000-0000-4000-8000-000000000099",
    apiMartGptImage2PublicModelId: "vcen-gpt2",
    claudeModelIds: ["claude-opus-5", "claude-sonnet-5", "claude-fable-5"] as const,
  };
}
