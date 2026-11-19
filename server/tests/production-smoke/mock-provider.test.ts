import { expect, test } from "bun:test";
import { readApiMartVideoReceipt } from "../../src/video-provider-receipt";
import { stepApiMartImageTask } from "../../src/apimart-image";
import { requestChatCompletion } from "../../src/routes/chat";
import { prepareImageConversationPlannerProfile, validateImageConversationPlannerOutput } from "../../src/image-conversation-planner";
import { plannerContext } from "../fixtures/image-conversation-planner";
import { createSmokeMedia, createSmokeProvider, SMOKE_CHAT_REPLY, SMOKE_CONVERSATION_PROMPT, SMOKE_PROVIDER_KEY } from "./mock-provider";

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

test("local planner and Flare fixtures follow the production tool-call and durable polling contracts", async () => {
    const handler = make();
    const planner = await handler(new Request("http://mock-provider:4180/v1/responses", { method: "POST",
        headers: { authorization: `Bearer ${SMOKE_PROVIDER_KEY}`, "content-type": "application/json" }, body: JSON.stringify({
            model: "gpt-6.2-sol", tools: [{ type: "function", name: "plan_image_conversation" }], tool_choice: "required",
            input: [{ role: "user", content: "Create a synthetic blue square. Formal isolated conversation smoke." }],
        }) }));
    expect(planner.status).toBe(200);
    const planned = await planner.json();
    expect(planned.output[0]).toMatchObject({ type: "function_call", name: "plan_image_conversation" });
    expect(JSON.parse(planned.output[0].arguments).plan).toMatchObject({ action: "generate_new", references: [],
        requestedState: { schemaVersion: 1, goals: ["Create a synthetic blue square."], constraints: [] } });
    const submitted = await handler(post("/v1/images/generations", "gpt-image-2.6-flare"));
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toEqual({ data: [{ task_id: "smoke-conversation-image-1" }] });
    const polled = await handler(new Request("http://mock-provider:4180/v1/tasks/smoke-conversation-image-1", { headers: { authorization: `Bearer ${SMOKE_PROVIDER_KEY}` } }));
    expect(await polled.json()).toEqual({ data: { status: "completed", result: { images: [{ url: ["http://mock-provider.example:4180/fixtures/result.png"] }] } } });
    const receipt = await (await handler(new Request("http://mock-provider:4180/__smoke/receipt"))).json();
    expect(receipt.calls.map((call: { kind: string }) => call.kind)).toEqual(["conversation-planner", "conversation-image", "conversation-image-poll"]);
});

test.each(["openai", "apimart"])("the production planner and Flare adapters consume the exact smoke envelopes without replacing their parsers: %s", async protocol => {
    const handler = make();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
    try {
        const context = plannerContext();
        Object.assign(context, { currentUserText: SMOKE_CONVERSATION_PROMPT, inputActiveVersionId: null, versions: [], requestedState: { schemaVersion: 1, goals: [], constraints: [] } });
        Object.assign(context.manifest, { inputActiveVersionId: null, baseVersionId: null, sourceStateVersionId: null, images: [], attachments: [] });
        const profile = prepareImageConversationPlannerProfile([{ role: "user", content: SMOKE_CONVERSATION_PROMPT }], context, true);
        const result = await requestChatCompletion({ model_id: "gpt-6.2-sol", protocol, base_url: `http://127.0.0.1:${server.port}/v1`, encrypted_credentials: null }, { apiKey: SMOKE_PROVIDER_KEY }, profile.input);
        expect(validateImageConversationPlannerOutput(result, profile)).toMatchObject({ action: "generate_new", description: "Create a synthetic blue square.", outputIntent: { purpose: "draft", complexity: "low" } });
        const input = { modelId: "gpt-image-2.6-flare", baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: SMOKE_PROVIDER_KEY,
            prompt: "Create a synthetic blue square.", parameters: { n: 1, quality: "low", resolution: "1k", size: "1:1", output_format: "png" } };
        const submitted = await stepApiMartImageTask(input);
        expect(submitted.status).toBe("pending");
        expect(await stepApiMartImageTask({ ...input, upstreamTaskId: submitted.upstreamTaskId, submissionStarted: true })).toEqual({
            status: "completed", upstreamTaskId: "smoke-conversation-image-1", urls: ["http://mock-provider.example:4180/fixtures/result.png"],
        });
    } finally { server.stop(true); }
});

test("the formal conversation delay keeps the accepted original task in flight without a second submission", async () => {
    const handler = createSmokeProvider("ci-release-123-1-amd64", "http://mock-provider:4180", fixture, 60_000);
    const submitted = await (await handler(post("/v1/images/generations", "gpt-image-2.6-flare"))).json();
    for (let index = 0; index < 2; index++) {
        const response = await handler(new Request(`http://mock-provider:4180/v1/tasks/${submitted.data[0].task_id}`, { headers: { authorization: `Bearer ${SMOKE_PROVIDER_KEY}` } }));
        expect(await response.json()).toEqual({ data: { status: "processing" } });
    }
    const receipt = await (await handler(new Request("http://mock-provider:4180/__smoke/receipt"))).json();
    expect(receipt.calls.map((call: { kind: string }) => call.kind)).toEqual(["conversation-image", "conversation-image-poll", "conversation-image-poll"]);
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
