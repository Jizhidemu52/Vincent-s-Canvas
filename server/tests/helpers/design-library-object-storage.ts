import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { ObjectStorage } from "../../src/object-storage";

type StoredObject = { bytes: Uint8Array; contentType: string; etag: string; metadata: Record<string, string> };
export type StorageRequest = { method: string; key: string; source?: string; ifMatch?: string; metadataDirective?: string };

/** Loopback-only S3 wire fixture: production AWS SDK, no cloud or paid provider. */
export async function createDesignLibraryObjectStorageFixture() {
    const objects = new Map<string, StoredObject>();
    const requests: StorageRequest[] = [];
    let beforeRequest: ((request: StorageRequest) => Promise<void>) | undefined;
    const seed = (key: string, bytes: Uint8Array, contentType = "image/png", metadata = { fixture: "preserved" }) => {
        objects.set(key, { bytes: new Uint8Array(bytes), contentType, etag: `"${createHash("sha256").update(bytes).digest("hex")}"`, metadata });
    };
    const server = createServer((request, response) => {
        void (async () => {
            const url = new URL(request.url!, "http://127.0.0.1");
            const key = decodeURIComponent(url.pathname.slice("/fixture/".length));
            const copySource = request.headers["x-amz-copy-source"] as string | undefined;
            const item: StorageRequest = { method: request.method!, key,
                ...(copySource ? { source: decodeURIComponent(copySource.replace(/^\/?fixture\//, "")), ifMatch: request.headers["x-amz-copy-source-if-match"] as string,
                    metadataDirective: request.headers["x-amz-metadata-directive"] as string } : {}) };
            requests.push(item);
            await beforeRequest?.(item);
            const failure = (status: number, code: string) => {
                request.resume(); response.statusCode = status; response.setHeader("content-type", "application/xml");
                response.end(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`);
            };
            if (item.method === "GET" || item.method === "HEAD") {
                request.resume();
                const object = objects.get(key);
                if (!object) return failure(404, "NoSuchKey");
                response.setHeader("content-length", object.bytes.byteLength);
                response.setHeader("content-type", object.contentType);
                response.setHeader("etag", object.etag);
                for (const [name, value] of Object.entries(object.metadata)) response.setHeader(`x-amz-meta-${name}`, value);
                response.end(item.method === "GET" ? object.bytes : undefined); return;
            }
            if (item.method === "PUT" && item.source) {
                request.resume();
                const source = objects.get(item.source);
                if (!source) return failure(404, "NoSuchKey");
                if (item.ifMatch !== source.etag) return failure(412, "PreconditionFailed");
                objects.set(key, { ...source, bytes: new Uint8Array(source.bytes), metadata: { ...source.metadata } });
                response.setHeader("content-type", "application/xml");
                response.end(`<CopyObjectResult><ETag>${source.etag}</ETag><LastModified>2026-10-24T00:00:00Z</LastModified></CopyObjectResult>`); return;
            }
            if (item.method === "PUT") {
                const chunks: Uint8Array[] = [];
                for await (const chunk of request) chunks.push(chunk);
                seed(key, Buffer.concat(chunks), request.headers["content-type"] as string);
                response.setHeader("etag", objects.get(key)!.etag); response.end(); return;
            }
            request.resume();
            if (item.method === "DELETE") { objects.delete(key); response.statusCode = 204; response.end(); return; }
            failure(400, "UnexpectedFixtureRequest");
        })().catch(error => { response.statusCode = 500; response.end(String(error)); });
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>(done => server.once("listening", done));
    const storage = new ObjectStorage({ S3_ENDPOINT: `http://127.0.0.1:${(server.address() as { port: number }).port}`, S3_REGION: "us-east-1",
        S3_FORCE_PATH_STYLE: "true", S3_BUCKET: "fixture", S3_ACCESS_KEY_ID: "fixture", S3_SECRET_ACCESS_KEY: "fixture" } as never);
    return { storage, objects, requests, seed, beforeRequest: (hook?: typeof beforeRequest) => { beforeRequest = hook; },
        close: async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } };
}
