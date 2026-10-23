import { createHash } from "node:crypto";

export function requestedContentHash(metadata: Record<string, unknown> | undefined) {
  const hash = metadata?.contentSha256;
  return typeof hash === "string" && /^[0-9a-f]{64}$/i.test(hash) ? hash.toLowerCase() : null;
}

export function hashAssetContent(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
