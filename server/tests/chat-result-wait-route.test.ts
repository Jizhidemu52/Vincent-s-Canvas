import { expect, spyOn, test } from "bun:test";
import express, { type ErrorRequestHandler } from "express";
import * as billing from "../src/chat-billing";
import type { ChatResultWaitClock } from "../src/chat-result-wait";
import type { Database } from "../src/db";
import { CANVAS_ASSISTANT_SYSTEM_PROMPT } from "../src/prompt-chat-profiles";
import * as transport from "../src/provider-submission-transport";
import { createChatRouter } from "../src/routes/chat";
import { encryptSecret } from "../src/security";

const prompt = "继续把衬衫改成蓝色";
const input = { requestId: "wait-request-1", toolKey: "canvas-chat", profile: "canvas-assistant",
    profileContext: { stage: "plan", currentUserText: prompt, imageCatalog: [], previewImageIds: [], newCreation: false, workNote: "" },
    input: [{ role: "user", content: prompt }], tools: [] };
const completed = (content = "已继续检查，可以按这次要求调整。") => Response.json({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 8, total_cost: 0.2 } });

async function fixture(run: (state: {
    post: (body?: Record<string, unknown>, accept?: string, signal?: AbortSignal) => Promise<Response>;
    calls: any[]; budgets: number[]; settlements: boolean[]; events: string[]; intervals: Map<() => void, number>;
    advance: (milliseconds: number) => void; release: (response?: Response) => void;
}) => Promise<void>, options: { model?: string; provider?: (signal: AbortSignal) => Promise<Response> | Response; writeFailure?: "audit" | "usage" } = {}) {
    const encryptionKey = Buffer.alloc(32, 9).toString("base64");
    const calls: any[] = [], budgets: number[] = [], settlements: boolean[] = [], events: string[] = [];
    const pending = Promise.withResolvers<Response>();
    let elapsed = 0;
    const intervals = new Map<() => void, number>();
    const deadlines: Array<{ controller: AbortController; deadline: number }> = [];
    const waitClock: ChatResultWaitClock = { now: () => elapsed, every: (callback, milliseconds) => {
        intervals.set(callback, milliseconds);
        return () => { intervals.delete(callback); };
    } };
    const db = { query: async (sql: string, values: unknown[]) => {
        if (sql.includes("FROM module_flags")) return { rows: [{ enabled: true }] };
        if (sql.includes("FROM tool_api_configurations")) return { rows: [{ toolKey: "canvas-chat", modelConfigId: "wait-model", enabled: true, creditCostOverride: 2, rmbCostOverride: 0, configurationVersion: 1 }] };
        if (sql.includes("FROM credit_policy")) return { rows: [{ creditsEnabled: true }] };
        if (sql.includes("FROM model_configs")) return { rows: [{ id: "wait-model", modelId: options.model || "gemini-4-carbon", model_id: options.model || "gemini-4-carbon", enabled: true, providerEnabled: true, capabilities: ["chat", "vision"], protocol: "apimart", base_url: "https://never-submitted.invalid/v1", encrypted_credentials: encryptSecret(JSON.stringify({ apiKey: "private-fixture-key" }), encryptionKey) }] };
        if (sql.startsWith("INSERT INTO usage_chat_requests")) { events.push("usage:start"); return { rows: [] }; }
        if (sql.startsWith("UPDATE usage_chat_requests")) {
            events.push(`usage:${values[1]}`);
            if (options.writeFailure === "usage" && values[1] === "success") throw new Error("private database detail");
            return { rows: [] };
        }
        if (sql.includes("INSERT INTO audit_logs")) {
            events.push("audit");
            if (options.writeFailure === "audit") throw new Error("private audit detail");
            return { rows: [] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
    } } as unknown as Database;
    const begin = spyOn(billing, "beginChatBilling").mockResolvedValue("held-wait-fixture");
    const finish = spyOn(billing, "finishChatBilling").mockImplementation(async (_db, _reservation, success) => { settlements.push(success); events.push(`billing:${success}`); });
    const upstream = spyOn(transport, "fetchProviderSubmission").mockImplementation(async (_url, init) => {
        calls.push(JSON.parse(String(init.body))); events.push("provider");
        return options.provider ? options.provider(init.signal!) : pending.promise;
    });
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
        budgets.push(milliseconds);
        const controller = new AbortController();
        deadlines.push({ controller, deadline: elapsed + milliseconds });
        return controller.signal;
    });
    const logging = spyOn(console, "error").mockImplementation(() => {});
    const app = express(); app.use(express.json());
    app.use((request, _response, next) => { Object.assign(request, { auth: { id: "wait-user", role: "designer", departmentId: null } }); next(); });
    app.use("/chat", createChatRouter(db, { AUTH_ENABLED: "true", CREDITS_ENABLED: "true", PROVIDER_ENCRYPTION_KEY: encryptionKey } as never, { waitClock }));
    app.use(((error, _request, response, _next) => { response.status(502).json({ error: error.code, message: error.message }); }) as ErrorRequestHandler);
    const server = app.listen(0, "127.0.0.1");
    try {
        await new Promise<void>(resolve => server.once("listening", resolve));
        const address = server.address(); if (!address || typeof address === "string") throw new Error("No port");
        await run({ calls, budgets, settlements, events, intervals,
            post: (body = {}, accept = "text/event-stream", signal) => fetch(`http://127.0.0.1:${address.port}/chat/responses`, {
                method: "POST", headers: { "content-type": "application/json", accept }, body: JSON.stringify({ ...input, ...body }), signal,
            }),
            advance: milliseconds => {
                elapsed += milliseconds;
                for (const callback of intervals.keys()) callback();
                for (const entry of deadlines) if (entry.deadline <= elapsed) entry.controller.abort(new DOMException("fixture deadline", "TimeoutError"));
            },
            release: (response = completed()) => pending.resolve(response),
        });
    } finally {
        pending.resolve(completed());
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        timeout.mockRestore(); upstream.mockRestore(); finish.mockRestore(); begin.mockRestore(); logging.mockRestore();
    }
}

test("Carbon waiting survives the old 180s deadline with one call and sends result only after safe settlement", async () => {
    await fixture(async state => {
        const response = await state.post();
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        expect(response.headers.get("x-accel-buffering")).toBe("no");
        expect(state.budgets).toEqual([600_000]);
        expect(state.calls).toHaveLength(1);
        expect(state.settlements).toEqual([]);
        expect([...state.intervals.values()]).toEqual([15_000]);
        state.advance(187_138);
        expect(state.settlements).toEqual([]);
        state.release();
        const wire = await response.text();
        expect(wire).toContain("仍在处理原请求");
        expect(wire).toContain("event: chat_result");
        expect(wire).not.toContain("event: error");
        expect(wire).not.toContain("usage");
        expect(wire).not.toContain(CANVAS_ASSISTANT_SYSTEM_PROMPT);
        expect(state.events).toEqual(["usage:start", "provider", "usage:success", "audit", "billing:true"]);
        expect(state.settlements).toEqual([true]);
        expect(state.calls).toHaveLength(1);
        expect(state.calls[0]).not.toHaveProperty("waitForResult");
        expect(state.intervals.size).toBe(0);
    });
});

test("Carbon waiting has one final 600s timeout error, a refund and no success marker or retry", async () => {
    await fixture(async state => {
        const response = await state.post();
        state.advance(600_000);
        const wire = await response.text();
        expect(wire).toContain('event: error\ndata: {"type":"error","error":{"code":"CHAT_REQUEST_TIMEOUT"');
        expect(wire).toContain("600 秒");
        expect(wire).not.toContain("event: chat_result");
        expect(wire).not.toContain("repairable");
        expect(wire).not.toContain("submitted");
        expect(state.settlements).toEqual([false]);
        expect(state.calls).toHaveLength(1);
        expect(state.events).toEqual(["usage:start", "provider", "billing:false", "usage:failed"]);
        expect(state.intervals.size).toBe(0);
    }, { provider: signal => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) });
});

test.each(["audit", "usage"] as const)("a %s bookkeeping failure cannot turn waiting heartbeats into a successful completion", async writeFailure => {
    await fixture(async state => {
        const response = await state.post(); state.release();
        const wire = await response.text();
        expect(wire).toContain("event: error");
        expect(wire).not.toContain("event: chat_result");
        expect(wire).not.toContain("private");
        expect(state.settlements).toEqual([false]);
        expect(state.calls).toHaveLength(1);
    }, { writeFailure });
});

test("private output is validated before the terminal result and never enters a waiting error", async () => {
    await fixture(async state => {
        const response = await state.post(); state.release(completed(CANVAS_ASSISTANT_SYSTEM_PROMPT));
        const wire = await response.text();
        expect(wire).toContain('"code":"PROMPT_OUTPUT_REJECTED"');
        expect(wire).not.toContain("event: chat_result");
        expect(wire).not.toContain(CANVAS_ASSISTANT_SYSTEM_PROMPT);
        expect(state.settlements).toEqual([false]);
        expect(state.calls).toHaveLength(1);
    });
});

test("only a confirmed unsubmitted invalid image plan retains repair metadata in its terminal SSE error", async () => {
    await fixture(async state => {
        const response = await state.post();
        state.release(Response.json({ choices: [{ message: { content: "", tool_calls: [
            { id: "invalid-plan", type: "function", function: { name: "edit_image", arguments: "{}" } },
        ] }, finish_reason: "tool_calls" }] }));
        const wire = await response.text();
        const terminal = wire.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).at(-1);
        expect(terminal).toEqual({ type: "error", error: { code: "IMAGE_AGENT_ARGUMENTS_INVALID", message: expect.any(String), repairable: true, submitted: false } });
        expect(wire).not.toContain("event: chat_result");
        expect(state.settlements).toEqual([false]);
        expect(state.calls).toHaveLength(1);
        expect(state.events).not.toContain("audit");
    });
});

test("transport errors cannot impersonate a repairable unsubmitted image plan", async () => {
    await fixture(async state => {
        const response = await state.post(), wire = await response.text();
        expect(wire).toContain("event: error");
        expect(wire).not.toContain("repairable");
        expect(wire).not.toContain("submitted");
        expect(wire).not.toContain("private transport detail");
        expect(state.calls).toHaveLength(1);
        expect(state.settlements).toEqual([false]);
    }, { provider: () => { throw Object.assign(new Error("private transport detail"), { repairable: true, submitted: false }); } });
});

test.each(["ordinary", "json"])("%s requests cannot inject waiting or a client-chosen timeout", async variant => {
    await fixture(async state => {
        state.release();
        const body = { ...(variant === "ordinary" ? { profile: undefined, profileContext: undefined } : {}), privateProfile: true, waitForResult: true, resultTimeoutMs: 99_000_000 };
        const response = await state.post(body, variant === "json" ? "application/json" : "text/event-stream");
        expect(response.headers.get("content-type")).toContain("application/json");
        expect((await response.json()).content).toContain("继续检查");
        expect(state.budgets).toEqual([180_000]);
        expect(state.intervals.size).toBe(0);
        expect(state.calls).toHaveLength(1);
    });
});

test("non-Carbon private waiting keeps the original provider deadline", async () => {
    await fixture(async state => {
        const response = await state.post(); state.release();
        expect(await response.text()).toContain("event: chat_result");
        expect(state.budgets).toEqual([180_000]);
    }, { model: "gpt-6-sol" });
});

test("Claude private streaming with the new Accept header keeps its existing events and 180s deadline", async () => {
    const events = [
        { type: "message_start", message: { id: "fixture" } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "继续调整衬衫。" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" },
    ];
    await fixture(async state => {
        const response = await state.post({ claude: { stream: true, thinking: false } });
        const wire = await response.text();
        expect(wire).toContain("message_stop");
        expect(wire).not.toContain("chat_waiting");
        expect(wire).not.toContain("chat_result");
        expect(state.budgets).toEqual([180_000]);
        expect(state.intervals.size).toBe(0);
        expect(state.settlements).toEqual([true]);
        expect(state.calls).toHaveLength(1);
    }, { model: "claude-sonnet-5-5", provider: () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }) });
});

test("disconnecting the browser never resubmits and late completion releases the held reservation", async () => {
    await fixture(async state => {
        const controller = new AbortController();
        const response = await state.post({}, "text/event-stream", controller.signal);
        const reader = response.body!.getReader();
        await reader.read(); controller.abort();
        await reader.cancel().catch(() => {});
        for (let count = 0; count < 50 && state.intervals.size; count++) { await Bun.sleep(5); state.advance(15_000); }
        expect(state.intervals.size).toBe(0);
        state.release();
        for (let count = 0; count < 50 && !state.settlements.length; count++) await Bun.sleep(5);
        expect(state.calls).toHaveLength(1);
        expect(state.settlements).toEqual([false]);
        expect(state.events).toContain("usage:interrupted");
        expect(state.events).not.toContain("audit");
    });
});
