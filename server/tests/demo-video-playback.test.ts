import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { createDemoVideoPlayback } from "../src/demo-video-playback";
import { VideoPreviewError } from "../src/asset-video-preview";
import { deferred, playbackBytes, playbackMetadata } from "./helpers/video-playback";

function fixture() {
  const original = Buffer.from(playbackBytes);
  const state = { asset: { id: "asset-a", ownerUserId: "owner-a", filename: "original.mp4", mimeType: "video/mp4", bytes: original, deletedAt: null as string | null }, allowed: true };
  const read = () => state.allowed ? state.asset : undefined;
  return { state, original, read };
}
const request = (headers: Record<string, string> = {}, method = "GET") => new Request("http://127.0.0.1/api/assets/asset-a/playback", { method, headers });
const prepare = async (_input: string, output: string) => { await writeFile(output, playbackBytes); return { kind: "derived" as const, metadata: playbackMetadata, byteSize: playbackBytes.length }; };
async function ready(service: ReturnType<typeof createDemoVideoPlayback>, id: string, read: ReturnType<typeof fixture>["read"]) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await service.respond(id, request(), read);
    if (result.status !== 202) return result;
    await Bun.sleep(10);
  }
  throw new Error("Demo playback fixture did not become ready");
}

test("private demo playback is on demand, deduplicated and supports byte ranges without changing the source", async () => {
  const f = fixture(), gate = deferred(); let runs = 0, temporary = "";
  const service = createDemoVideoPlayback({ prepare: async (input, output) => { runs++; temporary = input; await gate.promise; return prepare(input, output); } });
  try {
    expect((await service.respond(f.state.asset.id, request({}, "HEAD"), f.read)).status).toBe(202);
    expect(runs).toBe(0);
    const cold = await service.respond(f.state.asset.id, request(), f.read);
    expect(cold.status).toBe(202); expect(cold.headers.get("retry-after")).toBe("3");
    for (let index = 0; index < 10; index++) expect((await service.respond(f.state.asset.id, request(), f.read)).status).toBe(202);
    gate.resolve();
    const full = await ready(service, f.state.asset.id, f.read);
    expect(full.status).toBe(200); expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(full.headers.get("cache-control")).toBe("no-store"); expect(full.headers.get("vary")).toBe("Cookie");
    expect(full.headers.get("x-canvas-media-width")).toBe("160"); expect(full.headers.get("x-canvas-media-duration-ms")).toBe("1000");
    expect(Buffer.from(await full.arrayBuffer())).toEqual(playbackBytes);
    const etag = full.headers.get("etag")!;
    for (const [range, start, end] of [["bytes=9000-9015", 9000, 9015], ["bytes=-16", 16368, 16383], ["bytes=16380-", 16380, 16383], ["bytes=-99999", 0, 16383]] as const) {
      const response = await service.respond(f.state.asset.id, request({ Range: range, "If-Range": etag }), f.read);
      expect(response.status).toBe(206); expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/16384`);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(playbackBytes.subarray(start, end + 1));
    }
    for (const headers of [{ Range: "bytes=0-1,4-5" }, { Range: "bytes=0-1", "If-Range": '"stale"' }, { Range: "bytes=abc" }] as Record<string, string>[]) {
      expect((await service.respond(f.state.asset.id, request(headers), f.read)).status).toBe(200);
    }
    const invalid = await service.respond(f.state.asset.id, request({ Range: "bytes=20000-" }), f.read);
    expect(invalid.status).toBe(416); expect(invalid.headers.get("content-range")).toBe("bytes */16384");
    const head = await service.respond(f.state.asset.id, request({ Range: "bytes=0-1" }, "HEAD"), f.read);
    expect(head.status).toBe(200); expect(head.headers.get("content-length")).toBe("16384"); expect(await head.text()).toBe("");
    expect((await service.respond(f.state.asset.id, request({ "If-None-Match": etag }), f.read)).status).toBe(304);
    expect(runs).toBe(1); expect(f.original).toEqual(playbackBytes);
    await service.stop();
    expect(await readFile(temporary).catch(() => null)).toBeNull();
  } finally { gate.resolve(); await service.stop(); }
});

test("cached demo preview never bypasses current access or deletion, including conditional and HEAD reads", async () => {
  const f = fixture(); let runs = 0;
  const service = createDemoVideoPlayback({ prepare: async (input, output) => { runs++; return prepare(input, output); } });
  try {
    const full = await ready(service, f.state.asset.id, f.read), etag = full.headers.get("etag")!;
    f.state.allowed = false;
    for (const method of ["GET", "HEAD"]) {
      const denied = await service.respond(f.state.asset.id, request({ "If-None-Match": etag }, method), f.read);
      expect(denied.status).toBe(404); expect(denied.headers.get("etag")).toBeNull();
    }
    f.state.allowed = true; f.state.asset.deletedAt = new Date().toISOString();
    expect((await service.respond(f.state.asset.id, request(), f.read)).status).toBe(404);
    f.state.asset.deletedAt = null; f.state.asset.ownerUserId = "owner-b";
    expect((await service.respond(f.state.asset.id, request({}, "HEAD"), f.read)).status).toBe(202);
    expect(runs).toBe(1);
  } finally { await service.stop(); }
});

test.each(["source", "owner", "deleted", "access"])("a %s change during conversion cannot publish stale bytes", async change => {
  const f = fixture(), gate = deferred(); let started = false;
  const service = createDemoVideoPlayback({ prepare: async (input, output) => { started = true; await gate.promise; return prepare(input, output); } });
  try {
    await service.respond(f.state.asset.id, request(), f.read);
    while (!started) await Bun.sleep(5);
    if (change === "source") f.state.asset.bytes = Buffer.from("a changed source with the same asset id");
    if (change === "owner") f.state.asset.ownerUserId = "owner-b";
    if (change === "deleted") f.state.asset.deletedAt = new Date().toISOString();
    if (change === "access") f.state.allowed = false;
    gate.resolve(); await Bun.sleep(30);
    const response = await service.respond(f.state.asset.id, request({}, "HEAD"), f.read);
    expect(response.status).toBe(change === "deleted" || change === "access" ? 404 : 202);
    expect(response.headers.get("etag")).toBeNull();
  } finally { gate.resolve(); await service.stop(); }
});

test("a compatible original is served unchanged and cache entries obey their total byte bound", async () => {
  const f = fixture(); let runs = 0;
  const original = createDemoVideoPlayback({ prepare: async () => { runs++; return { kind: "original", metadata: playbackMetadata }; } });
  try {
    expect(Buffer.from(await (await ready(original, f.state.asset.id, f.read)).arrayBuffer())).toEqual(f.original);
    expect(runs).toBe(1);
  } finally { await original.stop(); }
  const limited = createDemoVideoPlayback({ maxCacheBytes: playbackBytes.length, prepare });
  try {
    expect((await ready(limited, "a", f.read)).status).toBe(200);
    expect((await ready(limited, "b", f.read)).status).toBe(200);
    expect((await limited.respond("a", request({}, "HEAD"), f.read)).status).toBe(202);
    expect((await limited.respond("b", request({}, "HEAD"), f.read)).status).toBe(200);
  } finally { await limited.stop(); }
});

test("preview errors are bounded and cached without exposing process diagnostics or touching original bytes", async () => {
  const f = fixture(); let runs = 0;
  const service = createDemoVideoPlayback({ prepare: async () => { runs++; throw new VideoPreviewError(422, "VIDEO_PREVIEW_UNSUPPORTED", "Invalid synthetic video"); } });
  try {
    const failed = await ready(service, f.state.asset.id, f.read);
    expect(failed.status).toBe(422); expect(await failed.json()).toMatchObject({ error: "VIDEO_PREVIEW_UNSUPPORTED" });
    expect((await service.respond(f.state.asset.id, request(), f.read)).status).toBe(422);
    expect(runs).toBe(1); expect(f.original).toEqual(playbackBytes);
  } finally { await service.stop(); }
});
