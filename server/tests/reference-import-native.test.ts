import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchReferenceResource } from "../src/reference-import";

let fixtureDirectory: string;
beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "reference-import-test-"));
  const generated = Bun.spawn([Bun.which("openssl") || "C:/Program Files/Git/usr/bin/openssl.exe", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=reference-fixture.example", "-addext", "subjectAltName=DNS:reference-fixture.example", "-keyout", join(fixtureDirectory, "key.pem"), "-out", join(fixtureDirectory, "cert.pem")], { stdout: "ignore", stderr: "pipe" });
  if (await generated.exited !== 0) throw new Error(await new Response(generated.stderr).text());
});
afterAll(async () => { if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true }); });

test("native sockets pin DNS, ignore proxies, bound wire/decoded bytes, validate TLS and close on cancel", async () => {
  const script = `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import https from 'node:https';
    import dns from 'node:dns';
    import { readFileSync } from 'node:fs';
    import { gzipSync } from 'node:zlib';
    import { requestPinned, fetchPublicResource } from ${JSON.stringify(new URL("../src/reference-import/public-fetch.mjs", import.meta.url).href)};
    const received = [];
    const sockets = new Set();
    const payload = Buffer.from([137,80,78,71,13,10,26,10,0,255,128,1]);
    const handler = (req, res) => {
      received.push({ path: req.url, host: req.headers.host, headers: req.headers });
      res.setHeader('content-type', req.url.startsWith('/image') ? 'image/png' : 'text/html');
      if (req.url === '/large-length') { res.setHeader('content-length', '4097'); res.end('x'); }
      else if (req.url === '/large-wire') { res.write(Buffer.alloc(80)); res.end(Buffer.alloc(80)); }
      else if (req.url === '/gzip-bomb') { res.setHeader('content-encoding', 'gzip'); res.end(gzipSync(Buffer.alloc(4097, 65))); }
      else if (req.url === '/image-gzip') { res.setHeader('content-encoding', 'gzip'); res.end(gzipSync(payload)); }
      else if (req.url === '/wrong-type') { res.setHeader('content-type', 'application/json'); res.end('{}'); }
      else if (req.url === '/wrong-encoding') { res.setHeader('content-encoding', 'compress'); res.end('x'); }
      else if (req.url === '/wait') { /* abort closes the socket */ }
      else if (req.url === '/redirect-private') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); }
      else if (req.url === '/redirect-dns-private') { res.writeHead(302, { location: 'http://private.example/' }); res.end(); }
      else if (req.url === '/redirect-loop') { res.writeHead(302, { location: '/redirect-loop' }); res.end(); }
      else if (req.url === '/redirect-once') { res.writeHead(302, { location: '/done' }); res.end(); }
      else if (req.url === '/error') { res.writeHead(403); res.end('sensitive message'); }
      else res.end('<html>fixed IP</html>');
    };
    const server = http.createServer(handler);
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const target = path => new URL('http://reference-fixture.example:' + port + path);
    const fixed = { address: '127.0.0.1', family: 4 };
    const opts = { kind: 'html', maxBytes: 128, signal: AbortSignal.timeout(3000) };
    let systemLookups = 0;
    const originalLookup = dns.lookup;
    // If Node ignores the pinned lookup and performs DNS again, this hostile
    // resolver points elsewhere and the real fixture request will fail.
    dns.lookup = (...args) => { systemLookups++; const callback = args.at(-1); callback(null, '127.0.0.2', 4); };
    try {
      const result = await requestPinned(target('/ok?signed=secret'), fixed, opts);
      assert.equal(result.bytes.toString(), '<html>fixed IP</html>');
      assert.equal(systemLookups, 0);
      assert.equal(received[0].host, 'reference-fixture.example:' + port);
      assert.equal(received[0].path, '/ok?signed=secret');
      for (const header of ['cookie', 'authorization', 'proxy-authorization', 'referer']) assert.equal(received[0].headers[header], undefined);
      for (const path of ['/large-length','/large-wire','/gzip-bomb']) await assert.rejects(requestPinned(target(path), fixed, opts), { code: 'BODY_TOO_LARGE' });
      await assert.rejects(requestPinned(target('/wrong-type'), fixed, opts), { code: 'UNSUPPORTED_TYPE' });
      await assert.rejects(requestPinned(target('/wrong-encoding'), fixed, opts), { code: 'UNSUPPORTED_ENCODING' });
      await assert.rejects(requestPinned(target('/error'), fixed, opts), { code: 'REMOTE_HTTP_ERROR' });
      const image = await requestPinned(target('/image-gzip'), fixed, { ...opts, kind: 'image' });
      assert.deepEqual(image.bytes, payload);
      await assert.rejects(requestPinned(target('/wait'), fixed, { ...opts, signal: AbortSignal.timeout(100) }));
      // Exercise the complete redirect state machine over real HTTP. This
      // fixture-only connector routes the verified public address to our local
      // test server; production never replaces Agent.createConnection.
      const originalConnect = http.Agent.prototype.createConnection;
      const pinnedAddresses = [];
      http.Agent.prototype.createConnection = function(options, callback) {
        const pinnedLookup = options.lookup;
        return originalConnect.call(this, { ...options, port, lookup(host, config, done) {
          pinnedLookup(host, config, (error, address, family) => {
            if (error) return done(error);
            pinnedAddresses.push(address); assert.equal(address, '8.8.8.8');
            done(null, '127.0.0.1', 4);
          });
        } }, callback);
      };
      let dnsQueries = [];
      const resolver = async (host) => { dnsQueries.push(host); return [{ address: host === 'private.example' ? '10.0.0.1' : '8.8.8.8', family: 4 }]; };
      try {
        await assert.rejects(fetchPublicResource('http://public.example/redirect-private', opts, resolver), { code: 'UNSAFE_ADDRESS' });
        assert.equal(received.at(-1).path, '/redirect-private');
        await assert.rejects(fetchPublicResource('http://public.example/redirect-dns-private', opts, resolver), { code: 'UNSAFE_ADDRESS' });
        assert.equal(received.at(-1).path, '/redirect-dns-private');
        assert.ok(dnsQueries.includes('private.example'));
        const before = received.length;
        await assert.rejects(fetchPublicResource('http://public.example/redirect-loop', opts, resolver), { code: 'TOO_MANY_REDIRECTS' });
        assert.equal(received.length - before, 4);
        const final = await fetchPublicResource('http://public.example/redirect-once', opts, resolver);
        assert.equal(final.finalUrl, 'http://public.example/done');
        assert.equal(final.bytes.toString(), '<html>fixed IP</html>');
        // A DNS answer changing after its first resolution never gets a second
        // lookup during the request: the fixture sees exactly one resolution.
        let rebindLookups = 0;
        await fetchPublicResource('http://public.example/done', opts, async () => [{ address: ++rebindLookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]);
        assert.equal(rebindLookups, 1);
        assert.ok(pinnedAddresses.length >= 9);
      } finally { http.Agent.prototype.createConnection = originalConnect; }
    } finally { dns.lookup = originalLookup; for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
    const secure = https.createServer({ key: readFileSync(${JSON.stringify(join(fixtureDirectory, "key.pem"))}), cert: readFileSync(${JSON.stringify(join(fixtureDirectory, "cert.pem"))}) }, handler);
    const sni = [];
    secure.on('secureConnection', socket => sni.push(socket.servername));
    await new Promise(resolve => secure.listen(0, '127.0.0.1', resolve));
    try {
      const securePort = secure.address().port;
      const result = await requestPinned(new URL('https://reference-fixture.example:' + securePort + '/ok'), fixed, opts);
      assert.equal(result.bytes.toString(), '<html>fixed IP</html>');
      assert.equal(sni[0], 'reference-fixture.example');
      const before = received.length;
      await assert.rejects(requestPinned(new URL('https://wrong-name.example:' + securePort + '/ok'), fixed, opts), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
      assert.equal(received.length, before);
    } finally { secure.closeAllConnections(); await new Promise(resolve => secure.close(resolve)); }
    console.log(JSON.stringify({ fixedIp: true, noProxyOrSecrets: true, dualLimits: true, originalBytes: true, redirectsValidated: true, rebindingPinned: true, tlsIdentity: true, cancelled: true }));
  `;
  const env: Record<string, string | undefined> = { ...process.env, NODE_EXTRA_CA_CERTS: join(fixtureDirectory, "cert.pem"), HTTP_PROXY: "http://user:pass@127.0.0.1:1", HTTPS_PROXY: "http://user:pass@127.0.0.1:1", NODE_USE_ENV_PROXY: "1" };
  delete env.NODE_OPTIONS; delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  const child = Bun.spawn([Bun.which("node")!, "--input-type=module", "-e", script], { stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual({ fixedIp: true, noProxyOrSecrets: true, dualLimits: true, originalBytes: true, redirectsValidated: true, rebindingPinned: true, tlsIdentity: true, cancelled: true });
}, 20_000);

test("production worker refuses a mixed/private destination and handles pre-abort without network", async () => {
  await expect(fetchReferenceResource("https://127.0.0.1/image.png", "image", new AbortController().signal)).rejects.toMatchObject({ code: "UNSAFE_ADDRESS" });
  await expect(fetchReferenceResource("https://example.com/", "html", AbortSignal.abort())).rejects.toBeDefined();
});
