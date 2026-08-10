import { expect, test } from "bun:test";

import { resolveDemoExternalProviders } from "../src/demo-provider-configuration";

test("local demo enables OpenToken and APIMart together when both credentials are present", () => {
  const providers = resolveDemoExternalProviders({
    openTokenApiKey: "opentoken-key",
    apiMartApiKey: "apimart-key",
  });

  expect(providers.hasOpenToken).toBe(true);
  expect(providers.hasApiMart).toBe(true);
  expect(providers.openTokenGptImage2ModelId).not.toBe(providers.apiMartGptImage2ModelId);
});
