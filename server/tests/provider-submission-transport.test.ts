import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer as createTcpServer, type Socket } from "node:net";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { fetchProviderSubmission } from "../src/provider-submission-transport";

let fixtureDirectory: string;
let certificate: string;
let privateKey: string;
const savedExtraCa = process.env.NODE_EXTRA_CA_CERTS;
const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"] as const;
const savedProxyEnv = Object.fromEntries(proxyKeys.map((key) => [key, process.env[key]]));

beforeAll(async () => {
  for (const key of proxyKeys) delete process.env[key];
  fixtureDirectory = await mkdtemp(join(tmpdir(), "provider-transport-test-"));
  const openssl = Bun.which("openssl") || "C:/Program Files/Git/usr/bin/openssl.exe";
  const generated = Bun.spawn([openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", join(fixtureDirectory, "key.pem"), "-out", join(fixtureDirectory, "cert.pem")], { stdout: "ignore", stderr: "pipe" });
  if (await generated.exited !== 0) throw new Error(`Test certificate generation failed: ${await new Response(generated.stderr).text()}`);
  certificate = await readFile(join(fixtureDirectory, "cert.pem"), "utf8");
  privateKey = await readFile(join(fixtureDirectory, "key.pem"), "utf8");
  process.env.NODE_EXTRA_CA_CERTS = join(fixtureDirectory, "cert.pem");
});

afterAll(async () => {
  for (const key of proxyKeys) {
    if (savedProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedProxyEnv[key];
  }
  if (savedExtraCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
  else process.env.NODE_EXTRA_CA_CERTS = savedExtraCa;
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
});

describe("provider submission transport", () => {
  test("explicit proxy CONNECT omits model credentials and body, then submits once on authorized target TLS", async () => {
    const tunnels: Array<{ method?: string; headers: Record<string, unknown>; bytes: number }> = [];
    const sockets = new Set<Socket>();
    let requests = 0;
    const backend = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert: certificate, key: privateKey }, async fetch(request) {
      requests++;
      expect(request.headers.get("authorization")).toBe("Bearer model-test-key");
      expect(request.headers.get("proxy-authorization")).toBeNull();
      expect(await request.text()).toBe("private model prompt");
      return Response.json({ id: "proxied-job" });
    } });
    const proxy = createHttpServer();
    proxy.on("connect", (request, socket, head) => {
      tunnels.push({ method: request.method, headers: request.headers, bytes: head.length });
      const upstream = createConnection({ host: "127.0.0.1", port: backend.port! }, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket);
      });
      sockets.add(socket as Socket); sockets.add(upstream);
      socket.once("error", () => upstream.destroy()); upstream.once("error", () => socket.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    process.env.HTTPS_PROXY = "http://127.0.0.1:1";
    process.env.https_proxy = `http://proxy-user:proxy-secret@127.0.0.1:${(proxy.address() as { port: number }).port}`;
    try {
      const response = await fetchProviderSubmission(`https://127.0.0.1:${backend.port}/submit`, { method: "POST", headers: { authorization: "Bearer model-test-key" }, body: "private model prompt", signal: AbortSignal.timeout(5_000) });
      expect(await response.json()).toEqual({ id: "proxied-job" });
      expect(requests).toBe(1);
      expect(tunnels).toHaveLength(1);
      expect(tunnels[0]!.method).toBe("CONNECT");
      expect(tunnels[0]!.headers.authorization).toBeUndefined();
      expect(tunnels[0]!.headers["proxy-authorization"]).toBe(`Basic ${Buffer.from("proxy-user:proxy-secret").toString("base64")}`);
      expect(tunnels[0]!.bytes).toBe(0);
      expect(JSON.stringify(tunnels)).not.toContain("model-test-key");
      expect(JSON.stringify(tunnels)).not.toContain("private model prompt");
    } finally {
      delete process.env.HTTPS_PROXY;
      delete process.env.https_proxy;
      for (const socket of sockets) socket.destroy();
      backend.stop(true);
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  test("an explicit proxy rejection never falls back to a reachable direct provider", async () => {
    let requests = 0;
    let connects = 0;
    const backend = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert: certificate, key: privateKey }, fetch() { requests++; return new Response("must not happen"); } });
    const proxy = createHttpServer();
    proxy.on("connect", (_request, socket) => { connects++; socket.end("HTTP/1.1 502 Proxy Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    process.env.HTTPS_PROXY = `http://proxy-user:proxy-secret@127.0.0.1:${(proxy.address() as { port: number }).port}`;
    try {
      const error = await fetchProviderSubmission(`https://127.0.0.1:${backend.port}/submit`, { method: "POST", body: "paid job", signal: AbortSignal.timeout(5_000) }).catch((error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe("ERR_PROXY_TUNNEL");
      expect(error.phase).toBe("initial_tls");
      expect(error.attempts).toBe(1);
      expect(error.message).not.toContain("proxy-user");
      expect(error.message).not.toContain("proxy-secret");
      expect(requests).toBe(0);
      expect(connects).toBe(1);
    } finally { delete process.env.HTTPS_PROXY; backend.stop(true); proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve())); }
  });

  test("NO_PROXY preserves direct access without silently ignoring an explicit proxy", async () => {
    let requests = 0;
    const backend = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert: certificate, key: privateKey }, fetch() { requests++; return new Response("direct bypass"); } });
    process.env.HTTPS_PROXY = "http://127.0.0.1:1";
    process.env.NO_PROXY = "127.0.0.1";
    try {
      const response = await fetchProviderSubmission(`https://127.0.0.1:${backend.port}/submit`, { method: "POST", body: "paid job", signal: AbortSignal.timeout(5_000) });
      expect(await response.text()).toBe("direct bypass");
      expect(requests).toBe(1);
    } finally { delete process.env.HTTPS_PROXY; delete process.env.NO_PROXY; backend.stop(true); }
  });

  test("unsupported Node versions fail before silently dropping proxy configuration", async () => {
    for (const version of ["20.19.0", "22.20.0", "23.11.0", "24.4.0"]) {
      const script = `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} }); import(${JSON.stringify(new URL("../src/provider-submission-worker.mjs", import.meta.url).href)});`;
      const child = Bun.spawn([Bun.which("node")!, "--input-type=module", "-e", script], { stdin: new Blob([JSON.stringify({ url: "https://127.0.0.1:1/submit", method: "POST", headers: {}, body: "" })]), stdout: "pipe", stderr: "ignore", env: { ...process.env, HTTPS_PROXY: "http://127.0.0.1:1" } });
      const output = JSON.parse(await new Response(child.stdout).text());
      expect(await child.exited).toBe(1);
      expect(output.error.code).toBe("UNSUPPORTED_NODE_RUNTIME");
      expect(output.error.phase).toBe("preflight");
    }
  });

  for (const code of ["UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", "ECONNRESET"]) test(`does not replay ${code} from plain fetch and disables redirect and connection reuse`, async () => {
    const fetchMock = spyOn(globalThis, "fetch");
    let calls = 0;
    const failure = Object.assign(new Error("transport failed without a verified TLS phase"), { code });
    try {
      fetchMock.mockImplementation(Object.assign(async (_url: unknown, init?: RequestInit) => {
        calls++;
        expect(init?.redirect).toBe("error");
        expect(init?.keepalive).toBe(false);
        throw failure;
      }, { preconnect() {} }));
      await expect(fetchProviderSubmission("http://provider.test/submit", { method: "POST", body: "payload" })).rejects.toBe(failure);
      expect(calls).toBe(1);
    } finally { fetchMock.mockRestore(); }
  });

  test("rejects Expect before it can flush HTTP headers ahead of the secureConnect boundary", async () => {
    await expect(fetchProviderSubmission("https://localhost/submit", { method: "POST", headers: { eXpEcT: "100-continue" }, body: "payload" })).rejects.toThrow("Expect");
  });

  test("preserves a streamed HTTPS response and exact multipart bytes without resubmitting", async () => {
    let requests = 0;
    let finish!: () => void;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert: certificate, key: privateKey }, async fetch(request) {
      requests++;
      const form = await request.formData();
      expect(form.get("model")).toBe("gpt-image-2.5-flare");
      expect(new Uint8Array(await (form.get("image") as File).arrayBuffer())).toEqual(new Uint8Array([0, 1, 254, 255]));
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        finish = () => { controller.enqueue(new TextEncoder().encode("data: last\n\n")); controller.close(); };
      } }), { headers: { "content-type": "text/event-stream", "x-provider-id": "response-1" } });
    } });
    try {
      const form = new FormData();
      form.set("model", "gpt-image-2.5-flare");
      form.append("image", new Blob([new Uint8Array([0, 1, 254, 255])], { type: "image/png" }), "reference.png");
      const response = await fetchProviderSubmission(`https://127.0.0.1:${server.port}/submit`, { method: "POST", body: form, signal: AbortSignal.timeout(10_000) });
      expect(response.headers.get("x-provider-id")).toBe("response-1");
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
      finish();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: last\n\n");
      expect((await reader.read()).done).toBe(true);
      expect(requests).toBe(1);
    } finally { server.stop(true); }
  });

  test("retries only a verified initial certificate rejection, at most once and with zero HTTP submissions", async () => {
    let requests = 0;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert: certificate, key: privateKey }, fetch() { requests++; return new Response("unexpected"); } });
    const extraCa = process.env.NODE_EXTRA_CA_CERTS;
    delete process.env.NODE_EXTRA_CA_CERTS;
    try {
      const error = await fetchProviderSubmission(`https://127.0.0.1:${server.port}/submit`, { method: "POST", body: "paid job", signal: AbortSignal.timeout(10_000) }).catch((error) => error);
      expect(error.code).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
      expect(error.phase).toBe("initial_tls");
      expect(error.attempts).toBe(2);
      expect(error.message).toContain("HTTP请求尚未发送");
      expect(requests).toBe(0);
    } finally { process.env.NODE_EXTRA_CA_CERTS = extraCa; server.stop(true); }
  });

  test("returns HTTP failure without retry and does not follow redirects", async () => {
    let requests = 0;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert: certificate, key: privateKey }, fetch(request) {
      requests++;
      return new URL(request.url).pathname === "/redirect"
        ? Response.redirect("https://localhost/must-not-follow", 307)
        : new Response("upstream unavailable", { status: 503 });
    } });
    try {
      const failed = await fetchProviderSubmission(`https://127.0.0.1:${server.port}/failure`, { method: "POST", body: "paid job" });
      expect(failed.status).toBe(503);
      expect(await failed.text()).toBe("upstream unavailable");
      const redirectError = await fetchProviderSubmission(`https://127.0.0.1:${server.port}/redirect`, { method: "POST", body: "paid job" }).catch((error) => error);
      expect(redirectError.message).toContain("redirect");
      expect(requests).toBe(2);
    } finally { server.stop(true); }
  });

  test("abort after response headers closes the original stream without a new POST", async () => {
    let requests = 0;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert: certificate, key: privateKey }, fetch() {
      requests++;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("first")); } }));
    } });
    try {
      const abort = new AbortController();
      const response = await fetchProviderSubmission(`https://127.0.0.1:${server.port}/submit`, { method: "POST", body: "paid job", signal: abort.signal });
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      abort.abort(new DOMException("Stopped", "AbortError"));
      const abortError = await reader.read().catch((error) => error);
      expect(abortError.message).toContain("Stopped");
      expect(requests).toBe(1);
    } finally { server.stop(true); }
  });

  test("retries a verified initial TLS reset only once with no HTTP submission", async () => {
    let connections = 0;
    let requests = 0;
    const backend = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert: certificate, key: privateKey }, fetch() { requests++; return new Response("unexpected"); } });
    const server = createTcpServer((socket) => { connections++; socket.once("data", () => socket.destroy()); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const error = await fetchProviderSubmission(`https://127.0.0.1:${port}/submit`, { method: "POST", body: "paid job", signal: AbortSignal.timeout(3_000) }).catch((error) => error);
      expect(error.code).toBe("ECONNRESET");
      expect(error.phase).toBe("initial_tls");
      expect(error.attempts).toBe(2);
      expect(error.message).toContain("HTTP请求尚未发送");
      expect(connections).toBe(2);
      expect(requests).toBe(0);
    } finally { backend.stop(true); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  test("a first-handshake reset followed by valid TLS succeeds with exactly one paid HTTP request", async () => {
    let connections = 0;
    let requests = 0;
    const sockets = new Set<Socket>();
    const backend = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert: certificate, key: privateKey }, async fetch(request) {
      requests++;
      expect(request.method).toBe("POST");
      expect(await request.text()).toBe("one paid job");
      return Response.json({ id: "only-job", accepted: true });
    } });
    const frontgate = createTcpServer((socket) => {
      connections++;
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      if (connections === 1) {
        // Terminate after ClientHello, before any TLS authorization or HTTP.
        socket.once("data", () => socket.destroy());
        return;
      }
      const upstream = createConnection({ host: "127.0.0.1", port: backend.port! });
      sockets.add(upstream);
      upstream.once("close", () => sockets.delete(upstream));
      socket.once("error", () => upstream.destroy());
      upstream.once("error", () => socket.destroy());
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    await new Promise<void>((resolve) => frontgate.listen(0, "127.0.0.1", resolve));
    try {
      const port = (frontgate.address() as { port: number }).port;
      const response = await fetchProviderSubmission(`https://127.0.0.1:${port}/submit`, { method: "POST", body: "one paid job", signal: AbortSignal.timeout(5_000) });
      expect(await response.json()).toEqual({ id: "only-job", accepted: true });
      expect(connections).toBe(2);
      expect(requests).toBe(1);
    } finally {
      for (const socket of sockets) socket.destroy();
      backend.stop(true);
      await new Promise<void>((resolve) => frontgate.close(() => resolve()));
    }
  });

  test("does not retry a socket close after the provider received the paid POST", async () => {
    let requests = 0;
    const server = createHttpsServer({ cert: certificate, key: privateKey }, (request) => {
      requests++;
      request.socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const error = await fetchProviderSubmission(`https://127.0.0.1:${port}/submit`, { method: "POST", body: "paid job", signal: AbortSignal.timeout(3_000) }).catch((error) => error);
      expect(error.phase).toBe("http_started");
      expect(error.attempts).toBe(1);
      expect(error.code).toBe("ECONNRESET");
      expect(error.message).toContain("请求已发出，结果待核查，不会自动重新提交");
      expect(error.message).not.toContain("HTTP请求尚未发送");
      expect(error.message).not.toContain("paid job");
      expect(requests).toBe(1);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  test("malformed compressed streaming output fails promptly and closes upstream without a new POST", async () => {
    // Linux CI did not report close through Bun's node:https compatibility
    // socket. Independently observe actual TCP and TLS closure in native Node.
    const fixtureScript = `
      import { createServer } from "node:https";
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      const { cert, key } = JSON.parse(input);
      let connections = 0, closedConnections = 0, requests = 0, posts = 0, requestSocketCloses = 0;
      const publish = (event, details = {}) => process.stdout.write(JSON.stringify({
        event, connections, closedConnections, requests, posts, requestSocketCloses, ...details,
      }) + "\\n");
      const server = createServer({ cert, key }, (request, response) => {
        requests++;
        if (request.method === "POST") posts++;
        publish("request");
        request.socket.once("close", () => { requestSocketCloses++; publish("tls_close"); });
        response.writeHead(200, { "content-encoding": "gzip" });
        response.write("this is not gzip");
      });
      server.on("connection", (socket) => {
        connections++;
        publish("connection");
        socket.once("close", () => { closedConnections++; publish("tcp_close"); });
      });
      server.on("error", (error) => publish("server_error", { code: error.code, message: error.message }));
      server.listen(0, "127.0.0.1", () => publish("listening", { port: server.address().port }));
    `;
    const fixture = Bun.spawn([Bun.which("node")!, "--input-type=module", "-e", fixtureScript], {
      stdin: new Blob([JSON.stringify({ cert: certificate, key: privateKey })]), stdout: "pipe", stderr: "pipe", env: { ...process.env },
    });
    const fixtureStderr = new Response(fixture.stderr).text();
    const events: Array<{ event: string; port?: number; connections: number; closedConnections: number; requests: number; posts: number; requestSocketCloses: number }> = [];
    const reader = fixture.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const nextFixtureEvent = async (timeoutMs: number) => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            while (!buffered.includes("\n")) {
              const chunk = await reader.read();
              if (chunk.done) throw new Error(`Native HTTPS fixture exited before its next event (${await fixture.exited}): ${await fixtureStderr}; events=${JSON.stringify(events)}`);
              buffered += decoder.decode(chunk.value, { stream: true });
            }
            const separator = buffered.indexOf("\n");
            const event = JSON.parse(buffered.slice(0, separator)) as (typeof events)[number];
            buffered = buffered.slice(separator + 1);
            events.push(event);
            return event;
          })(),
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => reject(new Error(`Native HTTPS fixture event timed out; events=${JSON.stringify(events)}`)), Math.max(1, timeoutMs));
          }),
        ]);
      } finally { clearTimeout(deadline); }
    };
    try {
      const listening = await nextFixtureEvent(2_000);
      expect(listening.event).toBe("listening");
      expect(listening.port).toBeGreaterThan(0);
      const response = await fetchProviderSubmission(`https://127.0.0.1:${listening.port}/submit`, { method: "POST", body: "paid job", signal: AbortSignal.timeout(3_000) });
      expect(response.headers.get("content-encoding")).toBeNull();
      // Bun 1.3.11's native rejects matcher can block child-process I/O;
      // settle the Promise first so this tests transport behavior, not that bug.
      const streamError = await response.text().catch((error) => error);
      expect(streamError.message).toContain("original submission will not be replayed");
      expect(streamError.message).toContain("请求已发出，结果待核查，不会自动重新提交");
      expect(streamError.phase).toBe("response");
      expect(streamError.code).toBe("PROVIDER_RESPONSE_STREAM_ERROR");
      const closeDeadline = Date.now() + 1_000;
      let observed;
      do {
        const remaining = closeDeadline - Date.now();
        if (remaining <= 0) throw new Error(`Native upstream did not close within 1000ms; events=${JSON.stringify(events)}`);
        observed = await nextFixtureEvent(remaining);
      } while (observed.closedConnections < 1 || observed.requestSocketCloses < 1);
      expect(observed).toMatchObject({ requests: 1, posts: 1, connections: 1, closedConnections: 1, requestSocketCloses: 1 });
    } finally {
      // Cleanup cannot satisfy closure assertions: all evidence is read first.
      fixture.kill();
      await reader.cancel().catch(() => {});
      await fixture.exited;
      await fixtureStderr;
    }
  });
});
