export type DemoProviderCredentialState = {
  apiMartApiKey: string;
  openTokenApiKey: string;
};

export function applyDemoProviderCredentials(
  state: DemoProviderCredentialState,
  providerId: string,
  credentials: Record<string, unknown> | undefined,
  providerIds: { apiMartProviderId: string; openTokenProviderId: string; openTokenClaudeProviderId?: string },
): DemoProviderCredentialState {
  const apiKey = typeof credentials?.apiKey === "string" ? credentials.apiKey.trim() : "";
  if (!apiKey) return state;
  if (providerId === providerIds.apiMartProviderId) return { ...state, apiMartApiKey: apiKey };
  if (providerId === providerIds.openTokenProviderId || providerId === providerIds.openTokenClaudeProviderId) return { ...state, openTokenApiKey: apiKey };
  return state;
}
