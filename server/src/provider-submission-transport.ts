import { fileURLToPath } from "node:url";

type TransportHead = {
  status?: number;
  statusText?: string;
  headers?: [string, string][];
  error?: { message: string; code: string; phase: string; attempts: number };
};

function submissionError(message: string, details: { code: string; phase: string; attempts?: number }) {
  const status = details.phase === "initial_tls" || details.phase === "preflight"
    ? "模型业务HTTP请求尚未发送"
    : details.phase === "http_started" || details.phase === "response"
      ? "请求已发出，结果待核查，不会自动重新提交"
      : "提交状态未知，结果待核查，不会自动重新提交";
  return Object.assign(new Error(`${message}（${status}）`), details);
}

/** A submission-only transport. Parsing, polling and downloads stay outside it.
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
          if (exitCode !== 0) throw submissionError("Provider response stream was interrupted; the original submission will not be replayed", { code: "PROVIDER_RESPONSE_STREAM_ERROR", phase: "response" });
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
