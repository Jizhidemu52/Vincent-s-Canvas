// Run with native Node, not Bun's node:https compatibility layer. Only this
// process owns retries: IPC/parent failures never replay a provider submission.
import https from "node:https";
import { constants } from "node:crypto";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { pipeline } from "node:stream/promises";

const initialHandshakeRetryCodes = new Set([
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID",
  // Safe only with this native worker's proven pre-secureConnect/no-HTTP phase.
  // A reset from ordinary fetch or after HTTP starts remains non-retryable.
  "ECONNRESET",
]);
let headersSent = false;

function fail(error) {
  process.exitCode = 1;
  if (!headersSent) {
    // Node's tunnel error contains the proxy URL (including credentials) and
    // its raw status line. Do not forward either to API clients or task logs.
    const message = error?.code === "ERR_PROXY_TUNNEL"
      ? `Provider proxy tunnel failed${Number.isInteger(error.statusCode) ? ` (HTTP ${error.statusCode})` : ""}`
      : error instanceof Error ? error.message : "Provider transport failed";
    process.stdout.end(`${JSON.stringify({ error: {
      message,
      code: typeof error?.code === "string" ? error.code : "PROVIDER_TRANSPORT_ERROR",
      phase: error?.phase || "unknown", attempts: error?.attempts || 1,
    } })}\n`, () => process.exit(1));
  } else {
    // pipeline has closed the failed upstream stream. Do not leave a broken
    // response or child alive, and never restart the paid request.
    process.exit(1);
  }
}

function requestOnce(input, body, attempts) {
  return new Promise((resolve, reject) => {
    let tlsEstablished = false;
    let httpStarted = false;
    let settled = false;
    const agent = new https.Agent({ proxyEnv: process.env, keepAlive: false, maxCachedSessions: 0 });
    const request = https.request(input.url, {
      method: input.method,
      headers: { ...input.headers, "content-length": String(body.length), connection: "close" },
      agent,
      rejectUnauthorized: true,
      secureOptions: constants.SSL_OP_NO_RENEGOTIATION,
    });
    request.on("error", (error) => {
      // Native proxy setup may emit another request error while its failed
      // socket is being destroyed. Keep the listener, but settle only once.
      if (settled) return;
      settled = true;
      agent.destroy();
      Object.assign(error, { attempts, phase: !tlsEstablished && !httpStarted ? "initial_tls" : "http_started" });
      reject(error);
    });
    request.once("response", (response) => {
      settled = true;
      response.once("close", () => agent.destroy());
      resolve(response);
    });
    request.once("socket", (socket) => {
      socket.disableRenegotiation();
      const sendOnce = () => {
        if (httpStarted || settled) return;
        tlsEstablished = true;
        if (!socket.authorized || socket.destroyed || request.destroyed) {
          request.destroy(new Error("Provider TLS peer was not authorized"));
          return;
        }
        // Irreversibly mark the uncertain/possibly charged phase BEFORE the
        // only operation that can write business HTTP headers or body.
        httpStarted = true;
        request.end(body);
      };
      socket.once("secureConnect", sendOnce);
      // CONNECT agents deliver the target socket only AFTER its TLS handshake.
      // Direct sockets arrive earlier; both paths share the same one-send gate.
      if (socket.encrypted === true && socket.authorized === true) sendOnce();
    });
  });
}

try {
  if (process.versions.bun || !constants.SSL_OP_NO_RENEGOTIATION) throw new Error("Native Node TLS runtime is required");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!((major === 22 && minor >= 21) || (major === 24 && minor >= 5) || major >= 25)) {
    throw Object.assign(new Error("Native Node.js 22.21+ or 24.5+ is required for explicit proxy support"), { code: "UNSUPPORTED_NODE_RUNTIME", phase: "preflight" });
  }
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  if (new URL(input.url).protocol !== "https:") throw new Error("Provider child transport requires HTTPS");
  // Expect causes ClientRequest's constructor to flush headers before end().
  if (Object.keys(input.headers).some((name) => name.toLowerCase() === "expect")) throw new Error("Expect header is not supported for provider submissions");
  const body = Buffer.from(input.body, "base64");
  let response;
  for (let attempts = 1; attempts <= 2; attempts++) {
    try {
      response = await requestOnce(input, body, attempts);
      break;
    } catch (error) {
      if (attempts !== 1 || error?.phase !== "initial_tls" || !initialHandshakeRetryCodes.has(error?.code)) throw error;
    }
  }
  if (!response) throw new Error("Provider returned no HTTP response");
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.destroy();
    throw Object.assign(new Error("Provider submission redirect was rejected"), { phase: "response", code: "PROVIDER_REDIRECT" });
  }
  const headers = Object.entries(response.headers).flatMap(([key, value]) => value === undefined ? [] : Array.isArray(value) ? value.map((item) => [key, item]) : [[key, value]]);
  const encoding = response.headers["content-encoding"];
  const decoder = encoding === "gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : null;
  const outputHeaders = decoder ? headers.filter(([key]) => key !== "content-encoding" && key !== "content-length") : headers;
  process.stdout.write(`${JSON.stringify({ status: response.statusCode, statusText: response.statusMessage, headers: outputHeaders })}\n`);
  headersSent = true;
  if (decoder) await pipeline(response, decoder, process.stdout);
  else await pipeline(response, process.stdout);
} catch (error) { fail(error); }
