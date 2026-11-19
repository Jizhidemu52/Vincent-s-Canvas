import { describe, expect, test } from "bun:test";
import { resolveConversationPrimaryAssetId } from "../src/image-conversation-projector";

describe("conversation primary result identity", () => {
  const id = "12345678-1234-4234-8234-123456789abc";
  test("uses only the existing task primary URL and normalizes UUID case", () => {
    expect(resolveConversationPrimaryAssetId([`/api/assets/${id}/content`])).toBe(id);
    expect(resolveConversationPrimaryAssetId([`/api/assets/${id.toUpperCase()}/content`])).toBe(id);
  });
  for (const value of [
    null, {}, [], [""], ["https://example.test/image.png"], ["/api/assets/not-a-uuid/content"],
    [`/api/assets/${id}/content?download=1`], [`/api/assets/${id}/thumbnail`],
    [`https://example.test/api/assets/${id}/content`], [{ assetId: id }],
    [`/api/assets/${id}/content`, `/api/assets/${id}/content`],
  ]) test(`rejects missing, ambiguous, arbitrary or unsupported manifest: ${JSON.stringify(value)}`, () => {
    expect(() => resolveConversationPrimaryAssetId(value)).toThrow();
  });
});
