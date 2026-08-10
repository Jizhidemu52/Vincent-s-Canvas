export function resolveDemoExternalProviders(input: {
  openTokenApiKey?: string;
  apiMartApiKey?: string;
}) {
  return {
    hasOpenToken: Boolean(input.openTokenApiKey?.trim()),
    hasApiMart: Boolean(input.apiMartApiKey?.trim()),
    openTokenGptImage2ModelId: "40000000-0000-4000-8000-000000000105",
    officialNanoBanana2ModelId: "40000000-0000-4000-8000-000000000106",
    apiMartGptImage2ModelId: "40000000-0000-4000-8000-000000000099",
  };
}
