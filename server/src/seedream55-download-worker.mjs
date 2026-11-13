// Reuse the established native-Node DNS pinning boundary for provider outputs.
// No cookies, provider credentials, ambient proxies or redirects are allowed.
import { requestPinned, resolvePublicAddress, validatePublicUrl } from "./reference-import/public-fetch.mjs";
import { lookup } from "node:dns/promises";
import { pathToFileURL } from "node:url";

/** Each socket still pins one previously validated public address. A dead DNS
 * answer must not discard an otherwise reachable original. No redirects, TLS
 * failures, invalid content, credentials or proxy routes are retried. */
export async function downloadSeedream55Original(input, { resolver = lookup, request = requestPinned } = {}) {
  if (process.versions.bun) throw new Error("Native Node required");
  const url = validatePublicUrl(input);
  const signal = AbortSignal.timeout(90_000);
  let addresses;
  const first = await resolvePublicAddress(url, async (...args) => {
    addresses = await resolver(...args);
    return addresses;
  });
  signal.throwIfAborted();
  const candidates = [...new Map((addresses ?? [first]).map(address => [address.address, address])).values()].slice(0, 3);
  for (const [index, address] of candidates.entries()) {
    signal.throwIfAborted();
    try {
      const result = await request(url, address, { kind: "image", maxBytes: 64 * 1024 * 1024, signal, connectTimeoutMs: 10_000 });
      if (result.status < 200 || result.status >= 300) throw new Error("Redirects are not allowed");
      return result.bytes;
    } catch (error) {
      signal.throwIfAborted();
      if (index === candidates.length - 1 || !["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "EHOSTUNREACH", "ENETUNREACH"].includes(error?.code)) throw error;
    }
  }
  throw new Error("No public download address available");
}

async function main() {
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 8192) throw new Error("URL too long");
    }
    process.stdout.end(await downloadSeedream55Original(input));
  } catch {
    // Signed URLs, internal IPs and upstream diagnostics never reach public UI.
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
