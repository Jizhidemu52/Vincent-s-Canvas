import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerState } from "./api";
import { createApiHttpServer } from "./http";
import type { GenerationRequest, GenerationResult, Profile } from "../src/domain/workspace";

function request(patch: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    projectId: "project-http",
    nodeId: "node-http",
    modelId: "gpt-image-2-low",
    prompt: "generate a clean internal fashion reference",
    referenceNodeIds: ["node-http"],
    outputCount: 1,
    operation: "generate",
    ...patch
  };
}

async function startTestServer(stateFilePath?: string) {
  const state = createServerState({ creditBalance: 10 });
  const server = createApiHttpServer(stateFilePath ? { stateFilePath } : { state });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server failed to bind a port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    state
  };
}

describe("HTTP API server", () => {
  let context: Awaited<ReturnType<typeof startTestServer>>;

  beforeEach(async () => {
    context = await startTestServer();
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      context.server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("serves model and profile endpoints without provider secrets", async () => {
    const modelsResponse = await fetch(`${context.baseUrl}/api/models`);
    const profileResponse = await fetch(`${context.baseUrl}/api/profile`);
    const models = (await modelsResponse.json()) as Array<Record<string, unknown>>;
    const profile = (await profileResponse.json()) as Profile;

    expect(modelsResponse.status).toBe(200);
    expect(profileResponse.status).toBe(200);
    expect(models.some((model) => model.id === "nanobanana2")).toBe(true);
    expect(models.every((model) => !("apiKey" in model))).toBe(true);
    expect(profile.creditBalance).toBe(10);
  });

  it("handles generation over HTTP, updates credit balance, and writes history", async () => {
    const response = await fetch(`${context.baseUrl}/api/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "http-generate-1" },
      body: JSON.stringify(request())
    });
    const result = (await response.json()) as GenerationResult;
    const profile = (await (await fetch(`${context.baseUrl}/api/profile`)).json()) as Profile;
    const history = (await (await fetch(`${context.baseUrl}/api/history`)).json()) as unknown[];

    expect(response.status).toBe(200);
    expect(result.status).toBe("succeeded");
    expect(result.creditCost).toBe(2);
    expect(profile.creditBalance).toBe(8);
    expect(history).toHaveLength(1);
  });

  it("rejects duplicate submissions without double charging", async () => {
    const init = {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "same-http-request" },
      body: JSON.stringify(request())
    };
    await fetch(`${context.baseUrl}/api/generations`, init);
    const duplicateResponse = await fetch(`${context.baseUrl}/api/generations`, init);
    const profile = (await (await fetch(`${context.baseUrl}/api/profile`)).json()) as Profile;
    const history = (await (await fetch(`${context.baseUrl}/api/history`)).json()) as unknown[];

    expect(duplicateResponse.status).toBe(409);
    expect(profile.creditBalance).toBe(8);
    expect(history).toHaveLength(1);
  });

  it("returns clear HTTP errors for invalid JSON, unknown routes, and wrong methods", async () => {
    const invalidJson = await fetch(`${context.baseUrl}/api/generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json"
    });
    const unknownRoute = await fetch(`${context.baseUrl}/api/missing`);
    const wrongMethod = await fetch(`${context.baseUrl}/api/models`, { method: "POST" });

    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toMatchObject({ status: "failed", errorMessage: "Invalid JSON body" });
    expect(unknownRoute.status).toBe(404);
    expect(wrongMethod.status).toBe(405);
  });

  it("supports CORS preflight for future hosted frontend calls", async () => {
    const response = await fetch(`${context.baseUrl}/api/generations`, { method: "OPTIONS" });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("persists profile balance, history, and duplicate request ids across server restarts", async () => {
    await new Promise<void>((resolve, reject) => {
      context.server.close((error) => (error ? reject(error) : resolve()));
    });
    const dir = mkdtempSync(join(tmpdir(), "designer-canvas-api-"));
    const stateFilePath = join(dir, "server-state.json");
    try {
      const first = await startTestServer(stateFilePath);
      await fetch(`${first.baseUrl}/api/generations`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "persisted-request" },
        body: JSON.stringify(request())
      });
      await new Promise<void>((resolve, reject) => {
        first.server.close((error) => (error ? reject(error) : resolve()));
      });

      const second = await startTestServer(stateFilePath);
      const profile = (await (await fetch(`${second.baseUrl}/api/profile`)).json()) as Profile;
      const history = (await (await fetch(`${second.baseUrl}/api/history`)).json()) as unknown[];
      const duplicate = await fetch(`${second.baseUrl}/api/generations`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "persisted-request" },
        body: JSON.stringify(request())
      });
      await new Promise<void>((resolve, reject) => {
        second.server.close((error) => (error ? reject(error) : resolve()));
      });

      expect(profile.creditBalance).toBe(118);
      expect(history).toHaveLength(1);
      expect(duplicate.status).toBe(409);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      context = await startTestServer();
    }
  });
});
