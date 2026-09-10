import { afterEach, describe, expect, test } from "bun:test";
import express, { type ErrorRequestHandler } from "express";
import type { Server } from "node:http";
import type { AppConfig } from "../src/config";
import type { Database } from "../src/db";
import { createModelConfigurationRouter } from "../src/routes/model-configuration";
import { decryptSecret } from "../src/security";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

type StoredProvider = {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  enabled: boolean;
  encryptedCredentials: string | null;
};

async function serve(role = "super_admin") {
  const providers = new Map<string, StoredProvider>();
  const publicProvider = ({ encryptedCredentials, ...provider }: StoredProvider) => ({
    ...provider,
    hasCredentials: Boolean(encryptedCredentials),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  // Only the database transport is replaced; validation, encryption, authorization,
  // routing and the values passed to INSERT/UPDATE run through production code.
  const db = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith("INSERT INTO providers")) {
        const [name, protocol, baseUrl, enabled, encryptedCredentials] = values as [string, string, string, boolean, string | null];
        const id = crypto.randomUUID();
        const provider = { id, name, protocol, baseUrl, enabled, encryptedCredentials };
        providers.set(id, provider);
        return { rows: [publicProvider(provider)] };
      }
      if (sql.startsWith("UPDATE providers")) {
        const [name, protocol, baseUrl, enabled, encryptedCredentials, id] = values as [string, string, string, boolean, string | null, string];
        const current = providers.get(id)!;
        const provider = { id, name, protocol, baseUrl, enabled, encryptedCredentials: encryptedCredentials ?? current.encryptedCredentials };
        providers.set(id, provider);
        return { rows: [publicProvider(provider)] };
      }
      if (sql.startsWith("SELECT") && sql.includes("FROM providers")) {
        const rows = values.length ? [providers.get(String(values[0]))].filter((item): item is StoredProvider => Boolean(item)) : [...providers.values()];
        return { rows: rows.map(publicProvider) };
      }
      if (sql.startsWith("INSERT INTO audit_logs")) return { rows: [] };
      throw new Error(`Unexpected database operation: ${sql}`);
    },
  };
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    Object.assign(request, { auth: { id: "10000000-0000-4000-8000-000000000001", role, departmentId: null } });
    next();
  });
  app.use("/api/admin/model-configuration", createModelConfigurationRouter(db as unknown as Database, { PROVIDER_ENCRYPTION_KEY: encryptionKey } as AppConfig));
  app.use(((error, _request, response, _next) => {
    response.status(error.name === "ZodError" ? 400 : 500).json({ message: error.message });
  }) as ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return { url: `http://127.0.0.1:${address.port}/api/admin/model-configuration/providers`, providers };
}

function save(url: string, input: Record<string, unknown>, method = "POST") {
  return fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
}

describe("formal provider configuration", () => {
  test.each(["anthropic", "openai-chat"])("saves and edits a %s provider without exposing or replacing its key", async (protocol) => {
    const { url, providers } = await serve();
    const original = await save(url, { name: "OpenToken images", protocol: "openai", baseUrl: "https://gateway.example.test/v1", credentials: { apiKey: "test-provider-key" } });
    expect(original.status).toBe(201);
    const originalId = (await original.json()).provider.id;
    const originalProvider = { ...providers.get(originalId)! };
    const baseUrl = protocol === "anthropic" ? "https://gateway.example.test" : "https://gateway.example.test/v1";
    const response = await save(url, { name: "OpenToken chat", protocol, baseUrl, credentials: { apiKey: "test-provider-key" } });
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created.provider).toMatchObject({ name: "OpenToken chat", protocol, baseUrl, enabled: true, hasCredentials: true });
    expect(JSON.stringify(created)).not.toContain("test-provider-key");
    const encrypted = providers.get(created.provider.id)!.encryptedCredentials!;
    expect(encrypted).not.toContain("test-provider-key");
    expect(JSON.parse(decryptSecret(encrypted, encryptionKey))).toEqual({ apiKey: "test-provider-key" });

    const updated = await save(`${url}/${created.provider.id}`, { protocol, name: "OpenToken Agent" }, "PATCH");
    expect(updated.status).toBe(200);
    expect((await updated.json()).provider).toMatchObject({ name: "OpenToken Agent", protocol, baseUrl, hasCredentials: true });
    expect(providers.get(created.provider.id)!.encryptedCredentials).toBe(encrypted);
    expect(providers.get(originalId)).toEqual(originalProvider);
    const listed = await (await fetch(url)).json();
    expect(listed.providers).toHaveLength(2);
    expect(listed.providers.find((provider: { id: string }) => provider.id === created.provider.id)).toMatchObject({ protocol, name: "OpenToken Agent" });
    expect(JSON.stringify(listed)).not.toContain(encrypted);
  });

  test("keeps every existing provider protocol available", async () => {
    const { url } = await serve();
    for (const protocol of ["openai", "gemini", "apimart", "volcengine", "runninghub", "comfyui", "custom"]) {
      const response = await save(url, { name: protocol, protocol, baseUrl: "https://gateway.example.test/v1" });
      expect(response.status).toBe(201);
      expect((await response.json()).provider.protocol).toBe(protocol);
    }
  });

  test("rejects unsupported protocols before saving a provider", async () => {
    const { url, providers } = await serve();
    const response = await save(url, { name: "Unknown", protocol: "unsupported", baseUrl: "https://gateway.example.test" });
    expect(response.status).toBe(400);
    expect(providers.size).toBe(0);
  });

  test("does not let a designer configure either new protocol", async () => {
    const { url, providers } = await serve("designer");
    for (const protocol of ["anthropic", "openai-chat"]) {
      expect((await save(url, { name: "OpenToken", protocol, baseUrl: "https://gateway.example.test" })).status).toBe(403);
    }
    expect(providers.size).toBe(0);
  });
});
