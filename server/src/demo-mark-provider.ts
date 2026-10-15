import { MARK_IMAGE_BASE_URL, MARK_PLATFORM_MODELS, MARK_IMAGE_PROVIDER_ID, MARK_IMAGE_PROVIDER_NAME } from "../../shared/mark-image-models";

/** Demo credentials are server-only and read-only; admin writes stay in the formal API. */
export function createDemoMarkProvider(input: { apiKey?: string; baseUrl?: string }) {
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
    models: MARK_PLATFORM_MODELS.map((model, index) => ({
      id: `d5000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      providerId: MARK_IMAGE_PROVIDER_ID, providerName: MARK_IMAGE_PROVIDER_NAME, protocol: "apimart",
      workflowConfigId: null, workflowName: null, replacementModelConfigId: null,
      name: model.name, modelId: model.modelId, capabilities: [...model.capabilities],
      creditCost: 0, rmbCost: 0, concurrencyLimit: 2, enabled: model.defaultEnabled,
    })),
  };
}
