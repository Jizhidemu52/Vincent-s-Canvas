import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, get } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/** Test-only trusted OA, bound exclusively to loopback. Never bypass TLS checks. */
export async function startOaHttpsFixture(options: { port?: number; openssl?: string } = {}) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("OA tests refuse globally disabled TLS validation");
  const port = options.port ?? Number(process.env.OA_TEST_HTTPS_PORT ?? 9443);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("OA_TEST_HTTPS_PORT must be a valid local port");
  const directory = await mkdtemp(join(tmpdir(), "canvas-oa-https-"));
  const keyPath = join(directory, "localhost.key");
  const certPath = join(directory, "localhost.crt");
  const openssl = options.openssl ?? process.env.OPENSSL_BIN ?? (
    process.platform === "win32" && existsSync("C:/Program Files/Git/usr/bin/openssl.exe")
      ? "C:/Program Files/Git/usr/bin/openssl.exe" : "openssl"
  );
  const cleanup = async () => {
    const absolute = resolve(directory);
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !absolute.split(sep).at(-1)?.startsWith("canvas-oa-https-")) {
      throw new Error("Refusing to remove an unexpected OA fixture directory");
    }
    await rm(absolute, { recursive: true, force: true });
  };
  try {
    const certificate = Bun.spawn([openssl, "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "2", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign",
      "-addext", "extendedKeyUsage=serverAuth"], { stdout: "pipe", stderr: "pipe" });
    const diagnostic = new Response(certificate.stderr).text();
    if (await certificate.exited !== 0) throw new Error(`Unable to create OA test certificate: ${await diagnostic}`);
    await diagnostic;
    const runId = randomUUID();
    const employees = ["a", "b"].map(label => ({
      subject: `oa-fixture-${runId}-${label}`,
      // Equal display names deliberately prove identity never links by name.
      name: "同名 OA 员工",
      token: `oa-fixture-token-${randomUUID()}`,
    }));
    const requests: Array<{ authorized: boolean; subject?: string }> = [];
    const server = createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (request, response) => {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      if (request.method !== "GET" || request.url !== "/api/organization/user/info_login") {
        response.writeHead(404).end(JSON.stringify({ errcode: 404 })); return;
      }
      const employee = employees.find(item => request.headers.authorization === `Bearer ${item.token}`);
      requests.push({ authorized: Boolean(employee), ...(employee ? { subject: employee.subject } : {}) });
      if (!employee) { response.writeHead(401).end(JSON.stringify({ errcode: 401 })); return; }
      response.end(JSON.stringify({ errcode: 0, data: { userid: employee.subject, name: employee.name } }));
    });
    server.listen(port, "127.0.0.1");
    await new Promise<void>((done, reject) => { server.once("listening", done); server.once("error", reject); });
    const actualPort = (server.address() as { port: number }).port;
    const endpoint = `https://127.0.0.1:${actualPort}/api/organization/user/info_login`;
    return {
      endpoint, certPath, employees, requests,
      trustedEnvironment: (environment: NodeJS.ProcessEnv = process.env) => ({
        ...environment, SSL_CERT_FILE: certPath, NODE_EXTRA_CA_CERTS: certPath, NODE_TLS_REJECT_UNAUTHORIZED: "1",
      }),
      close: async () => {
        try {
          server.closeAllConnections();
          await new Promise<void>((done, reject) => server.close(error => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : done()));
        } finally { await cleanup(); }
      },
    };
  } catch (error) { await cleanup(); throw error; }
}

async function selfTest() {
  const fixture = await startOaHttpsFixture({ port: 0 });
  try {
    const request = (ca?: Buffer) => new Promise<number>((done, reject) => {
      get(fixture.endpoint, { ...(ca ? { ca } : {}) }, response => { response.resume(); done(response.statusCode!); }).once("error", reject);
    });
    await assert.rejects(request());
    assert.equal(await request(await readFile(fixture.certPath)), 401);
    // Bun reads certificate environment variables on startup. Exercise exactly
    // the same child-process trust mechanism used by the real index.ts test.
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e",
      "const r=await fetch(process.env.OA_FIXTURE_URL); if(r.status!==401)throw new Error('Unexpected fixture status')"], {
      env: { ...fixture.trustedEnvironment(), OA_FIXTURE_URL: fixture.endpoint }, stdout: "pipe", stderr: "pipe",
    });
    const diagnostic = new Response(child.stderr).text();
    assert.equal(await child.exited, 0, await diagnostic);
    console.log(JSON.stringify({ trustedHttpsFixture: "passed", untrustedCertificate: "rejected", globalTlsBypass: false }));
  } finally { await fixture.close(); }
}

if (import.meta.main) {
  if (process.argv.includes("--self-test")) await selfTest();
  else {
    const fixture = await startOaHttpsFixture();
    console.log(JSON.stringify({ endpoint: fixture.endpoint, caCertificate: fixture.certPath }));
    const stop = async () => { await fixture.close(); process.exit(0); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  }
}
