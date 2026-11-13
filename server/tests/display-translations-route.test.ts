import { expect, spyOn, test } from "bun:test";
import express from "express";
import type { Cache, Database } from "../src/db";
import * as billing from "../src/chat-billing";
import { encryptSecret } from "../src/security";
import { createDisplayTranslationsRouter } from "../src/routes/display-translations";
import type { ChatCompletionInput, ChatCompletionResult } from "../src/routes/chat";

const original = "原始服装说明";
const payload = { target: "en-US", texts: [original] };
const report = (text = "Original garment description"): ChatCompletionResult => ({ content: "", toolCalls: [{ id: "translation", type: "function", function: { name: "report_display_translations", arguments: JSON.stringify({ translations: [{ id: 0, text }] }) } }], usage: { inputTokens: 20, outputTokens: 8 } });
async function fixture(run: (state: {
    post: (body?: unknown, actor?: string, owner?: string) => Promise<Response>;
    calls: ChatCompletionInput[]; queries: Array<[string, unknown[]]>; settlements: boolean[];
    faults: Set<string>; values: Map<string, string>; holds: () => number;
}) => Promise<void>) {
    const values = new Map<string, string>(), faults = new Set<string>(), calls: ChatCompletionInput[] = [], queries: Array<[string, unknown[]]> = [], settlements: boolean[] = [];
    let phase = "claim";
    const cache: Pick<Cache, "get" | "eval"> = {
        get: async key => values.get(key) ?? null,
        eval: async (script, { keys, arguments: args }) => {
            const key = keys[0]!;
            if (script.includes("claim-v1")) {
                phase = "claim";
                if (values.has(key)) return [0, values.get(key)];
                values.set(key, args[0]!); return [1, args[0]];
            }
            if (script.includes("finish-v1")) {
                phase = "finish";
                const current = JSON.parse(values.get(key) || "null");
                if (!current || current.token !== args[0] || current.status !== "pending") return 0;
                values.set(key, args[1]!);
                if (faults.has("lost-finish-reply")) throw new Error("lost write response");
                return 1;
            }
            const count = Number(values.get(key) || 0) + Number(args[0]); values.set(key, String(count)); return count;
        },
    };
    const encryptionKey = Buffer.alloc(32, 5).toString("base64");
    const db = { query: async (sql: string, args: unknown[] = []) => {
        queries.push([sql, args]);
        if (sql.includes("FROM module_flags")) return { rows: [{ enabled: true }] };
        if (sql.includes("FROM tool_api_configurations")) return { rows: [{ toolKey: "gpt-chat", modelConfigId: "fixture-model", enabled: true, configurationVersion: 1 }] };
        if (sql.includes("FROM credit_policy")) return { rows: [{ creditsEnabled: true }] };
        if (sql.includes("FROM model_configs")) return { rows: [{ id: "fixture-model", modelId: "fixture-model", model_id: "fixture-model", enabled: true, providerEnabled: true, capabilities: ["chat"], protocol: "apimart", base_url: "https://never-called.invalid/v1", encrypted_credentials: encryptSecret(JSON.stringify({ apiKey: "fixture-only-secret" }), encryptionKey) }] };
        if (sql.includes("INSERT INTO audit_logs")) return { rows: [] };
        throw new Error("Unexpected query");
    } } as unknown as Database;
    const begin = spyOn(billing, "beginChatBilling").mockResolvedValue("display-hold");
    const finish = spyOn(billing, "finishChatBilling").mockImplementation(async (_db, _hold, success) => {
        settlements.push(success); if (faults.has("settlement")) throw new Error("settlement unknown");
    });
    const app = express(); app.use(express.json());
    app.use((req, _response, next) => {
        const actor = req.get("X-Test-Actor");
        if (actor !== "none") Object.assign(req, { auth: { id: actor || "owner-a", role: "department_admin", departmentId: "department-a" } });
        next();
    });
    app.use("/display", createDisplayTranslationsRouter(db, { AUTH_ENABLED: "true", CREDITS_ENABLED: "true", PROVIDER_ENCRYPTION_KEY: encryptionKey } as never, {
        cache, openReceiptConnection: async () => ({ cache, confirmPersistence: async () => !faults.has(`aof-${phase}`), close: () => undefined }),
        complete: async (_model, _credentials, input) => {
            calls.push(input);
            if (faults.has("provider")) throw new Error("private provider response fixture-only-secret");
            if (faults.has("delay")) await new Promise(resolve => setTimeout(resolve, 100));
            if (faults.has("invalid")) return { content: "private non-tool output", toolCalls: [] };
            if (faults.has("new-reference")) return report("Original [description][other]\n\n[other]: //unexpected.example");
            if (faults.has("new-code")) return report("Original description\n\n```sh\nnew-command\n```");
            if (faults.has("new-email")) return report("Original description new@example.com");
            return report();
        },
    }));
    const server = app.listen(0, "127.0.0.1");
    try {
        await new Promise<void>(resolve => server.once("listening", resolve));
        const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
        const post = (body: unknown = payload, actor = "owner-a", owner = actor) => fetch(`http://127.0.0.1:${address.port}/display`, {
            method: "POST", headers: { "content-type": "application/json", "X-Test-Actor": actor, "X-Canvas-Owner-Id": owner }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
        });
        await run({ post, calls, queries, settlements, faults, values, holds: () => begin.mock.calls.length });
    } finally {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        begin.mockRestore(); finish.mockRestore();
    }
}

test("authentication, owner binding and strict request validation run before provider or persistence", async () => {
    await fixture(async state => {
        expect((await state.post(payload, "none")).status).toBe(403);
        expect((await state.post(payload, "owner-a", "owner-b")).status).toBe(403);
        expect((await state.post({ ...payload, model: "client-selected" })).status).toBe(400);
        expect((await state.post({ ...payload, texts: ["字".repeat(12001)] })).status).toBe(400);
        expect(state.calls).toEqual([]); expect(state.queries).toEqual([]); expect(state.values.size).toBe(0);
    });
});

test("one authenticated batch is translated once, privately audited and cached by owner", async () => {
    await fixture(async state => {
        const first = await state.post(); expect(first.status).toBe(200);
        expect(await first.json()).toEqual({ translations: ["Original garment description"] });
        expect((await state.post()).status).toBe(200);
        expect(state.calls).toHaveLength(1); expect(state.holds()).toBe(1); expect(state.settlements).toEqual([true]);
        expect(state.calls[0]!.privateProfile).toBe(true);
        expect(JSON.stringify([...state.values.values()])).not.toContain(original);
        const writes = state.queries.filter(([sql]) => /INSERT|UPDATE|DELETE/.test(sql));
        expect(writes).toHaveLength(1); expect(writes[0]![0]).toContain("audit_logs");
        expect(JSON.stringify(writes)).not.toContain(original);
        expect((await state.post(payload, "owner-b")).status).toBe(200);
        expect(state.calls).toHaveLength(2);
    });
});

test("parallel identical requests cannot submit a second provider operation", async () => {
    await fixture(async state => {
        state.faults.add("delay");
        const responses = await Promise.all([state.post(), state.post()]);
        expect(responses.map(response => response.status).sort()).toEqual([200, 202]);
        expect(state.calls).toHaveLength(1); expect(state.settlements).toEqual([true]);
    });
});

test.each(["aof-claim", "provider", "invalid", "new-reference", "new-code", "new-email", "settlement"])("%s failure is terminal, preserves source and never automatically resubmits", async fault => {
    await fixture(async state => {
        state.faults.add(fault);
        const result = await state.post(); expect(result.status).toBe(503);
        expect(await result.text()).not.toContain("fixture-only-secret");
        state.faults.clear(); expect((await state.post()).status).toBe(503);
        expect(state.calls).toHaveLength(fault === "aof-claim" ? 0 : 1);
        expect(state.settlements).toEqual(fault === "aof-claim" ? [] : [fault === "settlement"]);
    });
});

test("a committed finish with a lost reply is recovered read-only, never downgraded or resubmitted", async () => {
    await fixture(async state => {
        state.faults.add("lost-finish-reply");
        const result = await state.post(); expect(result.status).toBe(200);
        expect(await result.json()).toEqual({ translations: ["Original garment description"] });
        expect((await state.post()).status).toBe(200);
        expect(state.calls).toHaveLength(1); expect(state.settlements).toEqual([true]);
    });
});
