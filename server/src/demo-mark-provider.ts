import { MARK_IMAGE_BASE_URL, MARK_PLATFORM_MODELS, MARK_IMAGE_PROVIDER_ID, MARK_IMAGE_PROVIDER_NAME } from "../../shared/mark-image-models";

const fixedModelConfigurations = [
  { demoOrdinal: 8, modelId: "grok-imagine-image-2.0", name: "aplmart-grok2", defaultEnabled: false, capabilities: ["generate", "edit", "batch"] as const },
  { demoOrdinal: 9, modelId: "gemini-3.1-flash-image-preview-official", name: "aplmart-nano2", defaultEnabled: true, capabilities: ["generate", "edit", "batch"] as const },
  { demoOrdinal: 13, modelId: "mai-image-2.6-flash", name: "aplmart-mai2.6-flash", defaultEnabled: true, capabilities: ["generate", "edit", "batch"] as const },
] as const;

/** Demo credentials are server-only and read-only; admin writes stay in the formal API. */
export function createDemoMarkProvider(input: { apiKey?: string; baseUrl?: string; enableSeedream55?: boolean }) {
  const apiKey = input.apiKey?.trim() || "";
  const baseUrl = (input.baseUrl?.trim() || MARK_IMAGE_BASE_URL).replace(/\/+$/, "");
  const timestamp = new Date().toISOString();
  return {
    apiKey,
    baseUrl,
    provider: {
      id: MARK_IMAGE_PROVIDER_ID, name: MARK_IMAGE_PROVIDER_NAME, protocol: "apimart", baseUrl,
      enabled: true, hasCredentials: Boolean(apiKey), createdAt: timestamp, updatedAt: timestamp,
    },
    models: [...MARK_PLATFORM_MODELS, ...fixedModelConfigurations].map(model => ({
      id: `d5000000-0000-4000-8000-${String(model.demoOrdinal).padStart(12, "0")}`,
      providerId: MARK_IMAGE_PROVIDER_ID, providerName: MARK_IMAGE_PROVIDER_NAME, protocol: "apimart",
      workflowConfigId: null, workflowName: null, replacementModelConfigId: null,
      name: model.name, modelId: model.modelId, capabilities: [...model.capabilities],
      creditCost: 0, rmbCost: 0, concurrencyLimit: 2,
      enabled: model.defaultEnabled || (model.modelId === "seedream-5-5" && input.enableSeedream55 === true),
    })),
  };
}
