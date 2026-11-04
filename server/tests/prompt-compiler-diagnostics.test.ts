import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readChatUpstreamFailure } from "../src/chat-upstream-failure";
import { sqlitePromptRecipeStore } from "../src/demo-prompt-recipes";
import { PromptCompiler, type PromptCompilerRuntime } from "../src/prompt-compiler";
import { publicPromptCompilation } from "../src/prompt-recipe-store";
import { ChatProtocolError } from "../src/routes/chat";
import type { AdminPromptCompilation, PromptCompilationRequest } from "../../shared/prompt-contracts";

const closers: Array<() => void> = [];
afterEach(() => { closers.splice(0).forEach(close => close()); });

const privateMessage = "PRIVATE_PROVIDER_BODY_CANARY authorization=PRIVATE_SECRET_CANARY";
const actor = { id: "diagnostics-employee", role: "designer", departmentId: null };
const request = (): PromptCompilationRequest => ({
  requestId: randomUUID(), modelConfigId: "target", toolKey: "image", sourceUrls: [],
  promptInput: { scene: "text-to-style", fields: {}, userText: "A blue shirt", mode: "generate", hasMask: false, referenceRoles: [] },
});

async function fixture(error: unknown) {
  const db = sqlitePromptRecipeStore(":memory:");
  closers.push(db.close);
  await db.store.ensure("text-to-style", { name: "Diagnostics fixture", enabled: true, modelConfigId: "optimizer", failurePolicy: "stop" });
  const version = await db.store.saveVersion("text-to-style", {
    systemPrompt: "Return only the final visual description as strict JSON.", fieldTemplate: "", modelOverrides: {},
    fallbackPrompt: "", outputLanguage: "en", changeNote: "in-memory diagnostics fixture",
  }, "admin");
  await db.store.activate("text-to-style", version.id);
  let calls = 0;
  const runtime: PromptCompilerRuntime = {
    resolveTarget: async () => ({ id: "target", modelId: "gpt-image-2", protocol: "openai", fingerprint: "target" }),
    resolveOptimizer: async () => ({
      id: "optimizer", modelId: "optimizer", fingerprint: "optimizer", estimatedRmbCost: null,
      invoke: async () => { calls++; throw error; },
    }),
    readSource: async () => { throw new Error("The diagnostics fixture has no reference images"); },
  };
  return { ...db, compiler: new PromptCompiler(db.store, runtime), calls: () => calls };
}

function protocolError(status: unknown, reason: unknown) {
  // Runtime inputs are intentionally malformed to exercise the persistence boundary.
  return Object.assign(new ChatProtocolError("UPSTREAM_REQUEST_FAILED", privateMessage), {
    upstreamStatus: status, upstreamReason: reason, providerBody: privateMessage,
  });
}

async function persistedDetails(f: Awaited<ReturnType<typeof fixture>>, result: AdminPromptCompilation) {
  const row = (await f.store.database.query<{ details: string }>("SELECT details FROM prompt_compilations WHERE id=$1", [result.id])).rows[0]!;
  expect(row.details).not.toContain(privateMessage);
  expect(row.details).not.toContain("PRIVATE_SECRET_CANARY");
  expect(row.details).not.toContain("providerBody");
  return JSON.parse(row.details) as Record<string, unknown>;
}

function expectPublicDiagnosticsAbsent(result: AdminPromptCompilation) {
  const value = publicPromptCompilation(result);
  expect(value).not.toHaveProperty("upstreamStatus");
  expect(value).not.toHaveProperty("upstreamReason");
  expect(JSON.stringify(value)).not.toContain("PRIVATE_PROVIDER_BODY_CANARY");
  expect(JSON.stringify(value)).not.toContain("PRIVATE_SECRET_CANARY");
}

describe("prompt compiler administrator-only upstream diagnostics", () => {
  for (const [status, reason, expectedState] of [
    [400, "request_invalid", "failed"],
    [503, "service_unavailable", "uncertain"],
  ] as const) {
    test(`trusted ${status} ${reason} persists only safe diagnostics and never retries the same request`, async () => {
      const f = await fixture(protocolError(status, reason));
      const input = request();
      const result = await f.compiler.compile(actor, input);
      expect(result).toMatchObject({ status: expectedState, upstreamStatus: status, upstreamReason: reason });
      expect(await persistedDetails(f, result)).toMatchObject({ upstreamStatus: status, upstreamReason: reason });
      expectPublicDiagnosticsAbsent(result);

      const stored = (await f.store.byRequest(actor.id, input.requestId))!;
      expect(stored).toMatchObject({ id: result.id, status: expectedState, upstreamStatus: status, upstreamReason: reason });
      const repeated = await f.compiler.compile(actor, input);
      expect(repeated).toMatchObject({ id: result.id, status: expectedState, upstreamStatus: status, upstreamReason: reason });
      expectPublicDiagnosticsAbsent(repeated);
      expect(f.calls()).toBe(1);
    });
  }

  for (const [name, error] of [
    ["plain object", { name: "ChatProtocolError", message: privateMessage, upstreamStatus: 400, upstreamReason: "request_invalid", providerBody: privateMessage }],
    ["ordinary Error with a forged name", Object.assign(new Error(privateMessage), { name: "ChatProtocolError", upstreamStatus: 400, upstreamReason: "request_invalid", providerBody: privateMessage })],
  ] as const) {
    test(`${name} cannot impersonate trusted diagnostics`, async () => {
      const f = await fixture(error);
      const result = await f.compiler.compile(actor, request());
      expect(result).not.toHaveProperty("upstreamStatus");
      expect(result).not.toHaveProperty("upstreamReason");
      const details = await persistedDetails(f, result);
      expect(details).not.toHaveProperty("upstreamStatus");
      expect(details).not.toHaveProperty("upstreamReason");
      expectPublicDiagnosticsAbsent(result);
      expect(f.calls()).toBe(1);
    });
  }

  test("trusted error reasons outside the exact whitelist are not persisted", async () => {
    for (const reason of ["request_invalid " + privateMessage, "REQUEST_INVALID", "toString", "__proto__", 1, null, { reason: "request_invalid", body: privateMessage }]) {
      const f = await fixture(protocolError(400, reason));
      const result = await f.compiler.compile(actor, request());
      expect(result).toHaveProperty("upstreamStatus", 400);
      expect(result).not.toHaveProperty("upstreamReason");
      const details = await persistedDetails(f, result);
      expect(details).toHaveProperty("upstreamStatus", 400);
      expect(details).not.toHaveProperty("upstreamReason");
      expectPublicDiagnosticsAbsent(result);
      expect(f.calls()).toBe(1);
    }
  });

  test("trusted error status must be a numeric integer within HTTP 100-599", async () => {
    for (const status of ["400", 99, 600, 400.5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      const f = await fixture(protocolError(status, "request_invalid"));
      const result = await f.compiler.compile(actor, request());
      expect(result).not.toHaveProperty("upstreamStatus");
      expect(result).toHaveProperty("upstreamReason", "request_invalid");
      const details = await persistedDetails(f, result);
      expect(details).not.toHaveProperty("upstreamStatus");
      expect(details).toHaveProperty("upstreamReason", "request_invalid");
      expectPublicDiagnosticsAbsent(result);
      expect(f.calls()).toBe(1);
    }
  });

  test("generic Operation not allowed is request_invalid, not evidence of access_denied", async () => {
    const reason = await readChatUpstreamFailure(new Response(JSON.stringify({
      error: { type: "invalid_request_error", message: "Operation not allowed" },
      request: { authorization: "PRIVATE_SECRET_CANARY" },
    }), { status: 400, headers: { "content-type": "application/json" } }));
    expect(reason).toBe("request_invalid");
    expect(reason).not.toBe("access_denied");

    const f = await fixture(new ChatProtocolError("UPSTREAM_REQUEST_FAILED", privateMessage, 400, reason));
    const result = await f.compiler.compile(actor, request());
    expect(result).toMatchObject({ status: "failed", upstreamStatus: 400, upstreamReason: "request_invalid" });
    expect(await persistedDetails(f, result)).toMatchObject({ upstreamStatus: 400, upstreamReason: "request_invalid" });
    expectPublicDiagnosticsAbsent(result);
    expect(f.calls()).toBe(1);
  });
});
