import { expect, test } from "bun:test";
import express from "express";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { S3Client } from "@aws-sdk/client-s3";
import { createAssetsRouter } from "../src/routes/assets";
import { ObjectStorage } from "../src/object-storage";
import { loadConfig } from "../src/config";
import type { Database } from "../src/db";
import type { AuthenticatedRequest } from "../src/types";

const id = "10000000-0000-4000-8000-000000000001";
const etag = '"original-media"';
const lastModified = "Wed, 21 Oct 2026 10:00:00 GMT";
const video = Buffer.alloc(32_768, 0x61);
// An ISO BMFF ftyp box, followed by opaque fixture data. No encoder or paid API.
Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex").copy(video);
type StorageCall = { method: string; range?: string; ifMatch?: string };

async function serve(options: {
  bytes?: Buffer; declared?: string;
  intercept?: (call: StorageCall, response: ServerResponse) => boolean;
}, run: (url: string, observed: StorageCall[]) => Promise<void>) {
  const bytes = options.bytes ?? video;
  const observed: StorageCall[] = [];
  const upstream = createServer((request, response) => {
    const call = { method: request.method!, range: request.headers.range, ifMatch: request.headers["if-match"] };
    observed.push(call);
    if (options.intercept?.(call, response)) return;
    if (call.ifMatch && call.ifMatch !== etag) {
      response.writeHead(412, { "Content-Type": "application/xml" });
      response.end("<Error><Code>PreconditionFailed</Code></Error>"); return;
    }
    response.setHeader("ETag", etag);
    response.setHeader("Last-Modified", lastModified);
    response.setHeader("Content-Type", "image/jpeg"); // Deliberately wrong S3 metadata.
    response.setHeader("Accept-Ranges", "bytes");
    if (call.method === "HEAD") {
      response.setHeader("Content-Length", bytes.length); response.end(); return;
    }
    // The application must forward a normalized, bounded, single S3 range.
    const match = call.range?.match(/^bytes=(\d+)-(\d+)$/);
    if (call.range && !match) { response.writeHead(400).end(); return; }
    const start = match ? Number(match[1]) : 0, end = match ? Number(match[2]) : bytes.length - 1;
    if (match && (start > end || end >= bytes.length)) { response.writeHead(416).end(); return; }
    if (match) {
      response.statusCode = 206;
      response.setHeader("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
    }
    response.setHeader("Content-Length", end - start + 1);
    response.end(bytes.subarray(start, end + 1));
  });
  upstream.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => upstream.once("listening", resolve));
  const storage = new ObjectStorage(loadConfig({ DATABASE_URL: "unused", REDIS_URL: "unused",
    S3_ENDPOINT: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    S3_BUCKET: "range-fixture", S3_ACCESS_KEY_ID: "fixture", S3_SECRET_ACCESS_KEY: "fixture",
  }));
  const db = { query: async (_sql: string, values: unknown[]) => ({ rows: values[1] === "employee-a"
    ? [{ object_key: "original", mime_type: options.declared ?? "image/jpeg", filename: "素材.mp4" }] : [] }) };
  const app = express();
  app.use((request, _response, next) => {
    (request as AuthenticatedRequest).auth = { id: request.header("x-test-owner") || "employee-a", role: "designer", departmentId: null } as AuthenticatedRequest["auth"];
    next();
  });
  app.use("/api/assets", createAssetsRouter(db as unknown as Database, storage));
  app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (!response.headersSent && !response.destroyed) response.status(500).json({ error: error.message });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/assets/${id}/content`, observed); }
  finally {
    server.closeAllConnections(); upstream.closeAllConnections();
    const clients = storage as unknown as { client: S3Client; publicClient: S3Client };
    clients.client.destroy(); clients.publicClient.destroy();
    await Promise.all([server, upstream].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
}

test("media seeks return exact single ranges through the real S3 SDK without reading the full object", async () => {
  await serve({}, async (url, observed) => {
    const response = await fetch(url, { headers: { Range: "bytes=16000-16127" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 16000-16127/32768");
    expect(response.headers.get("content-length")).toBe("128");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-disposition")).toStartWith("inline;");
    expect(response.headers.get("etag")).toBe(etag);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(video.subarray(16000, 16128));
    expect(observed).toEqual([
      { method: "HEAD", range: undefined, ifMatch: undefined },
      { method: "GET", range: "bytes=0-8191", ifMatch: etag },
      { method: "GET", range: "bytes=16000-16127", ifMatch: etag },
    ]);
  });
});

test("HEAD ignores Range, sniffs only the prefix and retains full content metadata", async () => {
  await serve({}, async (url, observed) => {
    const response = await fetch(url, { method: "HEAD", headers: { Range: "bytes=16000-16127" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("content-length")).toBe("32768");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(await response.text()).toBe("");
    expect(observed.filter(call => call.method === "GET").map(call => call.range)).toEqual(["bytes=0-8191"]);
  });
});

test("unsatisfiable ranges respond 416 with total length and do not open a content stream", async () => {
  await serve({}, async (url, observed) => {
    for (const range of ["bytes=32768-", "bytes=10-9", "bytes=-0"]) {
      const response = await fetch(url, { headers: { Range: range } });
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */32768");
      expect(await response.text()).toBe("");
    }
    expect(observed.map(call => call.method)).toEqual(["HEAD", "HEAD", "HEAD"]);
  });
});

test("opening, open-ended, suffix and oversized suffix ranges preserve inclusive byte boundaries", async () => {
  await serve({}, async (url, observed) => {
    const cases = [
      { range: "bytes=0-1", start: 0, end: 1, reads: ["bytes=0-8191", "bytes=0-1"] },
      { range: "bytes=0-9000", start: 0, end: 9000, reads: ["bytes=0-9000"] },
      { range: "bytes=32760-", start: 32760, end: 32767, reads: ["bytes=0-8191", "bytes=32760-32767"] },
      { range: "bytes=-5", start: 32763, end: 32767, reads: ["bytes=0-8191", "bytes=32763-32767"] },
      { range: "bytes=-40000", start: 0, end: 32767, reads: ["bytes=0-32767"] },
      { range: "bytes=32760-999999", start: 32760, end: 32767, reads: ["bytes=0-8191", "bytes=32760-32767"] },
      { range: "BYTES=0-0", start: 0, end: 0, reads: ["bytes=0-8191", "bytes=0-0"] },
    ];
    for (const item of cases) {
      const before = observed.length;
      const response = await fetch(url, { headers: { Range: item.range } });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(`bytes ${item.start}-${item.end}/32768`);
      expect(response.headers.get("content-length")).toBe(String(item.end - item.start + 1));
      expect(response.headers.get("content-type")).toBe("video/mp4");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(video.subarray(item.start, item.end + 1));
      expect(observed.slice(before).filter(call => call.method === "GET").map(call => call.range)).toEqual(item.reads);
    }
  });
});

test("multiple, malformed and unknown-unit ranges deliberately fall back to an unchanged full 200 response", async () => {
  await serve({}, async (url, observed) => {
    for (const range of ["bytes=0-1,100-101", "bytes=99999-,88888-", "bytes=wat", "bytes=1oops-2", "items=0-1"]) {
      const response = await fetch(url, { headers: { Range: range } });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-range")).toBeNull();
      expect(response.headers.get("content-length")).toBe("32768");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(video);
    }
    expect(observed.filter(call => call.method === "GET").map(call => call.range)).toEqual(Array(5).fill(undefined));
  });
});

test("If-Range requires an exact strong ETag or Last-Modified date, otherwise sends the full representation", async () => {
  await serve({}, async url => {
    for (const [validator, status] of [
      [etag, 206], [lastModified, 206], [`W/${etag}`, 200], ['"old"', 200],
      ["Thu, 22 Oct 2026 10:00:00 GMT", 200], ["Tue, 20 Oct 2026 10:00:00 GMT", 200], ["invalid-date", 200],
    ] as const) {
      const response = await fetch(url, { headers: { Range: "bytes=16000-16003", "If-Range": validator } });
      expect(response.status).toBe(status);
      expect(response.headers.get("last-modified")).toBe(lastModified);
      expect(response.headers.get("content-range")).toBe(status === 206 ? "bytes 16000-16003/32768" : null);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(status === 206 ? video.subarray(16000, 16004) : video);
    }
    const staleUnsatisfiable = await fetch(url, { headers: { Range: "bytes=99999-", "If-Range": '"old"' } });
    expect(staleUnsatisfiable.status).toBe(200);
    expect(Buffer.from(await staleUnsatisfiable.arrayBuffer())).toEqual(video);
  });
});

test("authorization still precedes range metadata and If-None-Match wins over Range for GET and HEAD", async () => {
  await serve({}, async (url, observed) => {
    for (const method of ["GET", "HEAD"]) {
      const forbidden = await fetch(url, { method, headers: { Range: "bytes=99999-", "If-None-Match": etag, "x-test-owner": "employee-b" } });
      expect(forbidden.status).toBe(404);
      expect(forbidden.headers.get("etag")).toBeNull();
      expect(forbidden.headers.get("content-range")).toBeNull();
      expect(await forbidden.text()).toBe("");
    }
    expect(observed).toHaveLength(0);
    for (const method of ["GET", "HEAD"]) {
      const cached = await fetch(url, { method, headers: { Range: "bytes=99999-", "If-None-Match": `"other", W/${etag}` } });
      expect(cached.status).toBe(304);
      expect(cached.headers.get("etag")).toBe(etag);
      expect(cached.headers.get("vary")).toBe("Cookie");
      expect(cached.headers.get("cache-control")).toBe("private, no-cache");
      expect(cached.headers.get("content-range")).toBeNull();
      expect(await cached.text()).toBe("");
    }
    expect(observed.map(call => call.method)).toEqual(["HEAD", "HEAD"]);
  });
});

test("noninitial audio segments use the real file header while unknown content and explicit downloads stay attachments", async () => {
  const wav = Buffer.alloc(20_000, 0);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVE", 8);
  await serve({ bytes: wav }, async url => {
    const audio = await fetch(url, { headers: { Range: "bytes=10000-10019" } });
    expect(audio.status).toBe(206);
    expect(audio.headers.get("content-type")).toBe("audio/wav");
    expect(audio.headers.get("content-disposition")).toStartWith("inline;");
    expect(Buffer.from(await audio.arrayBuffer())).toEqual(wav.subarray(10000, 10020));
    const download = await fetch(`${url}?download=1`, { headers: { Range: "bytes=10000-10019" } });
    expect(download.status).toBe(206);
    expect(download.headers.get("content-disposition")).toStartWith("attachment;");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    await download.arrayBuffer();
  });
  const markup = Buffer.from('<svg onload="alert(1)">active content</svg>');
  await serve({ bytes: markup, declared: "image/png" }, async url => {
    const response = await fetch(url, { headers: { Range: "bytes=10-19" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toStartWith("attachment;");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(markup.subarray(10, 20));
  });
});

test("zero-byte objects do not produce invalid prefix reads and reject unsatisfiable ranges", async () => {
  await serve({ bytes: Buffer.alloc(0), declared: "text/plain" }, async (url, observed) => {
    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200); expect(head.headers.get("content-length")).toBe("0");
    expect(head.headers.get("content-type")).toStartWith("text/plain");
    const ranged = await fetch(url, { headers: { Range: "bytes=0-" } });
    expect(ranged.status).toBe(416); expect(ranged.headers.get("content-range")).toBe("bytes */0");
    const full = await fetch(url);
    expect(full.status).toBe(200); expect(await full.text()).toBe("");
    expect(observed.filter(call => call.method === "GET")).toHaveLength(1);
  });
});

test("an S3 server ignoring Range cannot turn a full stream into a false 206 or bypass prefix inspection", async () => {
  await serve({ intercept: (call, response) => {
    if (call.method !== "GET") return false;
    response.writeHead(200, { "Content-Length": video.length, ETag: etag }); response.end(video); return true;
  } }, async (url, observed) => {
    const response = await fetch(url, { headers: { Range: "bytes=16000-16127" } });
    expect(response.status).toBe(500);
    expect(response.headers.get("content-range")).toBeNull();
    await response.arrayBuffer();
    expect(observed.filter(call => call.method === "GET")).toHaveLength(1);
  });
});

test("S3 If-Match pins prefix and range reads to the HEAD representation", async () => {
  await serve({ intercept: (call, response) => {
    if (call.range !== "bytes=16000-16127") return false;
    expect(call.ifMatch).toBe(etag);
    response.writeHead(412, { "Content-Type": "application/xml" });
    response.end("<Error><Code>PreconditionFailed</Code><Message>Object changed</Message></Error>"); return true;
  } }, async (url, observed) => {
    const response = await fetch(url, { headers: { Range: "bytes=16000-16127" } });
    expect(response.status).toBe(500);
    expect(response.headers.get("content-range")).toBeNull();
    await response.arrayBuffer();
    expect(observed.filter(call => call.method === "GET").map(call => call.ifMatch)).toEqual([etag, etag]);
  });
});

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}

async function within(promise: Promise<void>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 2_000);
    })]);
  } finally { clearTimeout(timer); }
}

test("client cancellation aborts pending HEAD, prefix headers, prefix sniffing and target range requests", async () => {
  for (const phase of ["head", "prefix-headers", "prefix-body", "range-headers", "range-body"] as const) {
    const started = deferred(), closed = deferred(), received = deferred();
    await serve({ intercept: (call, response) => {
      const selected = phase === "head" ? call.method === "HEAD"
        : phase.startsWith("prefix") ? call.range === "bytes=0-8191" : call.range === "bytes=16000-16127";
      if (!selected) return false;
      // Observe the actual socket: Bun need not emit ServerResponse.close before headers.
      response.socket!.once("close", closed.resolve);
      if (phase.endsWith("body")) {
        const prefix = phase === "prefix-body";
        response.writeHead(206, { "Content-Length": prefix ? 8192 : 128,
          "Content-Range": prefix ? "bytes 0-8191/32768" : "bytes 16000-16127/32768", ETag: etag });
        response.write(prefix ? video.subarray(0, 2) : video.subarray(16000, 16002));
      }
      started.resolve(); return true; // Keep the upstream request open until cancelled.
    } }, async (url, observed) => {
      const request = httpRequest(url, { headers: { Range: "bytes=16000-16127" } }, response => {
        response.once("data", received.resolve); response.on("error", () => {});
      });
      request.on("error", () => {}); request.end();
      try {
        await within(started.promise, `${phase} started`);
        if (phase === "range-body") await within(received.promise, "downstream body received");
        request.destroy();
        await within(closed.promise, `${phase} upstream released`);
        expect(observed).toHaveLength(phase === "head" ? 1 : phase.startsWith("prefix") ? 2 : 3);
      } finally { request.destroy(); }
    });
  }
});
