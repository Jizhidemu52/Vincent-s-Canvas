import { expect, test } from "bun:test";
import { readApiMartVideoReceipt } from "../../src/video-provider-receipt";
import { createSmokeMedia, createSmokeProvider, SMOKE_CHAT_REPLY, SMOKE_PROVIDER_KEY } from "./mock-provider";

const fixture = { image: Buffer.from("local-image"), video: Buffer.from("local-video"), imageSha256: "a".repeat(64), width: 1024, height: 1024 };
const make = () => createSmokeProvider("ci-release-123-1-amd64", "http://mock-provider:4180", fixture);
const post = (path: string, model: string, key = SMOKE_PROVIDER_KEY) => new Request(`http://mock-provider:4180${path}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model }) });

test("local provider rejects external origins, real credentials and unexpected models", async () => {
    expect(() => createSmokeProvider("production", "http://mock-provider:4180", fixture)).toThrow();
    expect(() => createSmokeProvider("ci-release-123-1-amd64", "https://api.example.com", fixture)).toThrow();
    const handler = make();
    expect((await handler(post("/v1/images/generations", "gpt-image-2", "not-the-synthetic-key"))).status).toBe(403);
    expect((await handler(post("/v1/images/generations", "unconfigured-model"))).status).toBe(400);
    expect((await handler(post("/v1/anything", "gpt-image-2"))).status).toBe(404);
    expect((await (await handler(new Request("http://mock-provider:4180/__smoke/receipt"))).json()).calls).toEqual([]);
});

test("local provider supports the actual image, Responses and asynchronous video envelopes", async () => {
    const handler = make();
    expect(await (await handler(post("/v1/images/generations", "gpt-image-2"))).json()).toEqual({ data: [{ b64_json: fixture.image.toString("base64") }] });
    const chat = await (await handler(post("/v1/responses", "gpt-6-astra"))).json();
    expect(chat.output[0].content[0]).toMatchObject({ type: "output_text", text: SMOKE_CHAT_REPLY });
    const video = await (await handler(post("/v1/videos/generations", "MiniMax-H3"))).json();
    expect(video.data[0].task_id).toBe("smoke-video-1");
    const polled = await (await handler(new Request("http://mock-provider:4180/v1/tasks/smoke-video-1", { headers: { authorization: `Bearer ${SMOKE_PROVIDER_KEY}` } }))).json();
    expect(polled.data).toEqual({ status: "completed", result: { videos: [{ url: ["http://mock-provider.example:4180/fixtures/result.mp4"] }] } });
    expect(await (await handler(new Request("http://mock-provider:4180/fixtures/upload.png"))).arrayBuffer()).toEqual(fixture.image.buffer.slice(fixture.image.byteOffset, fixture.image.byteOffset + fixture.image.byteLength));
    const receipt = await (await handler(new Request("http://mock-provider:4180/__smoke/receipt"))).json();
    expect(receipt).toMatchObject({ schema: 1, project: "ci-release-123-1-amd64", paid: false });
    expect(receipt.calls.map((call: { kind: string }) => call.kind)).toEqual(["image", "chat", "video", "video-poll"]);
});

test("synthetic completed video passes the production receipt URL contract without network access", async () => {
    const handler = make();
    const submitted = await (await handler(post("/v1/videos/generations", "MiniMax-H3"))).json();
    const upstreamTaskId = submitted.data[0].task_id;
    const polled = await (await handler(new Request(`http://mock-provider:4180/v1/tasks/${upstreamTaskId}`, { headers: { authorization: `Bearer ${SMOKE_PROVIDER_KEY}` } }))).json();
    const identity = {
        taskId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002",
        modelConfigId: "00000000-0000-4000-8000-000000000003", modelId: "MiniMax-H3", upstreamTaskId,
    };
    const document = { ...identity, schema: "canvas.video-provider-receipt", version: 1, kind: "apimart-video",
        status: polled.data.status, url: polled.data.result.videos[0].url[0], currency: "USD", costStatus: "unknown" };
    expect(() => readApiMartVideoReceipt(document, identity)).not.toThrow();
    expect(readApiMartVideoReceipt(document, identity)?.url).toBe("http://mock-provider.example:4180/fixtures/result.mp4");
    const result = await handler(new Request(document.url));
    expect(result.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(await result.arrayBuffer())).toEqual(fixture.video);
    // The fixture must conform to the production rule, never weaken it.
    expect(() => readApiMartVideoReceipt({ ...document, url: "http://mock-provider:4180/fixtures/result.mp4" }, identity)).toThrow("收据格式无效");
    expect(() => readApiMartVideoReceipt({ ...document, url: "http://127.0.0.1:4180/fixtures/result.mp4" }, identity)).toThrow("收据格式无效");
});

test("formal smoke media is a real large PNG and playable MP4 generated locally", () => {
    const media = createSmokeMedia();
    expect(media.image.byteLength).toBeGreaterThan(1024 * 1024);
    expect(media.image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect([media.image.readUInt32BE(16), media.image.readUInt32BE(20)]).toEqual([1024, 1024]);
    expect(media.video.subarray(4, 8).toString()).toBe("ftyp");
    expect(media.video.byteLength).toBeGreaterThan(1000);
}, 60_000);
