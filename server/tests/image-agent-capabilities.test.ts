import { expect, spyOn, test } from "bun:test";
import express, { type ErrorRequestHandler } from "express";
import { IMAGE_AGENT_VISION_REQUIRED_MESSAGE, imageAgentModelSupportsVision, imageAgentVisionError } from "../../shared/image-agent-capabilities";
import * as billing from "../src/chat-billing";
import type { Database } from "../src/db";
import * as transport from "../src/provider-submission-transport";
import { createChatRouter } from "../src/routes/chat";
import * as security from "../src/security";

test("image agents require an explicit vision capability without guessing from names", () => {
    for (const value of [undefined, null, [], ["chat"], "vision", { vision: true }, ["Vision"], ["claude-sonnet-5-5"]]) {
        expect(imageAgentModelSupportsVision(value)).toBe(false);
        for (const profile of ["creative-chat", "canvas-assistant"]) expect(imageAgentVisionError(profile, value)).toBe(IMAGE_AGENT_VISION_REQUIRED_MESSAGE);
    }
    expect(imageAgentVisionError("creative-chat", ["chat", "vision", "tools"])).toBeNull();
    expect(imageAgentVisionError(undefined, ["chat"])).toBeNull();
});

async function fixture(run: (state: {
    post: (profile?: "creative-chat" | "canvas-assistant") => Promise<Response>;
    capabilities: (value: unknown) => void; calls: unknown[]; writes: string[];
    decrypted: () => number; holds: () => number; settlements: boolean[];
}) => Promise<void>) {
    let selectedCapabilities: unknown = ["chat"];
    const encryptionKey = Buffer.alloc(32, 4).toString("base64");
    const encrypted = security.encryptSecret(JSON.stringify({ apiKey: "local-vision-fixture" }), encryptionKey);
    const calls: unknown[] = [], writes: string[] = [], settlements: boolean[] = [];
    const db = { query: async (sql: string, args: unknown[]) => {
        if (sql.includes("FROM module_flags")) return { rows: [{ enabled: true }] };
        if (sql.includes("FROM tool_api_configurations")) return { rows: [{ toolKey: args[0], modelConfigId: "administrator-selected-model", enabled: true, configurationVersion: 1 }] };
        if (sql.includes("FROM credit_policy")) return { rows: [{ creditsEnabled: true }] };
        if (sql.includes("FROM model_configs") && sql.includes("encrypted_credentials")) {
            // A WHERE clause mentioning capabilities is not enough: the model row must load it.
            expect(sql.split("FROM")[0]).toContain("m.capabilities");
            expect(args).toEqual(["administrator-selected-model"]);
            return { rows: [{ model_id: "claude-sonnet-5-5", capabilities: selectedCapabilities, protocol: "apimart", base_url: "https://never-submitted.invalid/v1", encrypted_credentials: encrypted }] };
        }
        // Deliberately advertise vision during binding resolution. The final model row is authoritative.
        if (sql.includes("FROM model_configs")) return { rows: [{ id: "administrator-selected-model", modelId: "claude-sonnet-5-5", capabilities: ["chat", "vision"], enabled: true, providerEnabled: true }] };
        if (/^(INSERT|UPDATE)/.test(sql)) { writes.push(sql); return { rows: [] }; }
        throw new Error(`Unexpected fixture SQL: ${sql}`);
    } } as unknown as Database;
    const begin = spyOn(billing, "beginChatBilling").mockResolvedValue("held-vision-fixture");
    const finish = spyOn(billing, "finishChatBilling").mockImplementation(async (_db, _reservation, success) => { settlements.push(success); });
    const decrypt = spyOn(security, "decryptSecret");
    const upstream = spyOn(transport, "fetchProviderSubmission").mockImplementation(async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return Response.json({ content: [{ type: "text", text: "已收到要求。" }], stop_reason: "end_turn" });
    });
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { Object.assign(request, { auth: { id: "vision-test-user", role: "designer", departmentId: null } }); next(); });
    app.use("/api/chat", createChatRouter(db, { AUTH_ENABLED: "true", CREDITS_ENABLED: "true", PROVIDER_ENCRYPTION_KEY: encryptionKey } as never));
    app.use(((error, _request, response, _next) => { response.status(500).json({ error: error.code, message: error.message }); }) as ErrorRequestHandler);
    const server = app.listen(0, "127.0.0.1");
    try {
        await new Promise<void>(resolve => server.once("listening", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing fixture port");
        const post = (profile?: "creative-chat" | "canvas-assistant") => fetch(`http://127.0.0.1:${address.port}/api/chat/responses`, {
            method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5_000),
            body: JSON.stringify({ requestId: crypto.randomUUID(), modelId: "client-claimed-vision-model", toolKey: profile === "canvas-assistant" ? "canvas-chat" : "gpt-chat",
                profile, profileContext: profile ? { stage: "plan", currentUserText: "检查衬衫", imageCatalog: [], previewImageIds: [], newCreation: false, workNote: "" } : undefined,
                input: [{ role: "user", content: "检查衬衫" }], tools: [], claude: { stream: false } }),
        });
        await run({ post, capabilities: value => { selectedCapabilities = value; }, calls, writes, decrypted: () => decrypt.mock.calls.length, holds: () => begin.mock.calls.length, settlements });
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        upstream.mockRestore(); decrypt.mockRestore(); begin.mockRestore(); finish.mockRestore();
    }
}

test("formal image-agent routes reject missing vision before decrypting, billing, usage or upstream submission", async () => {
    await fixture(async state => {
        for (const capabilities of [["chat"], undefined, null, "vision"]) {
            state.capabilities(capabilities);
            for (const profile of ["creative-chat", "canvas-assistant"] as const) {
                const response = await state.post(profile);
                expect(response.status).toBe(422);
                expect(await response.json()).toEqual({ error: "CHAT_VISION_REQUIRED", message: IMAGE_AGENT_VISION_REQUIRED_MESSAGE });
            }
        }
        expect(state.decrypted()).toBe(0); expect(state.holds()).toBe(0);
        expect(state.calls).toEqual([]); expect(state.writes).toEqual([]); expect(state.settlements).toEqual([]);
    });
});

test("formal vision-capable profiles and ordinary text chat retain their existing execution and billing", async () => {
    await fixture(async state => {
        state.capabilities(["chat", "vision"]);
        for (const profile of ["creative-chat", "canvas-assistant"] as const) {
            const response = await state.post(profile);
            expect(response.status).toBe(200);
            expect((await response.json()).content).toBe("已收到要求。");
        }
        state.capabilities(["chat"]);
        expect((await state.post()).status).toBe(200);
        expect(state.calls).toHaveLength(3); expect(state.decrypted()).toBe(3); expect(state.holds()).toBe(3);
        expect(state.settlements).toEqual([true, true, true]);
        expect(state.writes.filter(sql => sql.startsWith("INSERT INTO usage_chat_requests"))).toHaveLength(3);
    });
});
