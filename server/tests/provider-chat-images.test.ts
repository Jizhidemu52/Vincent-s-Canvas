import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import express, { type Request, type Response } from "express";
import type { Cache, Database } from "../src/db";
import { createProviderChatImagesRouter, ProviderChatImageAccess, supportsProviderChatImages } from "../src/provider-chat-images";
import { PROVIDER_IMAGE_PATH } from "../src/provider-image-access";
import { type ChatCompletionInput, requestChatCompletion } from "../src/routes/chat";

const ownerId = "00000000-0000-4000-8000-000000000001";
const origin = "http://ai.in-choice.com.cn";
const maxImageBytes = 4 * 1024 * 1024;
const exec = promisify(execFile);
const imagePromises = new Map<string, Promise<Buffer<ArrayBuffer>>>();
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const dataUrl = (bytes: Buffer, mime = "image/png") => `data:${mime};base64,${bytes.toString("base64")}`;
const tokenOf = (url: string) => new URL(url).pathname.split("/")[3]!;
const cacheKey = (token: string) => `provider-chat-images:${token}`;

function image(mime = "image/png", color = "blue", size = "64x32") {
    const id = `${mime}:${color}:${size}`;
    let pending = imagePromises.get(id);
    if (!pending) {
        pending = (async () => {
            const codecs: Record<string, string> = { "image/png": "png", "image/jpeg": "mjpeg", "image/webp": "libwebp", "image/gif": "gif" };
            const { stdout } = await exec(process.env.FFMPEG_PATH || "ffmpeg", [
                "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=${size}`, "-frames:v", "1",
                "-c:v", codecs[mime]!, "-threads", "1", "-f", "image2pipe", "pipe:1",
            ], { encoding: "buffer", windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
            return Buffer.from(stdout);
        })();
        imagePromises.set(id, pending);
    }
    return pending;
}

function inputFor(...urls: string[]): ChatCompletionInput {
    return { input: [{ role: "system", content: "Inspect the submitted previews only." }, {
        role: "user", content: urls.flatMap((url, index) => [
            { type: "input_text" as const, text: `Image ${index + 1}` },
            { type: "input_image" as const, image_url: url },
        ]),
    }], tools: [] };
}

function imageUrls(input: ChatCompletionInput) {
    return input.input.flatMap(item => "role" in item && Array.isArray(item.content)
        ? item.content.flatMap(part => part.type === "input_image" ? [part.image_url] : []) : []);
}

function fixture(publicOrigin: string | undefined = origin) {
    const state = { userStatus: "active", userDeleted: false, dbFailure: false, readFailure: false, writeFailure: false, deleteFailure: false };
    const records = new Map<string, string>();
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const writes: Array<{ key: string; value: string; options?: { EX: number } }> = [];
    const reads: string[] = [];
    const deletes: string[] = [];
    let onQuery: (() => void | Promise<void>) | undefined;
    const db = { query: async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (state.dbFailure) throw new Error("private database detail");
        await onQuery?.();
        return { rows: params[0] === ownerId && state.userStatus === "active" && !state.userDeleted ? [{ id: ownerId }] : [] };
    } } as unknown as Pick<Database, "query">;
    const cache: Pick<Cache, "get" | "set" | "del"> = {
        get: async key => {
            reads.push(key);
            if (state.readFailure) throw new Error("private cache read detail");
            return records.get(key) ?? null;
        },
        set: async (key, value, options) => {
            if (state.writeFailure) throw new Error("private cache write detail");
            records.set(key, value);
            writes.push({ key, value, options });
            return "OK";
        },
        del: async key => {
            deletes.push(key);
            if (state.deleteFailure) throw new Error("private cache deletion detail");
            return records.delete(key) ? 1 : 0;
        },
    };
    return { state, records, queries, writes, reads, deletes, access: new ProviderChatImageAccess(db, cache, publicOrigin),
        onQuery: (callback?: () => void | Promise<void>) => { onQuery = callback; } };
}

type Fixture = ReturnType<typeof fixture>;
type ProviderRequest = { path: string; method: string; body: Record<string, unknown> };
type ProviderHandler = (request: Request, response: Response, base: string) => Promise<void> | void;

async function withServer<T>(f: Fixture, run: (base: string, requests: ProviderRequest[]) => Promise<T>, provider?: ProviderHandler) {
    const app = express();
    app.use(express.json({ limit: "20mb" }));
    app.use(PROVIDER_IMAGE_PATH, createProviderChatImagesRouter(f.access));
    const requests: ProviderRequest[] = [];
    let base = "";
    app.use(async (request, response) => {
        requests.push({ path: request.path, method: request.method, body: request.body ?? {} });
        if (provider) await provider(request, response, base);
        else response.status(404).end();
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try { return await run(base, requests); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

function carbonModel(base: string) {
    return { model_id: "gemini-4-carbon", protocol: "apimart", base_url: `${base}/v1`, encrypted_credentials: null };
}

const completion = { choices: [{ message: { role: "assistant", content: "Two fixtures inspected." }, finish_reason: "stop" }] };

test("request-scoped URLs preserve exact bytes, hashes, order, text, tools, and caller input", async () => {
    const f = fixture();
    const bytes = [await image("image/png", "red"), await image("image/webp"), await image("image/png", "red")];
    const input = inputFor(dataUrl(bytes[0]!), dataUrl(bytes[1]!, "image/webp"));
    input.input.push({ type: "function_call", call_id: "call-1", name: "inspect_fixture", arguments: '{"index":1}' },
        { type: "function_call_output", call_id: "call-1", output: '{"accepted":true}' },
        { role: "assistant", content: [{ type: "input_text", text: "Keep the original order." }, { type: "input_image", image_url: dataUrl(bytes[2]!) }] });
    input.tools = [{ type: "function", name: "inspect_fixture", parameters: { type: "object" }, strict: true }];
    input.toolChoice = { type: "function", name: "inspect_fixture" };
    input.gemini = { maxOutputTokens: 1000 };
    const original = structuredClone(input);
    const startedAt = Date.now();
    let calls = 0;
    let urls: string[] = [];
    const result = await f.access.run(ownerId, input, async prepared => {
        calls++;
        urls = imageUrls(prepared);
        expect(urls).toHaveLength(3);
        const token = tokenOf(urls[0]!);
        for (let index = 0; index < urls.length; index++) {
            expect(urls[index]).toBe(`${origin}${PROVIDER_IMAGE_PATH}/${token}/preview/${index}`);
            expect(urls[index]).not.toContain(ownerId);
            const preview = await f.access.resolve(token, String(index));
            expect(preview.bytes).toEqual(bytes[index]!);
            expect(preview.sha256).toBe(digest(bytes[index]!));
        }
        expect(token).toMatch(/^[a-f0-9]{64}$/);
        expect(prepared.tools).toEqual(original.tools);
        expect(prepared.toolChoice).toEqual(original.toolChoice);
        expect(prepared.gemini).toEqual(original.gemini);
        expect(prepared.input[0]).toEqual(original.input[0]);
        expect(prepared.input.slice(2, 4)).toEqual(original.input.slice(2, 4));
        expect(prepared.input[1]).toEqual({ role: "user", content: [
            { type: "input_text", text: "Image 1" }, { type: "input_image", image_url: urls[0] },
            { type: "input_text", text: "Image 2" }, { type: "input_image", image_url: urls[1] },
        ] });
        const grant = JSON.parse(f.writes[0]!.value);
        expect(grant.userId).toBe(ownerId);
        expect(grant.expiresAt).toBeGreaterThanOrEqual(startedAt + 240_000);
        expect(grant.expiresAt).toBeLessThanOrEqual(Date.now() + 240_000);
        expect(grant.images.map((item: { sha256: string }) => item.sha256)).toEqual(bytes.map(digest));
        expect(f.writes[0]!.options).toEqual({ EX: 240 });
        return "accepted";
    });
    expect(result).toBe("accepted");
    expect(calls).toBe(1);
    expect(input).toEqual(original);
    expect(f.writes).toHaveLength(1);
    expect(f.deletes).toEqual([cacheKey(tokenOf(urls[0]!))]);
    expect(f.records.size).toBe(0);
    expect(f.queries.every(query => query.sql.includes("status='active' AND deleted_at IS NULL") && query.params[0] === ownerId)).toBe(true);
    await expect(f.access.resolve(tokenOf(urls[0]!), "0")).rejects.toMatchObject({ status: 404 });
});

test.each(["image/png", "image/jpeg", "image/webp", "image/gif"])("real public GET and HEAD serve identical %s bytes only while the request is active", async mime => {
    const f = fixture();
    const bytes = await image(mime);
    let path = "";
    await withServer(f, async (base, requests) => {
        await f.access.run(ownerId, inputFor(dataUrl(bytes, mime)), async prepared => {
            path = new URL(imageUrls(prepared)[0]!).pathname;
            for (let i = 0; i < 2; i++) {
                const response = await fetch(base + path);
                expect(response.status).toBe(200);
                expect(response.headers.get("content-type")).toBe(mime);
                expect(response.headers.get("content-length")).toBe(String(bytes.length));
                expect(response.headers.get("etag")).toBe(`"${digest(bytes)}"`);
                expect(response.headers.get("cache-control")).toBe("no-store");
                expect(response.headers.get("x-content-type-options")).toBe("nosniff");
                expect(response.headers.get("referrer-policy")).toBe("no-referrer");
                expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
            }
            const head = await fetch(base + path, { method: "HEAD" });
            expect(head.status).toBe(200);
            expect(head.headers.get("content-length")).toBe(String(bytes.length));
            expect(await head.text()).toBe("");
        });
        const ended = await fetch(base + path);
        expect(ended.status).toBe(404);
        expect(ended.headers.get("cache-control")).toBe("no-store");
        expect(await ended.text()).toBe("");
        expect(requests).toHaveLength(0);
    });
});

test("each invocation receives a fresh token and completion cannot revoke another request", async () => {
    const f = fixture();
    const input = inputFor(dataUrl(await image()));
    await f.access.run(ownerId, input, async first => {
        const firstToken = tokenOf(imageUrls(first)[0]!);
        await f.access.run(ownerId, input, async second => {
            const secondToken = tokenOf(imageUrls(second)[0]!);
            expect(secondToken).not.toBe(firstToken);
            expect(f.records.size).toBe(2);
            expect((await f.access.resolve(firstToken, "0")).sha256).toBe((await f.access.resolve(secondToken, "0")).sha256);
        });
        expect(f.records.size).toBe(1);
        expect((await f.access.resolve(firstToken, "0")).bytes).toEqual(await image());
    });
    expect(f.records.size).toBe(0);
    expect(f.deletes).toHaveLength(2);
});

test.each(["upstream error", "TimeoutError"])("%s cleans the same grant and preserves the original rejection without retry", async name => {
    const f = fixture();
    const error = Object.assign(new Error("original invocation error"), { name });
    let calls = 0;
    let token = "";
    await expect(f.access.run(ownerId, inputFor(dataUrl(await image())), async prepared => {
        calls++;
        token = tokenOf(imageUrls(prepared)[0]!);
        expect((await f.access.resolve(token, "0")).bytes).toEqual(await image());
        throw error;
    })).rejects.toBe(error);
    expect(calls).toBe(1);
    expect(f.records.size).toBe(0);
    expect(f.deletes).toEqual([cacheKey(token)]);
});

test("an unconfirmed deletion preserves success/original failure, with fail-closed reads and an independent 240s expiry", async () => {
    for (const fails of [false, true]) {
        const f = fixture();
        f.state.deleteFailure = true;
        const error = new Error("original provider error");
        let calls = 0;
        let token = "";
        const result = f.access.run(ownerId, inputFor(dataUrl(await image())), async prepared => {
            calls++;
            token = tokenOf(imageUrls(prepared)[0]!);
            if (fails) throw error;
            return "accepted";
        });
        if (fails) await expect(result).rejects.toBe(error);
        else expect(await result).toBe("accepted");
        expect(calls).toBe(1);
        expect(f.deletes).toHaveLength(1);
        expect(f.writes[0]!.options).toEqual({ EX: 240 });
        f.state.readFailure = true;
        await expect(f.access.resolve(token, "0")).rejects.toMatchObject({ status: 503 });
        f.state.readFailure = false;
        const key = cacheKey(token);
        f.records.set(key, JSON.stringify({ ...JSON.parse(f.records.get(key)!), expiresAt: Date.now() - 1 }));
        await expect(f.access.resolve(token, "0")).rejects.toMatchObject({ status: 404 });
    }
});

test("invalid, missing, expired and tampered grants cannot expose a preview", async () => {
    const f = fixture();
    await f.access.run(ownerId, inputFor(dataUrl(await image())), async prepared => {
        const token = tokenOf(imageUrls(prepared)[0]!);
        const key = cacheKey(token);
        const raw = f.records.get(key)!;
        const grant = JSON.parse(raw);
        for (const wrong of ["", ownerId, "A".repeat(64), "a".repeat(63), "b".repeat(64)])
            await expect(f.access.resolve(wrong, "0")).rejects.toMatchObject({ status: 404 });
        for (const index of ["-1", "00", "01", "1.0", "+0", " 0", "100", "1"])
            await expect(f.access.resolve(token, index)).rejects.toMatchObject({ status: 404 });
        for (const changed of [null, {}, { ...grant, expiresAt: Date.now() - 1 },
            { ...grant, images: [{ ...grant.images[0], length: grant.images[0].length + 1 }] },
            { ...grant, images: [{ ...grant.images[0], sha256: "0".repeat(64) }] },
            { ...grant, images: [{ ...grant.images[0], base64: Buffer.from("different").toString("base64") }] },
            { ...grant, images: [{ ...grant.images[0], mime: "image/svg+xml" }] }]) {
            f.records.set(key, JSON.stringify(changed));
            await expect(f.access.resolve(token, "0")).rejects.toMatchObject({ status: 404 });
        }
        f.records.set(key, "not-json");
        await expect(f.access.resolve(token, "0")).rejects.toMatchObject({ status: 404 });
        f.records.set(key, raw);
        expect((await f.access.resolve(token, "0")).bytes).toEqual(await image());
    });
});

test("disabled/deleted employees revoke both issuance and active public URLs", async () => {
    const input = inputFor(dataUrl(await image()));
    for (const changed of [{ userStatus: "disabled", userDeleted: false }, { userStatus: "locked", userDeleted: false }, { userStatus: "active", userDeleted: true }]) {
        const f = fixture();
        await f.access.run(ownerId, input, async prepared => {
            Object.assign(f.state, changed);
            await expect(f.access.resolve(tokenOf(imageUrls(prepared)[0]!), "0")).rejects.toMatchObject({ status: 404 });
            let called = false;
            await expect(f.access.run(ownerId, input, async () => { called = true; })).rejects.toMatchObject({ status: 404 });
            expect(called).toBe(false);
            expect(f.writes).toHaveLength(1);
        });
        expect(f.records.size).toBe(0);
    }
    const f = fixture();
    for (const id of ["not-a-uuid", "00000000-0000-4000-8000-000000000099"])
        await expect(f.access.run(id, input, async () => { throw new Error("must not invoke"); })).rejects.toMatchObject({ status: 404 });
    expect(f.writes).toHaveLength(0);
});

test("completion during an active-user lookup fails closed before any bytes are returned", async () => {
    const f = fixture();
    await f.access.run(ownerId, inputFor(dataUrl(await image())), async prepared => {
        const token = tokenOf(imageUrls(prepared)[0]!);
        f.onQuery(() => { f.records.delete(cacheKey(token)); });
        await expect(f.access.resolve(token, "0")).rejects.toMatchObject({ status: 404 });
        f.onQuery();
    });
});

test("cache/database outages expose only an empty 503 and do not leak internal messages", async () => {
    for (const failure of ["readFailure", "dbFailure"] as const) {
        const f = fixture();
        await withServer(f, async base => f.access.run(ownerId, inputFor(dataUrl(await image())), async prepared => {
            f.state[failure] = true;
            const response = await fetch(base + new URL(imageUrls(prepared)[0]!).pathname);
            expect(response.status).toBe(503);
            expect(response.headers.get("cache-control")).toBe("no-store");
            expect(await response.text()).toBe("");
        }));
        expect(f.records.size).toBe(0);
    }
});

test("text-only calls need no origin, employee lookup, grant, cleanup, or image transport", async () => {
    const f = fixture("");
    Object.assign(f.state, { dbFailure: true, readFailure: true, writeFailure: true, deleteFailure: true });
    const input: ChatCompletionInput = { input: [{ role: "user", content: "Hello." }], tools: [] };
    let calls = 0;
    expect(await f.access.run("not-a-user", input, async prepared => { calls++; expect(prepared).toBe(input); return "ok"; })).toBe("ok");
    expect(calls).toBe(1);
    expect(f.queries).toHaveLength(0);
    expect(f.writes).toHaveLength(0);
    expect(f.reads).toHaveLength(0);
    expect(f.deletes).toHaveLength(0);
});

test.each([
    ["remote URL", "https://supplier.example/image.png"], ["owned asset URL", "/api/assets/00000000-0000-4000-8000-000000000001/content"],
    ["javascript URL", "javascript:alert(1)"], ["blob URL", "blob:http://example.test/preview"],
    ["SVG", "data:image/svg+xml;base64,PHN2Zy8+"], ["empty data", "data:image/png;base64,"],
    ["noncanonical padding", "data:image/png;base64,AB=="], ["invalid base64", "data:image/png;base64,%%%"],
    ["non-image bytes", "data:image/png;base64,bm90LWFuLWltYWdl"],
])("%s is rejected before a real adapter POST or any grant", async (_name, url) => {
    const f = fixture();
    await withServer(f, async (base, requests) => {
        await expect(requestChatCompletion(carbonModel(base), { apiKey: "fixture-key" }, {
            ...inputFor(url), providerImages: { access: f.access, userId: ownerId },
        })).rejects.toMatchObject({ code: "CHAT_REFERENCE_INVALID", status: 400 });
        expect(requests).toHaveLength(0);
        expect(f.writes).toHaveLength(0);
        expect(f.queries).toHaveLength(0);
    });
});

test("MIME mismatch and a later invalid reference reject the whole request before publication", async () => {
    const f = fixture();
    const png = await image();
    const cases = [inputFor(dataUrl(png, "image/jpeg")), inputFor(dataUrl(png), "https://supplier.example/reference.png")];
    await withServer(f, async (base, requests) => {
        for (const input of cases) {
            await expect(requestChatCompletion(carbonModel(base), {}, { ...input, providerImages: { access: f.access, userId: ownerId } }))
                .rejects.toMatchObject({ code: "CHAT_REFERENCE_INVALID", status: 400 });
        }
        expect(requests).toHaveLength(0);
        expect(f.writes).toHaveLength(0);
    });
});

test("32-image, 4 MiB per-image and 12 MiB aggregate limits reject before any provider POST", async () => {
    const f = fixture();
    const png = await image();
    const padded = (length: number) => { const result = Buffer.alloc(length); png.copy(result); return result; };
    const overAggregate = dataUrl(padded(3 * 1024 * 1024 + 1));
    const cases = [
        { input: inputFor(...Array<string>(33).fill(dataUrl(png))), code: "CHAT_REFERENCE_LIMIT" },
        { input: inputFor(dataUrl(padded(maxImageBytes + 1))), code: "CHAT_REFERENCE_INVALID" },
        { input: inputFor(...Array<string>(4).fill(overAggregate)), code: "CHAT_REFERENCE_INVALID" },
    ];
    await withServer(f, async (base, requests) => {
        for (const item of cases) {
            await expect(requestChatCompletion(carbonModel(base), {}, { ...item.input, providerImages: { access: f.access, userId: ownerId } }))
                .rejects.toMatchObject({ code: item.code, status: 400 });
        }
        expect(requests).toHaveLength(0);
        expect(f.writes).toHaveLength(0);
        expect(f.queries).toHaveLength(0);
    });
}, 20_000);

test.each(["8194x2", "5000x4000"])("actual decoded dimensions %s fail before submission", async size => {
    const f = fixture();
    const bytes = await image("image/png", "blue", size);
    await withServer(f, async (base, requests) => {
        await expect(requestChatCompletion(carbonModel(base), {}, {
            ...inputFor(dataUrl(bytes)), providerImages: { access: f.access, userId: ownerId },
        })).rejects.toMatchObject({ code: "CHAT_REFERENCE_INVALID", status: 400 });
        expect(requests).toHaveLength(0);
        expect(f.writes).toHaveLength(0);
    });
}, 20_000);

test("missing origin, inactive user, and failed grant creation prevent provider submission", async () => {
    const input = inputFor(dataUrl(await image()));
    for (const mode of ["origin", "user", "database", "cache"] as const) {
        const f = fixture(mode === "origin" ? "" : origin);
        if (mode === "user") f.state.userStatus = "disabled";
        if (mode === "database") f.state.dbFailure = true;
        if (mode === "cache") f.state.writeFailure = true;
        await withServer(f, async (base, requests) => {
            await expect(requestChatCompletion(carbonModel(base), {}, { ...input, providerImages: { access: f.access, userId: ownerId } }))
                .rejects.toMatchObject(mode === "origin" ? { code: "PROVIDER_IMAGE_ORIGIN_REQUIRED", status: 503 }
                    : mode === "cache" ? { code: "PROVIDER_IMAGE_UNAVAILABLE", status: 503 } : { status: mode === "user" ? 404 : 503 });
            expect(requests).toHaveLength(0);
            expect(f.records.size).toBe(0);
        });
    }
});

test("URL support follows known protocol contracts without inventing native Gemini or Claude URL support", () => {
    for (const protocol of ["openai", "custom", "openai-chat", "apimart"])
        expect(supportsProviderChatImages({ protocol, model_id: "gemini-4-carbon" })).toBe(true);
    for (const model of [{ protocol: "apimart", model_id: "claude-sonnet-5-5" }, { protocol: "gemini", model_id: "gemini-4-carbon" },
        { protocol: "anthropic", model_id: "claude-sonnet-5-5" }, { protocol: "unknown", model_id: "unknown" }])
        expect(supportsProviderChatImages(model)).toBe(false);
});

test.each([
    ["apimart", "gemini-4-carbon", "/v1/chat/completions"], ["openai-chat", "compatible-chat", "/v1/chat/completions"],
    ["openai", "compatible-responses", "/v1/responses"], ["custom", "compatible-responses", "/v1/responses"],
    ["apimart", "gpt-6-astra", "/v1/responses"],
])("actual %s/%s adapter sends one POST containing only own-domain URLs, no supplier upload", async (protocol, modelId, path) => {
    const f = fixture();
    const bytes = [await image("image/png", "red"), await image("image/webp")];
    let seenUrls: string[] = [];
    let delivered: Buffer[] = [];
    let providerReadFailure: unknown;
    await withServer(f, async (base, requests) => {
        const result = await requestChatCompletion({ ...carbonModel(base), protocol, model_id: modelId }, { apiKey: "fixture-key" }, {
            ...inputFor(dataUrl(bytes[0]!), dataUrl(bytes[1]!, "image/webp")),
            providerImages: { access: f.access, userId: ownerId }, gemini: { maxOutputTokens: 321 },
        });
        if (providerReadFailure) throw providerReadFailure;
        expect(result.content).toBe("Two fixtures inspected.");
        expect(requests.map(request => [request.method, request.path])).toEqual([["POST", path]]);
        expect(requests[0]!.body.model).toBe(modelId);
        expect(JSON.stringify(requests[0]!.body)).not.toContain("data:image/");
        expect(JSON.stringify(requests[0]!.body)).not.toContain("providerImages");
        expect(JSON.stringify(requests[0]!.body)).not.toContain("fixture-key");
        expect(JSON.stringify(requests[0]!.body)).not.toContain("/uploads/images");
        if (protocol === "apimart") expect(requests[0]!.body.stream).toBe(false);
        if (modelId === "gemini-4-carbon") expect(requests[0]!.body.max_tokens).toBe(321);
        expect(delivered).toEqual(bytes);
        expect(seenUrls).toHaveLength(2);
        expect(tokenOf(seenUrls[0]!)).toBe(tokenOf(seenUrls[1]!));
        expect(f.writes).toHaveLength(1);
        expect(f.deletes).toHaveLength(1);
        expect(f.records.size).toBe(0);
        expect((await fetch(base + new URL(seenUrls[0]!).pathname)).status).toBe(404);
    }, async (request, response, base) => {
        try {
            const body = request.body;
            seenUrls = path.endsWith("/responses") ? imageUrls({ input: body.input, tools: [] })
                : body.messages.flatMap((item: { content: unknown }) => Array.isArray(item.content)
                    ? item.content.flatMap((part: { type: string; image_url?: { url: string } }) => part.type === "image_url" ? [part.image_url!.url] : []) : []);
            delivered = [];
            for (const url of seenUrls) {
                expect(new URL(url).origin).toBe(origin);
                const preview = await fetch(base + new URL(url).pathname);
                expect(preview.status).toBe(200);
                delivered.push(Buffer.from(await preview.arrayBuffer()));
            }
        } catch (error) { providerReadFailure = error; }
        response.json(path.endsWith("/responses")
            ? { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Two fixtures inspected." }] }] }
            : completion);
    });
});

test.each(["rejected", "invalid-json"])("actual adapter %s response cleans authorization without resubmission or endpoint fallback", async mode => {
    const f = fixture();
    await withServer(f, async (base, requests) => {
        await expect(requestChatCompletion(carbonModel(base), {}, {
            ...inputFor(dataUrl(await image())), providerImages: { access: f.access, userId: ownerId },
        })).rejects.toBeInstanceOf(Error);
        expect(requests.map(request => [request.method, request.path])).toEqual([["POST", "/v1/chat/completions"]]);
        expect(f.writes).toHaveLength(1);
        expect(f.deletes).toHaveLength(1);
        expect(f.records.size).toBe(0);
    }, (_request, response) => mode === "rejected"
        ? void response.status(503).json({ error: { message: "fixture rejection" } })
        : void response.type("application/json").send("not-json"));
});

test("actual text-only adapter succeeds with zero grants even when image infrastructure is unavailable", async () => {
    const f = fixture("");
    Object.assign(f.state, { dbFailure: true, readFailure: true, writeFailure: true, deleteFailure: true });
    await withServer(f, async (base, requests) => {
        const result = await requestChatCompletion(carbonModel(base), {}, {
            input: [{ role: "user", content: "Text only." }], tools: [], providerImages: { access: f.access, userId: ownerId },
        });
        expect(result.content).toBe("Two fixtures inspected.");
        expect(requests).toHaveLength(1);
        expect(f.queries).toHaveLength(0);
        expect(f.writes).toHaveLength(0);
        expect(f.reads).toHaveLength(0);
        expect(f.deletes).toHaveLength(0);
    }, (_request, response) => { response.json(completion); });
});
