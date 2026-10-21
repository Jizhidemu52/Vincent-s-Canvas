import { fileURLToPath } from "node:url";

export type ProviderConnectionAttempt = {
  attempt: number;
  phase: "initial_tls" | "http_started";
  elapsedMs: number;
  connectMs?: number;
  code?: string;
};

export type ProviderSubmissionDiagnostics = {
  code: string;
  phase: "initial_tls" | "http_started" | "response" | "preflight";
  attempts?: number;
  connectionAttempts?: ProviderConnectionAttempt[];
};

/** Only bounded, non-sensitive transport metadata may enter persistent audit logs.
 * Adapters wrap failures with cause; never infer a safe retry phase from a plain
 * ECONNRESET, or copy arbitrary Error properties such as proxy credentials.
 */
export function readProviderSubmissionDiagnostics(error: unknown): ProviderSubmissionDiagnostics | null {
  const validCode = (value: unknown): value is string => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value);
  const validDuration = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  try {
    for (let depth = 0; depth < 4 && error && typeof error === "object"; depth++) {
      const record = error as Record<string, unknown>;
      if (validCode(record.code) && typeof record.phase === "string" && ["initial_tls", "http_started", "response", "preflight"].includes(record.phase)) {
        const result: ProviderSubmissionDiagnostics = { code: record.code, phase: record.phase as ProviderSubmissionDiagnostics["phase"] };
        if (record.attempts === 1 || record.attempts === 2) result.attempts = record.attempts;
        const connections: ProviderConnectionAttempt[] = [];
        if (Array.isArray(record.connectionAttempts)) for (const item of record.connectionAttempts.slice(0, 2)) {
          if (!item || typeof item !== "object" || (item.attempt !== 1 && item.attempt !== 2)
            || (item.phase !== "initial_tls" && item.phase !== "http_started") || !validDuration(item.elapsedMs)) continue;
          connections.push({
            attempt: item.attempt, phase: item.phase, elapsedMs: item.elapsedMs,
            ...(validDuration(item.connectMs) && item.connectMs <= item.elapsedMs ? { connectMs: item.connectMs } : {}),
            ...(validCode(item.code) ? { code: item.code } : {}),
          });
        }
        if (connections.length) result.connectionAttempts = connections;
        return result;
      }
      error = record.cause;
    }
  } catch { /* Diagnostic inspection must never replace the original failure. */ }
  return null;
}

type TransportHead = {
  status?: number;
  statusText?: string;
  headers?: [string, string][];
  connectionAttempts?: ProviderConnectionAttempt[];
  error?: { message: string; code: string; phase: string; attempts: number; connectionAttempts?: ProviderConnectionAttempt[] };
};

function submissionError(message: string, details: { code: string; phase: string; attempts?: number; connectionAttempts?: ProviderConnectionAttempt[] }) {
  const status = details.phase === "initial_tls" || details.phase === "preflight"
    ? "模型业务HTTP请求尚未发送"
    : details.phase === "http_started" || details.phase === "response"
      ? "请求已发出，结果待核查，不会自动重新提交"
      : "提交状态未知，结果待核查，不会自动重新提交";
  const description = details.code === "PROVIDER_CONNECT_TIMEOUT"
    ? `连接模型服务超时，${details.attempts ?? 1} 次连接均未完成 TLS 握手`
    : message;
  return Object.assign(new Error(`${description}（${status}）`), details);
}

/** Transport for one provider request, including an unauthenticated result GET.
 * Callers own parsing, polling and result materialization; this transport never
 * decides to start another generation after a request has been sent.
 * HTTPS uses a fresh native Node socket with verified pre-HTTP TLS phases.
 * Explicit proxy/NO_PROXY environment settings are respected; redirects and
 * fallback from a failing configured proxy to direct access are not allowed.
 */
export async function fetchProviderSubmission(url: string | URL, init: RequestInit): Promise<Response> {
  const address = new URL(url);
  const headers = new Headers(init.headers);
  if (headers.has("expect")) throw new Error("Expect header is not supported for provider submissions");
  if (init.signal?.aborted) throw init.signal.reason;
  if (address.protocol !== "https:") return fetch(address, { ...init, redirect: "error", keepalive: false });
  const node = Bun.which("node");
  if (!node) throw new Error("Native Node.js is required for safe HTTPS provider submissions");

  // Request serializes multipart exactly once; the same immutable bytes are
  // used by the initial attempt and the sole eligible pre-HTTP TLS retry.
  headers.delete("transfer-encoding");
  headers.set("accept-encoding", "identity");
  const request = new Request(address, { ...init, headers, redirect: "error" });
  const bytes = await request.arrayBuffer();
  if (init.signal?.aborted) throw init.signal.reason;
  const child = Bun.spawn([node, fileURLToPath(new URL("./provider-submission-worker.mjs", import.meta.url))], {
    stdin: new Blob([JSON.stringify({ url: address.toString(), method: request.method, headers: Object.fromEntries(request.headers), body: Buffer.from(bytes).toString("base64") })]),
    stdout: "pipe", stderr: "ignore", env: { ...process.env },
  });
  const exited = child.exited;
  const reader = child.stdout.getReader();
  const abort = () => { child.kill(); void reader.cancel(init.signal?.reason).catch(() => {}); };
  const cleanup = () => init.signal?.removeEventListener("abort", abort);
  init.signal?.addEventListener("abort", abort, { once: true });
  if (init.signal?.aborted) abort();

  try {
    let buffered = Buffer.alloc(0);
    let separator = -1;
    while (separator < 0) {
      if (init.signal?.aborted) throw init.signal.reason;
      const chunk = await reader.read();
      if (init.signal?.aborted) throw init.signal.reason;
      if (chunk.done) throw new Error("Provider submission transport ended without response headers; submission state is unknown");
      buffered = Buffer.concat([buffered, chunk.value]);
      separator = buffered.indexOf(10);
      if (separator < 0 && buffered.length > 65_536) throw new Error("Provider transport returned invalid response metadata");
    }
    const metadata = JSON.parse(buffered.subarray(0, separator).toString("utf8")) as TransportHead;
    if (metadata.error) {
      const { message, ...details } = metadata.error;
      throw submissionError(message, details);
    }
    if (!Number.isInteger(metadata.status) || metadata.status! < 200 || metadata.status! > 599 || !Array.isArray(metadata.headers)) throw new Error("Provider transport returned invalid response metadata");
    const firstBytes = buffered.subarray(separator + 1);
    if ([204, 205, 304].includes(metadata.status!) || request.method === "HEAD") {
      await reader.cancel();
      await exited;
      cleanup();
      return new Response(null, { status: metadata.status, statusText: metadata.statusText, headers: metadata.headers });
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) { if (firstBytes.length) controller.enqueue(firstBytes); },
      async pull(controller) {
        try {
          if (init.signal?.aborted) throw init.signal.reason;
          const chunk = await reader.read();
          if (init.signal?.aborted) throw init.signal.reason;
          if (!chunk.done) { controller.enqueue(chunk.value); return; }
          const exitCode = await exited;
          if (init.signal?.aborted) throw init.signal.reason;
          if (exitCode !== 0) throw submissionError("Provider response stream was interrupted; the original submission will not be replayed", {
            code: "PROVIDER_RESPONSE_STREAM_ERROR", phase: "response",
            ...(metadata.connectionAttempts?.length ? { attempts: metadata.connectionAttempts.length, connectionAttempts: metadata.connectionAttempts } : {}),
          });
          cleanup();
          controller.close();
        } catch (error) { cleanup(); child.kill(); controller.error(error); }
      },
      async cancel(reason) { cleanup(); child.kill(); await reader.cancel(reason).catch(() => {}); },
    });
    return new Response(body, { status: metadata.status, statusText: metadata.statusText, headers: metadata.headers });
  } catch (error) {
    cleanup();
    child.kill();
    await reader.cancel().catch(() => {});
    throw error;
  }
}
