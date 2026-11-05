import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { ObjectStorage } from "../src/object-storage";
import { createTemporaryMediaFile } from "../src/media-file";
import { deferred, until } from "./helpers/video-playback";

test.each([false, true])("S3 file upload uses bounded multipart requests and aborts failed uploads (%s)", async failPart => {
  let active = 0, peak = 0, aborted = 0, completed = 0;
  const parts = new Map<number, { bytes: number; hash: string }>();
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, "http://127.0.0.1");
      if (request.method === "POST" && url.searchParams.has("uploads")) {
        request.resume(); response.setHeader("content-type", "application/xml");
        response.end('<InitiateMultipartUploadResult><Bucket>fixture</Bucket><Key>video.mp4</Key><UploadId>owned-fixture-upload</UploadId></InitiateMultipartUploadResult>'); return;
      }
      expect(url.searchParams.get("uploadId")).toBe("owned-fixture-upload");
      if (request.method === "PUT") {
        active++; peak = Math.max(peak, active);
        const index = Number(url.searchParams.get("partNumber"));
        let bytes = 0; const hash = createHash("sha256");
        try {
          for await (const chunk of request) { bytes += chunk.byteLength; hash.update(chunk); }
          parts.set(index, { bytes, hash: hash.digest("hex") });
          await new Promise(resolve => setTimeout(resolve, 25));
          if (failPart && index === 2) { response.statusCode = 403; response.setHeader("content-type", "application/xml"); response.end('<Error><Code>AccessDenied</Code><Message>Fixture part failure</Message></Error>'); }
          else { response.setHeader("ETag", `"part-${index}"`); response.end(); }
        } finally { active--; }
        return;
      }
      request.resume();
      if (request.method === "DELETE") { aborted++; response.statusCode = 204; response.end(); return; }
      if (request.method === "POST") { completed++; response.setHeader("content-type", "application/xml"); response.end('<CompleteMultipartUploadResult><Bucket>fixture</Bucket><Key>video.mp4</Key><ETag>"complete"</ETag></CompleteMultipartUploadResult>'); return; }
      throw new Error(`Unexpected fixture request ${request.method}`);
    })().catch(error => { response.statusCode = 500; response.end(String(error)); });
  });
  server.listen(0, "127.0.0.1"); await new Promise<void>(done => server.once("listening", done));
  const port = (server.address() as { port: number }).port;
  const storage = new ObjectStorage({ S3_ENDPOINT: `http://127.0.0.1:${port}`, S3_REGION: "us-east-1", S3_FORCE_PATH_STYLE: "true", S3_BUCKET: "fixture", S3_ACCESS_KEY_ID: "fixture", S3_SECRET_ACCESS_KEY: "fixture" } as never);
  const chunk = new Uint8Array(256 * 1024).fill(7);
  const file = await createTemporaryMediaFile((async function* () { for (let count = 0; count < 48; count++) yield chunk; })(), { prefix: "canvas-storage-test-" });
  try {
    const upload = storage.putFile("video.mp4", file.path, file.byteSize, "video/mp4");
    if (failPart) await expect(upload).rejects.toThrow("Fixture part failure"); else await upload;
    expect(peak).toBe(2); expect(active).toBe(0); expect(aborted).toBe(failPart ? 1 : 0); expect(completed).toBe(failPart ? 0 : 1);
    for (const [index, part] of parts) {
      const chunks = index === 3 ? 8 : 20;
      expect(part.bytes).toBe(chunks * chunk.byteLength);
      const expected = createHash("sha256"); for (let n = 0; n < chunks; n++) expected.update(chunk);
      expect(part.hash).toBe(expected.digest("hex"));
    }
    if (!failPart) expect([...parts.keys()].sort()).toEqual([1, 2, 3]);
  } finally {
    await file.dispose(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  }
}, 20_000);

test.each([1, 48])("caller cancellation aborts in-flight S3 requests and awaits any multipart cleanup (%s chunks)", async chunks => {
  const started = deferred(); let aborted = 0, completed = 0, partSockets = 0, closedPartSockets = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1"); request.resume();
    if (request.method === "POST" && url.searchParams.has("uploads")) {
      response.setHeader("content-type", "application/xml");
      response.end('<InitiateMultipartUploadResult><Bucket>fixture</Bucket><Key>video.mp4</Key><UploadId>cancel-upload</UploadId></InitiateMultipartUploadResult>'); return;
    }
    if (request.method === "PUT") {
      partSockets++; request.socket.once("close", () => { closedPartSockets++; });
      started.resolve(); return; // No response until the caller cancels.
    }
    if (request.method === "DELETE") { aborted++; response.statusCode = 204; response.end(); return; }
    completed++; response.statusCode = 500; response.end("must not complete cancelled upload");
  });
  server.listen(0, "127.0.0.1"); await new Promise<void>(done => server.once("listening", done));
  const storage = new ObjectStorage({ S3_ENDPOINT: `http://127.0.0.1:${(server.address() as { port: number }).port}`, S3_REGION: "us-east-1", S3_FORCE_PATH_STYLE: "true", S3_BUCKET: "fixture", S3_ACCESS_KEY_ID: "fixture", S3_SECRET_ACCESS_KEY: "fixture" } as never);
  const file = await createTemporaryMediaFile((async function* () { for (let n = 0; n < chunks; n++) yield new Uint8Array(256 * 1024); })());
  const controller = new AbortController();
  try {
    const upload = storage.putFile("video.mp4", file.path, file.byteSize, "video/mp4", { abortSignal: controller.signal });
    const observed = upload.catch(error => error);
    await started.promise; controller.abort();
    expect(await observed).toBeInstanceOf(Error);
    expect(aborted).toBe(chunks === 48 ? 1 : 0);
    await until(() => closedPartSockets === partSockets, "cancelled S3 requests");
    expect(completed).toBe(0); expect(partSockets).toBeGreaterThan(0);
  } finally { controller.abort(); await file.dispose(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
}, 10_000);
