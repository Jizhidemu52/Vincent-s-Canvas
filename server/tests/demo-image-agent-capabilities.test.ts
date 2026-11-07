import { expect, spyOn, test } from "bun:test";
import { IMAGE_AGENT_VISION_REQUIRED_MESSAGE } from "../../shared/image-agent-capabilities";
import * as markProvider from "../src/demo-mark-provider";
import * as transport from "../src/provider-submission-transport";

type DemoFetch = (request: Request) => Promise<Response>;

test("demo image-agent handler checks actual selected model capabilities and leaves text-only chat unchanged", async () => {
    const environment = { LOCAL_STANDALONE: "true", OA_LOGIN_ENABLED: "false", AUTH_ENABLED: "false", CREDITS_ENABLED: "false", MARK_IMAGE_API_KEY: "local-vision-fixture",
        MARK_IMAGE_BASE_URL: "https://never-submitted.invalid/v1", APIMART_API_KEY: "", GPT_IMAGE_2_API_KEY: "", OPENTOKEN_API_KEY: "", DEMO_RECOVERY_FILE: "", DEMO_STATE_PATH: ":memory:", STANDALONE_WEB_DIR: "", DEMO_PUBLIC_ASSET_ORIGIN: "" };
    const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
    Object.assign(process.env, environment);
    const originalCreate = markProvider.createDemoMarkProvider;
    let selectedModel: { capabilities: unknown } | undefined;
    const create = spyOn(markProvider, "createDemoMarkProvider").mockImplementation(input => {
        const result = originalCreate(input);
        selectedModel = result.models.find(model => model.modelId === "claude-sonnet-5-5");
        return result;
    });
    let demoFetch: DemoFetch | undefined;
    const serve = spyOn(Bun, "serve").mockImplementation(options => {
        const handler = options as unknown as { fetch: DemoFetch; error: (error: Error) => Response };
        demoFetch = async request => { try { return await handler.fetch(request); } catch (error) { return handler.error(error as Error); } };
        return {} as never;
    });
    const log = spyOn(console, "log").mockImplementation(() => {});
    const upstream = spyOn(transport, "fetchProviderSubmission").mockResolvedValue(Response.json({ content: [{ type: "text", text: "已收到要求。" }], stop_reason: "end_turn" }));
    const post = (profile?: "creative-chat" | "canvas-assistant") => {
        if (!demoFetch) throw new Error("Demo handler was not captured");
        return demoFetch(new Request("http://demo.test/api/chat/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
            modelId: "client-claimed-vision-model", toolKey: profile === "canvas-assistant" ? "canvas-chat" : "gpt-chat", profile,
            profileContext: profile ? { stage: "plan", currentUserText: "检查衬衫", imageCatalog: [], previewImageIds: [], newCreation: false, workNote: "" } : undefined,
            input: [{ role: "user", content: "检查衬衫" }], tools: [], claude: { stream: false },
        }) }));
    };
    try {
        // Use a fixture-specific module instance so other demo-handler tests can
        // still capture their own Bun.serve call in this test process.
        const demoModule = "../src/demo-server.ts?image-agent-capabilities";
        await import(demoModule);
        serve.mockRestore();
        if (!selectedModel) throw new Error("Missing configured demo model");
        selectedModel.capabilities = ["chat"];
        for (const profile of ["creative-chat", "canvas-assistant"] as const) {
            const response = await post(profile);
            expect(response.status).toBe(422);
            expect(await response.json()).toEqual({ error: "CHAT_VISION_REQUIRED", message: IMAGE_AGENT_VISION_REQUIRED_MESSAGE });
        }
        expect(upstream.mock.calls).toHaveLength(0);
        expect((await post()).status).toBe(200);
        selectedModel.capabilities = ["chat", "vision", "tools"];
        upstream.mockImplementation(async () => Response.json({ content: [{ type: "text", text: "已收到要求。" }], stop_reason: "end_turn" }));
        for (const profile of ["creative-chat", "canvas-assistant"] as const) expect((await post(profile)).status).toBe(200);
        expect(upstream.mock.calls).toHaveLength(3);
    } finally {
        create.mockRestore(); serve.mockRestore(); log.mockRestore(); upstream.mockRestore();
        for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
});
