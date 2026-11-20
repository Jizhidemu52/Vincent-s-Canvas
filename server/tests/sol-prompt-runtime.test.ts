import { expect, test } from "bun:test";
import type { PromptCompilationRequest } from "../../shared/prompt-contracts";
import { MARK_IMAGE_PROVIDER_ID } from "../../shared/mark-image-models";
import type { AppConfig } from "../src/config";
import { sqlitePromptRecipeStore } from "../src/demo-prompt-recipes";
import { createDemoPromptCompiler } from "../src/demo-prompt-runtime";
import type { PromptRecipeStore } from "../src/prompt-recipe-store";
import { createPostgresPromptCompiler } from "../src/prompt-runtime";
import { encryptSecret } from "../src/security";
import { createIsolatedPostgres } from "./helpers/isolated-postgres";

const actor = { id: "sol-prompt-owner", role: "designer" };
const optimizerId = "b560d80d-fba1-468b-9b1d-8a54792d2b14";
const targetId = "03913da3-cfb7-4ba2-9220-d9224a782c37";
const finalPrompt = "A blue linen shirt on a plain background.";
const validContent = JSON.stringify({ prompt: finalPrompt, avoid: [], keep_text: [] });
const input = (): PromptCompilationRequest => ({
  requestId: crypto.randomUUID(), modelConfigId: targetId, toolKey: "image", sourceUrls: [],
  promptInput: { scene: "text-to-style", mode: "generate", userText: "A blue linen shirt", fields: {}, hasMask: false, referenceRoles: [] },
});

async function installRecipe(store: PromptRecipeStore, actorId = "fixture-admin") {
  await store.ensure("text-to-style", { name: "Text fixture", enabled: true, modelConfigId: optimizerId, failurePolicy: "fallback" });
  const version = await store.saveVersion("text-to-style", {
    systemPrompt: "Return only one JSON object containing prompt, avoid and keep_text.", fieldTemplate: "", modelOverrides: {},
    fallbackPrompt: "A fallback shirt.", outputLanguage: "en", changeNote: "isolated runtime test", executionStrategy: "llm",
  }, actorId);
  await store.activate("text-to-style", version.id);
}

async function fixture(reply: unknown, modelId = "gpt-6.2-sol") {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls.push({ path: new URL(request.url).pathname, body: await request.json() as Record<string, unknown> });
    return Response.json(reply);
  } });
  const db = sqlitePromptRecipeStore(":memory:");
  await installRecipe(db.store);
  const compiler = createDemoPromptCompiler(db.store, {
    models: [
      { id: optimizerId, modelId, enabled: true, capabilities: ["chat", "vision", "tools"], providerId: "local-provider" },
      { id: targetId, modelId: "gpt-image-2.6-flare", enabled: true, capabilities: ["generate"], providerId: "local-provider" },
    ],
    providers: [{ id: "local-provider", enabled: true, protocol: "apimart", baseUrl: `http://127.0.0.1:${provider.port}/v1` }],
    tools: [{ toolKey: "image", modelConfigId: targetId, enabled: true }], flags: { image: true },
    credential: () => "local-runtime-test-only", asset: () => undefined,
  });
  return { compiler, calls, close: () => { provider.stop(true); db.close(); } };
}

test("Sol runtime rejects complete-looking JSON when the provider reports length, without fallback or replay", async () => {
  const f = await fixture({ choices: [{ message: { content: validContent }, finish_reason: "length" }] });
  try {
    const request = input();
    const compiled = await f.compiler.compile(actor, request);
    expect(compiled).toMatchObject({ status: "failed", errorCode: "PROMPT_OUTPUT_REJECTED", optimized: false });
    expect(compiled.upstreamOutcome).toBeUndefined();
    expect(compiled.prompt).toBeUndefined();
    expect(await f.compiler.compile(actor, request)).toMatchObject({ id: compiled.id, status: "failed", errorCode: "PROMPT_OUTPUT_REJECTED" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ path: "/v1/responses", body: { model: "gpt-6.2-sol", tools: [], stream: false } });
  } finally { f.close(); }
});

test.each(["max_tokens", "incomplete", "error", "content_filter", "tool_calls", "unrecognized"])("Sol runtime rejects %s even when its text is valid JSON", async stopReason => {
  const f = await fixture({ choices: [{ message: { content: validContent }, finish_reason: stopReason }] });
  try {
    const compiled = await f.compiler.compile(actor, input());
    expect(compiled).toMatchObject({ status: "failed", errorCode: "PROMPT_OUTPUT_REJECTED", optimized: false });
    expect(compiled.upstreamOutcome).toBeUndefined();
    expect(f.calls).toHaveLength(1);
  } finally { f.close(); }
});

test.each(["native", "choices"])("Sol runtime rejects unsolicited %s tools without executing or falling back", async format => {
  const call = { call_id: "unexpected-call", name: "unexpected_tool", arguments: "{}" };
  const reply = format === "native" ? { status: "completed", output: [
    { type: "message", content: [{ type: "output_text", text: validContent }] }, { type: "function_call", ...call },
  ] } : { choices: [{ message: { content: validContent, tool_calls: [{ id: call.call_id, type: "function", function: { name: call.name, arguments: call.arguments } }] }, finish_reason: "stop" }] };
  const f = await fixture(reply);
  try {
    const compiled = await f.compiler.compile(actor, input());
    expect(compiled).toMatchObject({ status: "failed", errorCode: "PROMPT_OUTPUT_REJECTED" });
    expect(compiled.upstreamOutcome).toBeUndefined();
    expect(f.calls).toHaveLength(1);
  } finally { f.close(); }
});

test.each(["native", "choices", "unspecified"])("Sol runtime compiles complete %s JSON and preserves usage without adding unverified parameters", async format => {
  const reply = format === "native" ? { status: "completed", output_text: validContent, usage: { input_tokens: 29, output_tokens: 17 } }
    : { choices: [{ message: { content: validContent }, ...(format === "choices" ? { finish_reason: "stop" } : {}) }], usage: { prompt_tokens: 29, completion_tokens: 17 } };
  const f = await fixture(reply);
  try {
    const request = input();
    const compiled = await f.compiler.compile(actor, request);
    expect(compiled).toMatchObject({ status: "success", optimized: true, prompt: finalPrompt, inputTokens: 29, outputTokens: 17 });
    expect(await f.compiler.compile(actor, request)).toMatchObject({ id: compiled.id, status: "success" });
    expect(f.calls).toHaveLength(1);
    expect(Object.keys(f.calls[0]!.body).sort()).toEqual(["input", "model", "parallel_tool_calls", "stream", "tool_choice", "tools"]);
  } finally { f.close(); }
});

test("Sol-only response validation leaves an explicitly selected Carbon optimizer behavior unchanged", async () => {
  const f = await fixture({ choices: [{ message: { content: validContent }, finish_reason: "length" }] }, "gemini-4-carbon");
  try {
    expect(await f.compiler.compile(actor, input())).toMatchObject({ status: "success", prompt: finalPrompt });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ path: "/v1/chat/completions", body: { model: "gemini-4-carbon", max_tokens: 4096 } });
  } finally { f.close(); }
});

const postgresTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
postgresTest("formal PostgreSQL runtime rejects incomplete Sol output and tools as known failures, then compiles a complete response once", async () => {
  const postgres = await createIsolatedPostgres();
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let mode: "length" | "tool" | "complete" = "length";
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls.push({ path: new URL(request.url).pathname, body: await request.json() as Record<string, unknown> });
    return Response.json({ choices: [{ message: { content: validContent,
      ...(mode === "tool" ? { tool_calls: [{ id: "unexpected-call", type: "function", function: { name: "unexpected_tool", arguments: "{}" } }] } : {}) },
      finish_reason: mode === "length" ? "length" : "stop" }], usage: { prompt_tokens: 29, completion_tokens: 17 } });
  } });
  try {
    const key = Buffer.alloc(32, 37).toString("base64");
    const { db } = postgres;
    await db.query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'Sol prompt fixture','apimart',$2,$3)", [MARK_IMAGE_PROVIDER_ID, `http://127.0.0.1:${provider.port}/v1`, encryptSecret(JSON.stringify({ apiKey: "local-runtime-test-only" }), key)]);
    await db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities) VALUES($1,$2,'Sol prompt fixture','gpt-6.2-sol',ARRAY['chat','vision','tools']),($3,$2,'Image fixture','gpt-image-2.6-flare',ARRAY['generate'])", [optimizerId, MARK_IMAGE_PROVIDER_ID, targetId]);
    const user = (await db.query("INSERT INTO users(username,display_name) VALUES('sol-prompt-fixture','Sol fixture') RETURNING id")).rows[0];
    const compiler = createPostgresPromptCompiler(db, { PROVIDER_ENCRYPTION_KEY: key, S3_REGION: "us-east-1" } as AppConfig);
    await installRecipe(compiler.store, user.id);
    for (const resultMode of ["length", "tool", "complete"] as const) {
      mode = resultMode;
      const request = input();
      request.promptInput.userText += ` ${mode}`;
      const owner = { ...actor, id: user.id };
      const compiled = await compiler.compile(owner, request);
      expect(compiled).toMatchObject(mode === "complete"
        ? { status: "success", optimized: true, prompt: finalPrompt, inputTokens: 29, outputTokens: 17 }
        : { status: "failed", optimized: false, errorCode: "PROMPT_OUTPUT_REJECTED" });
      expect(compiled.upstreamOutcome).toBeUndefined();
      expect(await compiler.compile(owner, request)).toMatchObject({ id: compiled.id, status: compiled.status });
    }
    expect(calls).toHaveLength(3);
    expect(calls.every(call => call.path === "/v1/responses" && call.body.model === "gpt-6.2-sol" && Array.isArray(call.body.tools) && call.body.tools.length === 0)).toBe(true);
  } finally { provider.stop(true); await postgres.close(); }
}, 30000);
