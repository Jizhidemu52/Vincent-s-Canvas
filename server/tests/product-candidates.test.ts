import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import * as billing from "../src/chat-billing";
import * as transport from "../src/provider-submission-transport";
import type { Cache, Database } from "../src/db";
import { createChatRouter } from "../src/routes/chat";
import { encryptSecret } from "../src/security";
import { openProductCandidatesReceiptConnection } from "../src/product-candidates-redis";
import {
    claimProductCandidatesReceipt, finishProductCandidatesReceipt, publicProductCandidatesReceipt,
    readProductCandidateSource, readProductCandidatesReceipt, productCandidatesRequestSchema,
    productCandidatesProfileInput, validateProductCandidatesOutput, PRODUCT_CANDIDATES_SYSTEM,
} from "../src/product-candidates";

const assetId = "06ece6a3-32db-435f-abcd-54a59a628c11";
const otherAssetId = "06ece6a3-32db-435f-abcd-54a59a628c22";
const base = { requestId: "candidate-request-1", toolKey: "gpt-chat", profile: "product-candidates", profileContext: { sourceAssetId: assetId }, input: [], tools: [] };
const bytes = Buffer.from("test-owned-image");
const sourceHash = createHash("sha256").update(bytes).digest("hex");
const candidate = { id: "candidate-1", name: "左侧红色毛衫", brief: "短袖红色针织上衣", evidence: "画面左侧，圆领和五粒扣可见" };
const providerResponse = (candidates: unknown = [candidate]) => Response.json({ status: "completed", output: [
    { type: "function_call", id: "candidate-output", call_id: "report-1", name: "report_product_candidates", arguments: JSON.stringify({ candidates }) },
] });

function memoryCache() {
    const values = new Map<string, string>();
    let failRead = false, failClaim = false, failFinish = false;
    const cache: Pick<Cache, "get" | "eval"> = {
        get: async key => { if (failRead) throw new Error("redis unavailable"); return values.get(key) ?? null; },
        eval: async (script, options) => {
            const key = options.keys[0]!;
            if (script.includes("product-candidates-claim-v1")) {
                if (failClaim) throw new Error("redis unavailable");
                const existing = values.get(key);
                if (existing) return [0, existing];
                values.set(key, options.arguments[0]!); return [1, options.arguments[0]!];
            }
            if (script.includes("product-candidates-finish-v1")) {
                if (failFinish) throw new Error("redis unavailable");
                const raw = values.get(key);
                if (!raw) return 0;
                const current = JSON.parse(raw);
                if (current.token !== options.arguments[0] || current.receipt.status !== "processing") return 0;
                values.set(key, options.arguments[1]!); return 1;
            }
            throw new Error("Unexpected Redis script");
        },
    };
    return { cache, values, unavailable: (part: "read" | "claim" | "finish") => { if (part === "read") failRead = true; if (part === "claim") failClaim = true; if (part === "finish") failFinish = true; } };
}

test("bounded observation input uses one server image, one report tool and no stream", () => {
    const prepared = productCandidatesProfileInput({ previewDataUrl: "data:image/png;base64,AA==" });
    expect(prepared.input.tools.map(tool => tool.name)).toEqual(["report_product_candidates"]);
    expect(prepared.input.toolChoice).toEqual({ type: "function", name: "report_product_candidates" });
    expect(prepared.input.claude).toEqual({ stream: false, thinking: false, maxTokens: 2048 });
    expect(prepared.input.webSearch).toBe(false);
    expect(prepared.input.input).toHaveLength(2);
    const checked = validateProductCandidatesOutput({ content: "must not leak", responsesOutputItems: [{ type: "reasoning", encrypted_content: "secret" }],
        toolCalls: [{ id: "report", type: "function", function: { name: "report_product_candidates", arguments: JSON.stringify({ candidates: [candidate] }) } }] });
    expect(checked.content).toBe(""); expect(checked).not.toHaveProperty("responsesOutputItems");
    for (const candidates of [Array(9).fill(candidate), [candidate, candidate], [{ ...candidate, mask: [1, 2] }], [{ ...candidate, id: "invented" }]]) {
        expect(() => validateProductCandidatesOutput({ content: "", toolCalls: [{ id: "x", type: "function", function: { name: "report_product_candidates", arguments: JSON.stringify({ candidates }) } }] })).toThrow();
    }
});

test("atomic claims bind owner, immutable source hash and terminal state without TTL", async () => {
    const state = memoryCache(), request = productCandidatesRequestSchema.parse(base);
    const claims = await Promise.all(Array.from({ length: 25 }, () => claimProductCandidatesReceipt(state.cache, "owner-a", request, sourceHash, "model-1")));
    expect(claims.filter(claim => claim.execute)).toHaveLength(1);
    expect(state.values.size).toBe(1);
    expect(await readProductCandidatesReceipt(state.cache, "owner-b", request.requestId)).toBeNull();
    await expect(claimProductCandidatesReceipt(state.cache, "owner-a", request, "changed", "model-1")).rejects.toMatchObject({ code: "PRODUCT_CANDIDATES_REQUEST_CHANGED" });
    const first = claims[0]!.stored;
    await expect(finishProductCandidatesReceipt(state.cache, { ...first, token: "wrong" }, { status: "success", candidates: [] })).rejects.toMatchObject({ status: 503 });
    await finishProductCandidatesReceipt(state.cache, first, { status: "success", candidates: [candidate] });
    await expect(finishProductCandidatesReceipt(state.cache, first, { status: "failed" })).rejects.toMatchObject({ status: 503 });
    expect((await readProductCandidatesReceipt(state.cache, "owner-a", request.requestId))!.receipt.candidates).toEqual([candidate]);
    const old = { ...first, receipt: { ...first.receipt, createdAt: new Date(Date.now() - 6 * 60_000).toISOString() } };
    expect(publicProductCandidatesReceipt(old).status).toBe("uncertain");
    expect(old.receipt.status).toBe("processing");
});

test("source validation checks owner, ready image, byte length, hash and final metadata", async () => {
    let metadata = { objectKey: "private/original", mimeType: "image/png", byteSize: bytes.length, contentHash: sourceHash };
    const queries: unknown[][] = [];
    const db = { query: async (sql: string, args: unknown[]) => { queries.push([sql, args]); return { rows: args[1] === "owner" ? [metadata] : [] }; } } as unknown as Database;
    let reads = 0;
    const runtime = { readObject: async () => { reads++; return { bytes, contentLength: bytes.length }; }, makePreview: async () => ({ bytes, mimeType: "image/png", previewDataUrl: "data:image/png;base64,AA==" }) };
    expect((await readProductCandidateSource(db, {} as never, "owner", assetId, runtime)).sourceHash).toBe(sourceHash);
    expect(queries[0]![0]).toContain("kind='image' AND status='ready' AND deleted_at IS NULL");
    await expect(readProductCandidateSource(db, {} as never, "other", assetId, runtime)).rejects.toMatchObject({ status: 403 });
    expect(reads).toBe(1);
    metadata = { ...metadata, byteSize: 10 * 1024 * 1024 + 1 };
    await expect(readProductCandidateSource(db, {} as never, "owner", assetId, runtime)).rejects.toMatchObject({ status: 400 });
    metadata = { ...metadata, byteSize: bytes.length, contentHash: "a".repeat(64) };
    await expect(readProductCandidateSource(db, {} as never, "owner", assetId, runtime)).rejects.toMatchObject({ status: 409 });
    metadata = { ...metadata, contentHash: sourceHash };
    await expect(readProductCandidateSource(db, {} as never, "owner", assetId, { ...runtime, makePreview: async () => { metadata = { ...metadata, objectKey: "changed" }; return runtime.makePreview(); } })).rejects.toMatchObject({ status: 409 });
});

async function httpFixture(provider: (body: Record<string, any>) => Response | Promise<Response>, run: (state: {
    post: (patch?: Record<string, unknown>, owner?: string) => Promise<Response>;
    get: (id?: string, owner?: string) => Promise<Response>; calls: Record<string, any>[];
    holds: () => number; settlements: boolean[]; dbWrites: unknown[][]; cacheState: ReturnType<typeof memoryCache>;
    faults: Set<string>; connectionEvents: string[];
}) => Promise<void>) {
    const encryptionKey = Buffer.alloc(32, 7).toString("base64");
    const cacheState = memoryCache(), calls: Record<string, any>[] = [], settlements: boolean[] = [], dbWrites: unknown[][] = [];
    const faults = new Set<string>(), connectionEvents: string[] = [];
    let connectionSequence = 0;
    const connectionParent = { duplicate: (options: unknown) => {
        expect(options).toMatchObject({ disableOfflineQueue: true, socket: { reconnectStrategy: false, connectTimeout: 5000 }, commandOptions: { timeout: 7500 } });
        const id = ++connectionSequence;
        let phase = "";
        const connection = { isOpen: true, on: () => connection, connect: async () => { connectionEvents.push(`open:${id}`); },
            get: cacheState.cache.get, eval: async (script: string, options: { keys: string[]; arguments: string[] }) => {
                phase = script.includes("claim-v1") ? "claim" : "finish";
                connectionEvents.push(`write:${id}:${phase}`);
                return cacheState.cache.eval(script, options);
            },
            sendCommand: async (command: string[]) => {
                expect(command).toEqual(["WAITAOF", "1", "0", "5000"]);
                connectionEvents.push(`confirm:${id}:${phase}`);
                if (faults.has(`aof-${phase}`)) return [0, 0];
                return [1, 0];
            }, destroy: () => { connection.isOpen = false; connectionEvents.push(`close:${id}`); } };
        return connection;
    } };
    const db = { query: async (sql: string, args: unknown[]) => {
        if (sql.includes("FROM assets")) return { rows: args[0] === assetId && args[1] === "owner-a" ? [{ objectKey: "private/original", mimeType: "image/png", byteSize: bytes.length, contentHash: sourceHash }] : [] };
        if (sql.includes("FROM module_flags")) return { rows: [{ enabled: true }] };
        if (sql.includes("FROM tool_api_configurations")) return { rows: [{ toolKey: "gpt-chat", modelConfigId: "model-1", enabled: true, creditCostOverride: 2, rmbCostOverride: 0, configurationVersion: 1 }] };
        if (sql.includes("FROM credit_policy")) return { rows: [{ creditsEnabled: true }] };
        if (sql.includes("FROM model_configs")) return { rows: [{ id: "model-1", modelId: "gpt-6-astra", model_id: "gpt-6-astra", enabled: true, providerEnabled: true, capabilities: ["chat"], protocol: "apimart", base_url: "https://not-submitted.invalid/v1", encrypted_credentials: encryptSecret(JSON.stringify({ apiKey: "fixture-secret" }), encryptionKey) }] };
        if (sql.includes("INSERT INTO audit_logs") || sql.startsWith("INSERT INTO usage_chat_requests") || sql.startsWith("UPDATE usage_chat_requests")) {
            dbWrites.push([sql, args]);
            if (sql.includes("INSERT INTO audit_logs") && faults.has("audit")) throw new Error("private audit failure");
            if (sql.startsWith("UPDATE usage_chat_requests") && faults.has("usage")) throw new Error("private usage failure");
            return { rows: [] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
    } } as unknown as Database;
    const begin = spyOn(billing, "beginChatBilling").mockResolvedValue("hold-1");
    const finish = spyOn(billing, "finishChatBilling").mockImplementation(async (_db, _reservation, success) => {
        settlements.push(success); if (faults.has(success ? "capture" : "release")) throw new Error("private settlement failure");
    });
    const upstream = spyOn(transport, "fetchProviderSubmission").mockImplementation(async (_url, init) => { const body = JSON.parse(String(init?.body)); calls.push(body); connectionEvents.push("provider"); return provider(body); });
    const app = express(); app.use(express.json());
    app.use((request, _response, next) => { Object.assign(request, { auth: { id: request.headers["x-owner"] || "owner-a", role: "designer", departmentId: null } }); next(); });
    app.use("/api/chat", createChatRouter(db, { AUTH_ENABLED: "true", CREDITS_ENABLED: "true", PROVIDER_ENCRYPTION_KEY: encryptionKey } as never, {
        productCandidates: { cache: cacheState.cache, openReceiptConnection: () => openProductCandidatesReceiptConnection(connectionParent as never), sourceRuntime: { readObject: async () => ({ bytes, contentLength: bytes.length }), makePreview: async () => ({ bytes, mimeType: "image/png", previewDataUrl: "data:image/png;base64,AA==" }) } },
    }));
    app.use(((error, _request, response, _next) => { response.status(502).json({ error: error.code }); }) as ErrorRequestHandler);
    const server = app.listen(0, "127.0.0.1");
    try {
        await new Promise<void>(resolve => server.once("listening", resolve));
        const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing port");
        const url = `http://127.0.0.1:${address.port}/api/chat/responses`;
        const post = (patch = {}, owner = "owner-a") => fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-owner": owner }, body: JSON.stringify({ ...base, ...patch }), signal: AbortSignal.timeout(5000) });
        const get = (id = base.requestId, owner = "owner-a") => fetch(`${url}/${id}?profile=product-candidates`, { headers: { "x-owner": owner }, signal: AbortSignal.timeout(5000) });
        await run({ post, get, calls, holds: () => begin.mock.calls.length, settlements, dbWrites, cacheState, faults, connectionEvents });
    } finally {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        upstream.mockRestore(); finish.mockRestore(); begin.mockRestore();
    }
}

test("HTTP success is bare, recoverable and idempotent; only the server report tool is submitted", async () => {
    await httpFixture(() => providerResponse(), async state => {
        const response = await state.post(); expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const receipt = await response.json(); expect(receipt).toMatchObject({ profile: "product-candidates", requestId: base.requestId, sourceAssetId: assetId, status: "success", candidates: [candidate] });
        expect(receipt).not.toHaveProperty("content"); expect(receipt).not.toHaveProperty("token"); expect(receipt).not.toHaveProperty("receipt");
        expect(await (await state.get()).json()).toEqual(receipt);
        expect(await (await state.post()).json()).toEqual(receipt);
        expect(state.calls).toHaveLength(1); expect(state.holds()).toBe(1); expect(state.settlements).toEqual([true]);
        expect(state.calls[0]!.stream).toBe(false); expect(state.calls[0]!.tool_choice).toEqual({ type: "function", name: "report_product_candidates" });
        expect(state.calls[0]!.tools.map((tool: any) => tool.name)).toEqual(["report_product_candidates"]);
        expect(state.connectionEvents).toEqual(["open:1", "write:1:claim", "confirm:1:claim", "close:1", "provider", "open:2", "write:2:finish", "confirm:2:finish", "close:2"]);
        expect(JSON.stringify([receipt, state.dbWrites])).not.toContain(PRODUCT_CANDIDATES_SYSTEM);
        expect(JSON.stringify(state.dbWrites)).not.toContain("private/original");
        expect((await state.get(base.requestId, "owner-b")).status).toBe(404);
        expect((await state.get("missing-request")).status).toBe(404);
        expect((await state.post({ profileContext: { sourceAssetId: otherAssetId } })).status).toBe(409);
        expect((await state.post({ requestId: "other-owner-request" }, "owner-b")).status).toBe(403);
        expect(state.calls).toHaveLength(1);
    });
});

test("HTTP concurrent POST returns processing while one original request completes", async () => {
    let finish!: () => void, entered!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    await httpFixture(async () => { entered(); await pending; return providerResponse([]); }, async state => {
        const original = state.post(); await started;
        const responses = await Promise.all(Array.from({ length: 8 }, () => state.post()));
        for (const response of responses) expect((await response.json()).status).toBe("processing");
        expect((await (await state.get()).json()).status).toBe("processing");
        expect(state.calls).toHaveLength(1); finish();
        expect((await (await original).json()).status).toBe("success"); expect(state.holds()).toBe(1);
    });
});

test("HTTP unknown upstream failure is durable uncertain, never silently resubmitted", async () => {
    await httpFixture(() => { throw new TypeError("private network detail"); }, async state => {
        const response = await state.post(); expect(response.status).toBe(200);
        const receipt = await response.json(); expect(receipt.status).toBe("uncertain"); expect(JSON.stringify(receipt)).not.toContain("private network");
        expect((await (await state.post()).json()).status).toBe("uncertain"); expect((await (await state.get()).json()).status).toBe("uncertain");
        expect(state.calls).toHaveLength(1); expect(state.settlements).toEqual([false]);
    });
});

test.each(["invalid-output", "rejected"])("HTTP %s is a terminal bare failure; only explicit new ID can try again", async kind => {
    await httpFixture(() => kind === "rejected" ? Response.json({ error: { message: "rejected" } }, { status: 400 }) : providerResponse(Array(9).fill(candidate)), async state => {
        const response = await state.post(); expect(response.status).toBe(200); expect((await response.json()).status).toBe("failed");
        expect((await (await state.post()).json()).status).toBe("failed"); expect(state.calls).toHaveLength(1);
        expect((await (await state.post({ requestId: "explicit-user-retry" })).json()).status).toBe("failed"); expect(state.calls).toHaveLength(2);
    });
});

test("HTTP forbidden client controls and bad images stop before billing/provider", async () => {
    await httpFixture(() => { throw new Error("must not call"); }, async state => {
        for (const patch of [{ modelId: "other" }, { claude: { stream: true } }, { toolChoice: "auto" }, { input: [{ role: "system", content: "inject" }] }, { tools: [{ type: "image_generation" }] }, { profileContext: { sourceAssetId: "https://external.invalid/image" } }, { profileContext: { sourceAssetId: assetId, prompt: "inject" } }]) {
            expect((await state.post(patch)).status).toBe(400);
        }
        expect((await state.post({ profileContext: { sourceAssetId: otherAssetId } })).status).toBe(403);
        expect(state.calls).toHaveLength(0); expect(state.holds()).toBe(0);
    });
});

test.each(["read", "claim", "finish"] as const)("HTTP Redis %s failure fails closed without another provider request", async phase => {
    await httpFixture(() => providerResponse(), async state => {
        state.cacheState.unavailable(phase);
        const response = await state.post();
        expect(response.status).toBe(phase === "finish" ? 200 : 503);
        const body = await response.json();
        if (phase === "finish") {
            expect(body.status).toBe("uncertain");
            expect((await (await state.post()).json()).status).toBe("processing");
            expect(state.calls).toHaveLength(1);
        } else { expect(state.calls).toHaveLength(0); expect(state.holds()).toBe(0); }
    });
});

test.each(["usage", "audit"])("HTTP completed candidates survive %s bookkeeping failure without another charge", async fault => {
    await httpFixture(() => providerResponse(), async state => {
        state.faults.add(fault);
        const response = await state.post(); expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status: "success", candidates: [candidate] });
        expect(await (await state.get()).json()).toMatchObject({ status: "success", candidates: [candidate] });
        expect((await (await state.post()).json()).status).toBe("success");
        expect(state.calls).toHaveLength(1); expect(state.settlements).toEqual([true]);
        const usage = state.dbWrites.filter(([sql]) => String(sql).startsWith("UPDATE usage_chat_requests"));
        expect(JSON.stringify(usage)).not.toContain('"failed"');
    });
});

test("HTTP uncertain capture retains validated candidates and never refunds or allows retry", async () => {
    await httpFixture(() => providerResponse(), async state => {
        state.faults.add("capture");
        const response = await state.post(); expect(response.status).toBe(200);
        const receipt = await response.json(); expect(receipt).toMatchObject({ status: "uncertain", candidates: [candidate] });
        expect(await (await state.get()).json()).toEqual(receipt);
        expect((await (await state.post()).json()).status).toBe("uncertain");
        expect(state.calls).toHaveLength(1); expect(state.settlements).toEqual([true]);
        expect(JSON.stringify(state.dbWrites.filter(([sql]) => String(sql).startsWith("UPDATE usage_chat_requests")))).not.toContain('"failed"');
    });
});

test("HTTP uncertain refund is not downgraded to retryable failure", async () => {
    await httpFixture(() => Response.json({ error: "bad request" }, { status: 400 }), async state => {
        state.faults.add("release");
        expect((await (await state.post()).json()).status).toBe("uncertain");
        expect((await (await state.post()).json()).status).toBe("uncertain");
        expect(state.calls).toHaveLength(1); expect(state.settlements).toEqual([false]);
    });
});

test("HTTP unconfirmed claim AOF never starts billing or provider and stays on the original ID", async () => {
    await httpFixture(() => providerResponse(), async state => {
        state.faults.add("aof-claim");
        const response = await state.post(); expect(response.status).toBe(200);
        expect((await response.json()).status).toBe("uncertain");
        expect((await (await state.post()).json()).status).toBe("uncertain");
        expect(state.calls).toHaveLength(0); expect(state.holds()).toBe(0); expect(state.settlements).toEqual([]);
        expect(state.connectionEvents).toEqual(["open:1", "write:1:claim", "confirm:1:claim", "close:1", "open:2", "write:2:finish", "confirm:2:finish", "close:2"]);
    });
});

test("HTTP terminal persistence uncertainty does not overwrite valid result or refund captured charge", async () => {
    await httpFixture(() => providerResponse(), async state => {
        state.faults.add("aof-finish");
        const response = await state.post(); expect(response.status).toBe(200);
        // The bounded recovery read proves the success write is present; no new
        // provider call or attempted downgrade of that terminal result follows.
        expect(await response.json()).toMatchObject({ status: "success", candidates: [candidate] });
        expect((await (await state.get()).json()).status).toBe("success");
        expect(state.calls).toHaveLength(1); expect(state.settlements).toEqual([true]);
    });
});
