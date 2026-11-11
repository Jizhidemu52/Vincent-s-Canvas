// Reuse the established native-Node DNS pinning boundary for provider outputs.
// No cookies, provider credentials, ambient proxies or redirects are allowed.
import { requestPinned, resolvePublicAddress, validatePublicUrl } from "./reference-import/public-fetch.mjs";

try {
  if (process.versions.bun) throw new Error("Native Node required");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 8192) throw new Error("URL too long");
  }
  const url = validatePublicUrl(input);
  const signal = AbortSignal.timeout(90_000);
  const address = await resolvePublicAddress(url);
  signal.throwIfAborted();
  const result = await requestPinned(url, address, { kind: "image", maxBytes: 64 * 1024 * 1024, signal });
  if (result.status < 200 || result.status >= 300) throw new Error("Redirects are not allowed");
  process.stdout.end(result.bytes);
} catch {
  // Signed URLs, internal IPs and upstream diagnostics never reach public UI.
  process.exitCode = 1;
}
