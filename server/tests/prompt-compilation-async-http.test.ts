import { expect, test } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { sqlitePromptRecipeStore } from "../src/demo-prompt-recipes";
import { handleDemoPromptRecipes } from "../src/demo-prompt-runtime";
import { PromptCompiler } from "../src/prompt-compiler";
import { createPromptCompilationsRouter } from "../src/routes/prompt-recipes";
import type { AuthenticatedRequest } from "../src/types";

const actor = { id: "async-http-owner", role: "designer" };
const finalOutput = JSON.stringify({ prompt: "Change only the shirt color to blue.", avoid: [], keep_text: [] });

test.each(["production", "demo"] as const)("%s optimization accepts once before the model completes and recovers through the same request", async runtime => {
  const db = sqlitePromptRecipeStore(":memory:");
  const release = Promise.withResolvers<{ content: string }>();
  let calls = 0;
  let close = async () => {};
  let acceptedId: string | undefined;
  const compiler = new PromptCompiler(db.store, {
    resolveTarget: async () => ({ id: "target", modelId: "gpt-image-2", protocol: "openai", fingerprint: "target" }),
    resolveOptimizer: async () => ({ id: "optimizer", modelId: "fixture", fingerprint: "optimizer", estimatedRmbCost: null, invoke: async () => { calls++; return release.promise; } }),
    readSource: async () => { throw new Error("No references in this fixture"); },
  });
  try {
    await db.store.ensure("free-optimize", { name: "free-optimize", enabled: true, modelConfigId: "optimizer", failurePolicy: "stop" });
    const version = await db.store.saveVersion("free-optimize", { systemPrompt: "Return only the image edit as strict JSON.", fieldTemplate: "", modelOverrides: {}, fallbackPrompt: "", outputLanguage: "en", changeNote: "fixture" }, "admin");
    await db.store.activate("free-optimize", version.id);
    let call: (path: string, init?: RequestInit, owner?: string) => Promise<Response>;
    if (runtime === "production") {
      const app = express();
      app.use(express.json());
      app.use((request, _response, next) => { (request as AuthenticatedRequest).auth = { ...actor, id: request.get("x-fixture-owner") || actor.id } as AuthenticatedRequest["auth"]; next(); });
      app.use("/api/prompt-compilations", createPromptCompilationsRouter(compiler));
      const server = app.listen(0, "127.0.0.1");
      await new Promise<void>(resolve => server.once("listening", resolve));
      close = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/prompt-compilations`;
      call = (path, init, owner = actor.id) => fetch(base + path, { ...init, headers: { ...init?.headers, "x-fixture-owner": owner }, signal: AbortSignal.timeout(2000) });
    } else {
      call = async (path, init, owner = actor.id) => (await handleDemoPromptRecipes(new Request("http://localhost/api/prompt-compilations" + path, init), compiler, { ...actor, id: owner }, { models: async () => [], audit: async () => {} }))!;
    }
    const input = { requestId: crypto.randomUUID(), modelConfigId: "target", sourceUrls: [], promptInput: { scene: "free-optimize", userText: "Change the shirt to blue", mode: "generate" } };
    const init = { method: "POST", headers: { "content-type": "application/json", Prefer: "respond-async" }, body: JSON.stringify(input) };
    const accepted = await call("", init);
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    const body = await accepted.json();
    acceptedId = body.compilation.id;
    expect(body.compilation).toMatchObject({ requestId: input.requestId, status: "optimizing" });
    expect(calls).toBe(1);
    const path = `/by-request/${input.requestId}`;
    expect((await (await call(path)).json()).compilation.status).toBe("optimizing");
    expect((await call(path, undefined, "other-owner")).status).toBe(404);
    const changed = await call("", { ...init, body: JSON.stringify({ ...input, promptInput: { ...input.promptInput, userText: "Change to red" } }) });
    expect(changed.status).toBe(409);
    expect(calls).toBe(1);
    release.resolve({ content: finalOutput });
    await compiler.waitForResult(acceptedId!, actor.id);
    const completed = await (await call(path)).json();
    expect(completed.compilation).toMatchObject({ id: acceptedId, requestId: input.requestId, status: "success", prompt: "Change only the shirt color to blue.", optimized: true });
    expect(calls).toBe(1);
  } finally {
    release.resolve({ content: finalOutput });
    if (acceptedId) await compiler.waitForResult(acceptedId, actor.id);
    await close();
    db.close();
  }
});
