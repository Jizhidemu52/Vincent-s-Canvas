import { expect, test } from "bun:test";
import { prepareImageConversationPlannerProfile, validateImageConversationPlannerOutput } from "../src/image-conversation-planner";
import { requestChatCompletion } from "../src/routes/chat";
import { plannerContext, plannerMessages } from "./fixtures/image-conversation-planner";

type ProviderCall = { method: string; path: string; authorization: string | null; body: Record<string, unknown> };
const credentials = { apiKey: "local-sol-responses-test-only" };
const plainInput = { input: [{ role: "user" as const, content: "Discuss a cardigan neckline without generating an image." }], tools: [] };
const plan = { action: "discuss" as const, assistantText: "A V-neck works well for layering." };
const nativeOutput = [
    { id: "rs-local", type: "reasoning", summary: [], encrypted_content: "opaque-native-history" },
    { id: "fc-local", type: "function_call", call_id: "call-local", name: "plan_image_conversation", arguments: JSON.stringify({ plan }), status: "completed" },
];
const nativeText = { status: "completed", output: [{ id: "msg-local", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Local reply.", annotations: [] }] }] };
const choicesText = { choices: [{ message: { content: "Local reply." }, finish_reason: "stop" }] };

function localProvider(reply: (call: ProviderCall) => Response) {
    const calls: ProviderCall[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        const call = { method: request.method, path: new URL(request.url).pathname, authorization: request.headers.get("authorization"), body: await request.json() as Record<string, unknown> };
        calls.push(call);
        return reply(call);
    } });
    return { calls, server, model: { model_id: "gpt-6.2-sol", protocol: "apimart", base_url: `http://127.0.0.1:${server.port}/v1/`, encrypted_credentials: null } };
}

test("exact APIMart Sol sends the full planner tool through one flat non-streaming Responses request", async () => {
    const provider = localProvider(call => Response.json(call.path === "/v1/responses"
        ? { status: "completed", output: nativeOutput, usage: { input_tokens: 40, output_tokens: 12 } } : choicesText));
    try {
        const context = plannerContext();
        context.currentUserText = plainInput.input[0]!.content;
        const profile = prepareImageConversationPlannerProfile(plannerMessages(context.currentUserText), context);
        const result = await requestChatCompletion(provider.model, credentials, profile.input);
        expect(provider.calls).toHaveLength(1);
        expect(provider.calls[0]!.method).toBe("POST");
        expect(provider.calls[0]!.path).toBe("/v1/responses");
        expect(provider.calls[0]!.authorization).toBe(`Bearer ${credentials.apiKey}`);
        const body = provider.calls[0]!.body;
        expect(body).toEqual({
            model: "gpt-6.2-sol", input: profile.input.input, tools: [{ type: "function", name: "plan_image_conversation",
                description: profile.input.tools[0]!.description, parameters: profile.input.tools[0]!.parameters, strict: false }],
            tool_choice: { type: "function", name: "plan_image_conversation" }, parallel_tool_calls: false,
            stream: false, include: ["reasoning.encrypted_content"],
        });
        expect(result.toolCalls).toEqual([{ id: "call-local", type: "function", function: { name: "plan_image_conversation", arguments: JSON.stringify({ plan }) } }]);
        expect(result.responsesOutputItems).toEqual(nativeOutput);
        expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 12 });
        expect(validateImageConversationPlannerOutput(result, profile)).toEqual(plan);
    } finally { provider.server.stop(true); }
});

test("exact APIMart Sol preserves native reasoning and function-call history before tool results", async () => {
    const provider = localProvider(() => Response.json(nativeText));
    try {
        const result = await requestChatCompletion(provider.model, credentials, { tools: [], input: [
            ...plainInput.input, { type: "responses_assistant", output: nativeOutput },
            { type: "function_call_output", call_id: "call-local", output: "The existing image was inspected." },
        ] });
        expect(result.content).toBe("Local reply.");
        expect(provider.calls).toHaveLength(1);
        expect(provider.calls[0]!.path).toBe("/v1/responses");
        expect(provider.calls[0]!.body.input).toEqual([
            ...plainInput.input, ...nativeOutput,
            { type: "function_call_output", call_id: "call-local", output: "The existing image was inspected." },
        ]);
        expect(provider.calls[0]!.body.stream).toBe(false);
    } finally { provider.server.stop(true); }
});

test.each([400, 503])("APIMart Sol surfaces HTTP %s once without endpoint fallback or resubmission", async status => {
    const provider = localProvider(() => Response.json({ error: { message: "Local provider rejected the request." } }, { status }));
    try {
        await expect(requestChatCompletion(provider.model, credentials, plainInput)).rejects.toMatchObject({ code: "UPSTREAM_REQUEST_FAILED" });
        expect(provider.calls.map(call => ({ path: call.path, method: call.method }))).toEqual([{ path: "/v1/responses", method: "POST" }]);
    } finally { provider.server.stop(true); }
});

test.each([
    { protocol: "apimart", model_id: "gpt-6-astra", endpoint: "/v1/responses" },
    { protocol: "apimart", model_id: "gpt-6.2-sol", endpoint: "/v1/responses" },
    { protocol: "apimart", model_id: "gpt-6-sol", endpoint: "/v1/chat/completions" },
    { protocol: "apimart", model_id: "gpt-6.2-sol-preview", endpoint: "/v1/chat/completions" },
    { protocol: "apimart", model_id: "GPT-6.2-SOL", endpoint: "/v1/chat/completions" },
    { protocol: "openai-chat", model_id: "gpt-6.2-sol", endpoint: "/v1/chat/completions" },
    { protocol: "openai", model_id: "gpt-6.2-sol", endpoint: "/v1/responses" },
    { protocol: "custom", model_id: "gpt-6.2-sol", endpoint: "/v1/responses" },
])("Responses selection preserves exact provider/model boundaries: %j", async ({ protocol, model_id, endpoint }) => {
    const provider = localProvider(call => Response.json(call.path === "/v1/responses" ? nativeText : choicesText));
    try {
        expect((await requestChatCompletion({ ...provider.model, protocol, model_id }, credentials, plainInput)).content).toBe("Local reply.");
        expect(provider.calls).toHaveLength(1);
        expect(provider.calls[0]!.path).toBe(endpoint);
        expect(provider.calls[0]!.body.model).toBe(model_id);
        expect(provider.calls[0]!.body).not.toHaveProperty("reasoning");
        expect(provider.calls[0]!.body).not.toHaveProperty("reasoning_effort");
    } finally { provider.server.stop(true); }
});

test("other APIMart Sol identities still reject native Responses history before submission", async () => {
    const provider = localProvider(() => Response.json(choicesText));
    try {
        await expect(requestChatCompletion({ ...provider.model, model_id: "gpt-6-sol" }, credentials, {
            tools: [], input: [{ type: "responses_assistant", output: nativeOutput }],
        })).rejects.toMatchObject({ code: "CHAT_HISTORY_PROTOCOL_MISMATCH" });
        expect(provider.calls).toEqual([]);
    } finally { provider.server.stop(true); }
});
