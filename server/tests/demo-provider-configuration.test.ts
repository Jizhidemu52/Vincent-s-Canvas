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
  expect(providers.openTokenGptImage2ApiModelId).toBe("gpt-image-2");
  expect(providers.openTokenGptImage2DisplayName).toBe("open gpt2");
  expect(providers.openTokenGeminiDisplayName).toBe("gemini");
  expect(providers.apiMartGptImage2PublicModelId).toBe("vcen-gpt2");
  expect(providers.officialNanoBanana2ModelId).toEqual(expect.any(String));
  expect(providers.officialNanoBanana2ModelId).not.toBe(providers.openTokenGptImage2ModelId);
  expect(providers.officialNanoBanana2Capabilities).toEqual(["generate", "edit"]);
  expect(providers.claudeModelIds).toEqual(["claude-opus-5", "claude-sonnet-5", "claude-fable-5"]);
  expect(providers.openTokenGptImage25Models.map((model) => model.modelId)).toEqual(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]);
  expect(providers.openTokenGptChatModel.modelId).toBe("gpt-6-astra");
  expect(providers.openTokenClaudeModel.modelId).toBe("claude-fable-5-1");
  const newModelIds = [...providers.openTokenGptImage25Models.map((model) => model.id), providers.openTokenGptChatModel.id, providers.openTokenClaudeModel.id];
  expect(new Set(newModelIds).size).toBe(4);
});
