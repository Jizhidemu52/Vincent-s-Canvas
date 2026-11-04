import { expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { S3Client } from "@aws-sdk/client-s3";
import { ObjectStorage } from "../src/object-storage";
import { loadConfig } from "../src/config";

test("real S3 SDK sends If-None-Match for repair and cannot overwrite a concurrently restored object", async () => {
  const objects = new Map<string, Buffer>();
  const calls: Array<{ path: string; condition: string | undefined; bytes: Buffer }> = [];
  const upstream = createServer(async (request, response) => {
    if (request.method !== "PUT") { response.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks), path = request.url!, condition = request.headers["if-none-match"];
    calls.push({ path, condition, bytes });
    if (condition === "*" && objects.has(path)) {
      response.writeHead(412, { "Content-Type": "application/xml" });
      response.end("<Error><Code>PreconditionFailed</Code><Message>Object already exists</Message></Error>");
      return;
    }
    objects.set(path, bytes);
    response.writeHead(200, { ETag: '"fixture-original"' }).end();
  });
  upstream.listen(0, "127.0.0.1");
  await new Promise<void>(done => upstream.once("listening", done));
  const storage = new ObjectStorage(loadConfig({ DATABASE_URL: "unused", REDIS_URL: "unused",
    S3_ENDPOINT: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, S3_BUCKET: "repair-fixture",
    S3_ACCESS_KEY_ID: "isolated-fixture", S3_SECRET_ACCESS_KEY: "isolated-fixture", S3_FORCE_PATH_STYLE: "true",
  }));
  try {
    const first = Buffer.from("original bytes"), second = Buffer.from("different bytes");
    const results = await Promise.allSettled([
      storage.put("historical/source", first, "text/plain", { ifNoneMatch: "*" }),
      storage.put("historical/source", second, "text/plain", { ifNoneMatch: "*" }),
    ]);
    expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.$metadata.httpStatusCode).toBe(412);
    expect(calls).toHaveLength(2);
    expect(calls.every(call => call.condition === "*")).toBe(true);
    expect(objects.get(calls[0]!.path)).toEqual(results[0]!.status === "fulfilled" ? first : second);
    await storage.put("new/pending", first, "text/plain");
    expect(calls.at(-1)?.condition).toBeUndefined();
    expect(objects.get(calls.at(-1)!.path)).toEqual(first);
  } finally {
    const clients = storage as unknown as { client: S3Client; publicClient: S3Client };
    clients.client.destroy(); clients.publicClient.destroy();
    upstream.closeAllConnections();
    await new Promise<void>(done => upstream.close(() => done()));
  }
});
