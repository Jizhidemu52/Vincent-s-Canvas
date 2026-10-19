import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createConnection, createServer as createTcpServer, type Socket } from "node:net";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { fetchProviderSubmission } from "../src/provider-submission-transport";
import { startNativeNetworkFixture } from "./fixtures/native-network-fixture";

let fixtureDirectory: string;
let certificate: string;
let privateKey: string;
let nativeProxy: Awaited<ReturnType<typeof startNativeNetworkFixture>> | undefined;
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
  // Native fixture readiness separates process/filesystem startup from the
  // CONNECT protocol deadline and avoids Bun's HTTP socket compatibility layer.
  nativeProxy = await startNativeNetworkFixture({ cert: certificate, key: privateKey });
});

afterAll(async () => {
  await nativeProxy?.close();
  for (const key of proxyKeys) {
    if (savedProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedProxyEnv[key];
  }
  if (savedExtraCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
  else process.env.NODE_EXTRA_CA_CERTS = savedExtraCa;
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
});

type ConnectionAttempt = { attempt: number; phase: "initial_tls" | "http_started"; elapsedMs: number; connectMs?: number; code?: string };
type ClientHello = { recordBytes: number; supportedGroups: number[]; keyShareGroups: number[] };
type DeadlineFixtureResult = {
  finished: boolean;
  exitCode: number | null;
  connections: number;
  endedConnections: number;
  closedConnections: number;
  closedBeforeRequest: number;
  requests: number;
  posts: number;
  connects: number;
  baselineHello?: ClientHello;
  clientHellos: ClientHello[];
  tlsProtocols: string[];
  receivedBodyBytes: number;
  receivedBodySha256?: string;
  contentLength?: number;
  body: string;
  head: { status?: number; connectionAttempts?: ConnectionAttempt[]; error?: { code: string; phase: string; attempts: number; connectionAttempts: ConnectionAttempt[] } } | null;
};

async function runConnectionDeadlineFixture(mode: string, connectTimeoutMs?: unknown, watchdogMs = 3_000): Promise<DeadlineFixtureResult> {
  // The native fixture observes pending proxy sockets independently of Bun.
  // It never contacts a provider: target, proxy and worker are all loopback.
  const script = `
    import { createServer as createHttpsServer } from 'node:https';
    import { createServer as createHttpServer } from 'node:http';
    import { createServer as createTcpServer, createConnection } from 'node:net';
    import { connect as connectTls } from 'node:tls';
    import { spawn } from 'node:child_process';
    import { createHash } from 'node:crypto';
    import { fileURLToPath } from 'node:url';
    let raw = ''; for await (const chunk of process.stdin) raw += chunk;
    const config = JSON.parse(raw);
    const counts = { connections: 0, endedConnections: 0, closedConnections: 0, closedBeforeRequest: 0, requests: 0, posts: 0, connects: 0 };
    const clientHellos = [], tlsProtocols = [];
    let receivedBodyBytes = 0, receivedBodySha256, contentLength;
    let baselineHello, resolveBaselineHello;
    const sockets = new Set();
    const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    const compactHello = config.mode === 'compact-client-hello';
    const backend = createHttpsServer({ cert: config.cert, key: config.key, ...(compactHello ? { minVersion: 'TLSv1.3' } : {}) }, (request, response) => {
      counts.requests++;
      if (request.method === 'POST') counts.posts++;
      tlsProtocols.push(request.socket.getProtocol());
      counts.closedBeforeRequest = counts.closedConnections;
      contentLength = Number(request.headers['content-length']);
      const received = [];
      request.on('data', chunk => received.push(chunk));
      request.on('end', () => {
        const bytes = Buffer.concat(received);
        receivedBodyBytes += bytes.length;
        receivedBodySha256 = createHash('sha256').update(bytes).digest('hex');
        setTimeout(() => {
        if (config.mode === 'slow-close') { request.socket.destroy(); return; }
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.write('slow ');
        setTimeout(() => response.end('response'), 300);
        }, 450);
      });
    });
    const backendPort = await listen(backend);
    function pipeToBackend(socket, established = false, head = Buffer.alloc(0)) {
      const upstream = createConnection({ host: '127.0.0.1', port: backendPort }, () => {
        if (established) socket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket);
      });
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      socket.on('close', () => upstream.destroy());
    }
    const isProxy = config.mode.startsWith('proxy-');
    const front = isProxy ? createHttpServer() : createTcpServer(socket => {
      if (compactHello) {
        // Model a path that drops a large first TLS record, without making any
        // claim about which real network component caused the production stall.
        let hello = Buffer.alloc(0);
        const readHello = chunk => {
          hello = Buffer.concat([hello, chunk]);
          if (hello.length < 5 || hello.length < 5 + hello.readUInt16BE(3)) return;
          socket.pause(); socket.removeListener('data', readHello);
          const observed = { recordBytes: 5 + hello.readUInt16BE(3), supportedGroups: [], keyShareGroups: [] };
          // Inspect the real ClientHello's supported_groups and key_share
          // extensions; no TLS encryption or handshake is implemented here.
          let offset = 5 + 4 + 2 + 32;
          offset += 1 + hello[offset];
          offset += 2 + hello.readUInt16BE(offset);
          offset += 1 + hello[offset];
          const extensionsEnd = offset + 2 + hello.readUInt16BE(offset); offset += 2;
          while (offset + 4 <= extensionsEnd) {
            const type = hello.readUInt16BE(offset), length = hello.readUInt16BE(offset + 2); offset += 4;
            const extension = hello.subarray(offset, offset + length); offset += length;
            if (type === 10) for (let index = 2; index < extension.length; index += 2) observed.supportedGroups.push(extension.readUInt16BE(index));
            if (type === 51) for (let index = 2; index + 4 <= extension.length;) {
              observed.keyShareGroups.push(extension.readUInt16BE(index));
              index += 4 + extension.readUInt16BE(index + 2);
            }
          }
          if (resolveBaselineHello) {
            const resolve = resolveBaselineHello; resolveBaselineHello = undefined;
            resolve(observed); socket.resume(); return;
          }
          clientHellos.push(observed);
          if (observed.recordBytes > 1200) { socket.resume(); return; }
          pipeToBackend(socket, false, hello);
        };
        socket.on('data', readHello);
      }
      else if (['slow-close', 'large-body'].includes(config.mode) || (['recover', 'late-tls'].includes(config.mode) && counts.connections > 1)) pipeToBackend(socket);
      else if (config.mode === 'late-tls') {
        const pending = [];
        const holdClientHello = chunk => pending.push(chunk);
        socket.on('data', holdClientHello);
        const lateHandshake = setTimeout(() => {
          if (socket.destroyed) return;
          socket.pause(); socket.removeListener('data', holdClientHello);
          pipeToBackend(socket, false, Buffer.concat(pending));
        }, 450);
        socket.once('close', () => clearTimeout(lateHandshake));
      }
      else socket.resume(); // Read ClientHello but never complete TLS.
    });
    front.prependListener('connection', socket => {
      counts.connections++; sockets.add(socket);
      socket.on('error', () => {});
      // HTTP servers intentionally create allowHalfOpen sockets. Record the
      // client's real EOF, then acknowledge it; fixture cleanup comes later.
      socket.on('end', () => { counts.endedConnections++; socket.end(); });
      socket.on('close', () => { counts.closedConnections++; sockets.delete(socket); });
    });
    if (isProxy) front.on('connect', (_request, socket, head) => {
      counts.connects++;
      if (config.mode === 'proxy-recover' && counts.connects > 1) pipeToBackend(socket, true, head);
      else {
        if (config.mode === 'proxy-tls-blackhole') socket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
        socket.resume(); // CONNECT or target TLS remains pending.
      }
    });
    const frontPort = await listen(front);
    if (compactHello) {
      // Independently capture native OpenSSL's unmodified defaults so removing
      // any supported group in the worker cannot satisfy the size regression.
      let captureDeadline;
      const captured = new Promise((resolve, reject) => {
        resolveBaselineHello = resolve;
        captureDeadline = setTimeout(() => reject(new Error('Native ClientHello capture timed out')), 2000);
      });
      const baseline = connectTls({ host: '127.0.0.1', port: frontPort });
      baseline.on('error', () => {});
      baselineHello = await captured.finally(() => clearTimeout(captureDeadline));
      baseline.destroy();
    }
    const env = { ...process.env };
    for (const key of ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy']) delete env[key];
    if (isProxy) env.HTTPS_PROXY = 'http://fixture-user:fixture-secret@127.0.0.1:' + frontPort;
    const requestBody = config.mode === 'large-body' ? Buffer.alloc(1024 * 1024) : Buffer.from('private paid job');
    if (config.mode === 'large-body') for (let index = 0; index < requestBody.length; index++) requestBody[index] = index % 251;
    const input = { url: 'https://127.0.0.1:' + (isProxy ? backendPort : frontPort) + '/submit', method: 'POST', headers: { authorization: 'Bearer fixture-model-key' }, body: requestBody.toString('base64') };
    if (Object.hasOwn(config, 'connectTimeoutMs')) input.connectTimeoutMs = config.connectTimeoutMs;
    const child = spawn(process.execPath, [fileURLToPath(config.worker)], { env, stdio: ['pipe','pipe','ignore'] });
    let output = '', finished = true;
    child.stdout.on('data', chunk => output += chunk);
    child.stdin.end(JSON.stringify(input));
    const watchdog = setTimeout(() => { finished = false; child.kill(); }, config.watchdogMs);
    const exitCode = await new Promise(resolve => child.once('close', resolve));
    clearTimeout(watchdog);
    // Observe TCP closure before cleanup can satisfy any closure assertion.
    await new Promise(resolve => setTimeout(resolve, 50));
    const separator = output.indexOf('\\n');
    const result = { finished, exitCode, ...counts, baselineHello, clientHellos, tlsProtocols, receivedBodyBytes, receivedBodySha256, contentLength, head: separator < 0 ? null : JSON.parse(output.slice(0, separator)), body: separator < 0 ? '' : output.slice(separator + 1) };
    for (const socket of sockets) socket.destroy();
    backend.closeAllConnections(); backend.close(); front.close();
    process.stdout.end(JSON.stringify(result) + '\\n');
  `;
  const input = { mode, cert: certificate, key: privateKey, worker: new URL("../src/provider-submission-worker.mjs", import.meta.url).href, watchdogMs, ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }) };
  const fixture = Bun.spawn([Bun.which("node")!, "--input-type=module", "-e", script], { stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const stdout = new Response(fixture.stdout).text();
  const stderr = new Response(fixture.stderr).text();
  const exitCode = await fixture.exited;
  if (exitCode !== 0) throw new Error(`Connection deadline fixture failed (${exitCode}): ${await stderr}`);
  return JSON.parse(await stdout);
}

describe("provider submission transport", () => {
  test("authorized TLS submits one exact 1MiB HTTP body", async () => {
    const result = await runConnectionDeadlineFixture("large-body", 500);
    const expected = Buffer.alloc(1024 * 1024);
    for (let index = 0; index < expected.length; index++) expected[index] = index % 251;
    expect(result.finished).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.head?.status).toBe(200);
    expect(result.requests).toBe(1);
    expect(result.posts).toBe(1);
    expect(result.connections).toBe(1);
    expect(result.contentLength).toBe(expected.length);
    expect(result.receivedBodyBytes).toBe(expected.length);
    expect(result.receivedBodySha256).toBe(createHash("sha256").update(expected).digest("hex"));
    expect(result.tlsProtocols).toEqual(["TLSv1.3"]);
  });

  test("a compact ClientHello crosses a size-sensitive path without removing PQC groups or downgrading TLS", async () => {
    const result = await runConnectionDeadlineFixture("compact-client-hello", 500);
    expect(result.baselineHello!.recordBytes).toBeGreaterThan(1200);
    expect(result.baselineHello!.keyShareGroups).toContain(4588); // X25519MLKEM768
    expect(result.finished).toBe(true);
    expect(result.head?.error).toBeUndefined();
    expect(result.head?.status).toBe(200);
    expect(result.body).toBe("slow response");
    expect(result.requests).toBe(1);
    expect(result.posts).toBe(1);
    expect(result.head!.connectionAttempts).toHaveLength(1);
    expect(result.clientHellos).toHaveLength(1);
    expect(result.clientHellos[0]!.recordBytes).toBeLessThanOrEqual(1200);
    expect(result.clientHellos[0]!.supportedGroups).toEqual(result.baselineHello!.supportedGroups);
    expect(result.clientHellos[0]!.supportedGroups).toContain(4588);
    expect(result.clientHellos[0]!.keyShareGroups).not.toContain(4588);
    expect(result.tlsProtocols).toEqual(["TLSv1.3"]);
  });

  for (const mode of ["tls-blackhole", "proxy-connect-blackhole", "proxy-tls-blackhole"]) {
    test(`pre-HTTP deadline bounds ${mode}, closes its sockets and never submits or bypasses a proxy`, async () => {
      const result = await runConnectionDeadlineFixture(mode, 150);
      expect(result.finished).toBe(true);
      expect(result.head?.error).toMatchObject({ code: "PROVIDER_CONNECT_TIMEOUT", phase: "initial_tls", attempts: 2 });
      const attempts = result.head!.error!.connectionAttempts;
      expect(attempts).toHaveLength(2);
      for (const [index, attempt] of attempts.entries()) {
        expect(attempt).toMatchObject({ attempt: index + 1, phase: "initial_tls", code: "PROVIDER_CONNECT_TIMEOUT" });
        expect(attempt.elapsedMs).toBeGreaterThanOrEqual(100);
        expect(attempt.elapsedMs).toBeLessThan(1_000);
        expect(attempt.connectMs).toBeUndefined();
      }
      expect(result.connections).toBe(2);
      expect(result.endedConnections).toBe(2);
      expect(result.closedConnections).toBe(2);
      expect(result.requests).toBe(0);
      expect(result.connects).toBe(mode.startsWith("proxy-") ? 2 : 0);
      expect(JSON.stringify(attempts)).not.toMatch(/127\.0\.0\.1|fixture-user|fixture-secret|fixture-model-key|private paid job|https?:/);
    });
  }

  for (const mode of ["recover", "proxy-recover", "late-tls"]) {
    test(`pre-HTTP deadline permits only one safe reconnect for ${mode} and is cleared before a slow paid response`, async () => {
      const result = await runConnectionDeadlineFixture(mode, 150);
      expect(result.finished).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.head?.status).toBe(200);
      expect(result.body).toBe("slow response");
      expect(result.requests).toBe(1);
      expect(result.connections).toBe(2);
      expect(result.closedBeforeRequest).toBeGreaterThanOrEqual(1);
      const attempts = result.head!.connectionAttempts!;
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({ attempt: 1, phase: "initial_tls", code: "PROVIDER_CONNECT_TIMEOUT" });
      expect(attempts[1]).toMatchObject({ attempt: 2, phase: "http_started" });
      expect(attempts[1]!.code).toBeUndefined();
      expect(attempts[1]!.connectMs).toBeGreaterThanOrEqual(0);
      expect(attempts[1]!.connectMs!).toBeLessThan(150);
      expect(attempts[1]!.elapsedMs).toBeGreaterThanOrEqual(400);
      expect(result.connects).toBe(mode.startsWith("proxy-") ? 2 : 0);
    });
  }

  test("pre-HTTP deadline does not relabel or replay a paid POST that closes after the connection deadline", async () => {
    const result = await runConnectionDeadlineFixture("slow-close", 150);
    expect(result.finished).toBe(true);
    expect(result.head?.error).toMatchObject({ code: "ECONNRESET", phase: "http_started", attempts: 1 });
    expect(result.requests).toBe(1);
    expect(result.connections).toBe(1);
    const attempts = result.head!.error!.connectionAttempts;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attempt: 1, phase: "http_started", code: "ECONNRESET" });
    expect(attempts[0]!.connectMs!).toBeLessThan(150);
    expect(attempts[0]!.elapsedMs).toBeGreaterThanOrEqual(400);
  });

  test("pre-HTTP deadline rejects IPC overrides that disable or extend the production bound", async () => {
    for (const timeout of [0, 49, 10_001, "100", null]) {
      const result = await runConnectionDeadlineFixture("tls-blackhole", timeout, 800);
      expect(result.finished).toBe(true);
      expect(result.head?.error).toMatchObject({ code: "INVALID_CONNECT_TIMEOUT", phase: "preflight" });
      expect(result.head!.error!.connectionAttempts).toEqual([]);
      expect(result.connections).toBe(0);
      expect(result.requests).toBe(0);
    }
  });

  test("pre-HTTP deadline uses a bounded production default without any IPC override", async () => {
    const result = await runConnectionDeadlineFixture("recover", undefined, 14_000);
    expect(result.finished).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.requests).toBe(1);
    expect(result.connections).toBe(2);
    expect(result.head!.connectionAttempts![0]).toMatchObject({ phase: "initial_tls", code: "PROVIDER_CONNECT_TIMEOUT" });
    expect(result.head!.connectionAttempts![0]!.elapsedMs).toBeGreaterThanOrEqual(9_500);
    expect(result.head!.connectionAttempts![0]!.elapsedMs).toBeLessThan(12_000);
  }, 16_000);

  test("explicit proxy CONNECT omits model credentials and body, then submits once on authorized target TLS", async () => {
    const fixture = nativeProxy!;
    process.env.HTTPS_PROXY = "http://127.0.0.1:1";
    process.env.https_proxy = `http://proxy-user:proxy-secret@127.0.0.1:${fixture.ready.proxyPort}`;
    try {
      const response = await fetchProviderSubmission(`https://127.0.0.1:${fixture.ready.targetPort}/submit`, { method: "POST", headers: { authorization: "Bearer model-test-key" }, body: "private model prompt", signal: AbortSignal.timeout(3_000) });
      expect(await response.json()).toEqual({ id: "proxied-job" });
      const submitted = await fixture.waitFor((event) => event.event === "request", 1_000);
      const closed = await fixture.waitFor((event) => event.event === "backend_close", 1_000);
      expect(closed).toMatchObject({ requests: 1, connects: 1, connections: 1, closedConnections: 1 });
      expect(submitted.authorization).toBe("Bearer model-test-key");
      expect(submitted.proxyAuthorization).toBeUndefined();
      expect(submitted.body).toBe("private model prompt");
      const tunnels = fixture.events.filter((event) => event.event === "connect");
      expect(tunnels).toHaveLength(1);
      expect(tunnels[0]!.method).toBe("CONNECT");
      expect(tunnels[0]!.headers?.authorization).toBeUndefined();
      expect(tunnels[0]!.headers?.["proxy-authorization"]).toBe(`Basic ${Buffer.from("proxy-user:proxy-secret").toString("base64")}`);
      expect(tunnels[0]!.headBytes).toBe(0);
      expect(JSON.stringify(tunnels)).not.toContain("model-test-key");
      expect(JSON.stringify(tunnels)).not.toContain("private model prompt");
    } finally {
      delete process.env.HTTPS_PROXY;
      delete process.env.https_proxy;
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
      expect(streamError.attempts).toBe(1);
      expect(streamError.connectionAttempts).toHaveLength(1);
      expect(streamError.connectionAttempts[0].phase).toBe("http_started");
      expect(streamError.connectionAttempts[0].connectMs).toBeGreaterThanOrEqual(0);
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
