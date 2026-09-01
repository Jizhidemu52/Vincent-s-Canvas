import { describe, expect, test } from "bun:test";
import { createDemoPublicAssetUrl, normalizeDemoPublicAssetOrigin } from "../src/demo-public-assets";

describe("demo public video assets", () => {
  test("creates a temporary HTTPS URL instead of exposing a local asset path", () => {
    expect(
      createDemoPublicAssetUrl(
        "https://canvas-tunnel.example.test/",
        "asset-123",
        "temporary-access-token",
      ),
    ).toBe("https://canvas-tunnel.example.test/api/assets/asset-123/content?video_access=temporary-access-token");
  });

  test("only allows HTTPS origins for provider-facing image URLs", () => {
    expect(normalizeDemoPublicAssetOrigin("https://canvas-tunnel.example.test/")).toBe(
      "https://canvas-tunnel.example.test",
    );
    expect(() => normalizeDemoPublicAssetOrigin("http://127.0.0.1:3100")).toThrow(
      "DEMO_PUBLIC_ASSET_ORIGIN must be an https URL",
    );
  });
});
