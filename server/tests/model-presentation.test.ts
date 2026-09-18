import { afterEach, describe, expect, test } from "bun:test";
import express from "express";
import type { Server } from "node:http";
import type { Database } from "../src/db";
import { assignDemoPublicModelNumbers, isImageModel, presentAdminModel, presentPublicModel } from "../src/model-presentation";
import { createModelConfigurationRouter, createPublicModelRouter } from "../src/routes/model-configuration";
import type { AppConfig } from "../src/config";

const image = {
  id: "40000000-0000-4000-8000-000000000099", publicNumber: 7, name: "Vendor image",
  modelId: "gpt-image-2", protocol: "apimart", capabilities: ["generate", "edit"], creditCost: 4, rmbCost: 0,
  providerName: "Secret Provider", baseUrl: "https://private.invalid", credentials: { apiKey: "secret-key" },
};

describe("image identity presentation", () => {
  test("only image capabilities are anonymized and unknown fields are never copied", () => {
    const shown = presentPublicModel(image, "designer");
    expect(shown).toEqual({ id: image.id, modelId: image.id, name: "出图模型7", publicName: "出图模型7", modelIdentityHidden: true,
      capabilities: ["generate", "edit"], creditCost: 4, rmbCost: 0, imageParameterProfile: "pixel" });
    expect(image.modelId).toBe("gpt-image-2");
    for (const capability of ["chat", "video", "audio"]) {
      const model = { ...image, capabilities: [capability, "generate"] };
      expect(isImageModel(model)).toBe(false);
      expect(presentPublicModel(model, "designer").modelId).toBe(image.modelId);
    }
    for (const role of ["super_admin", "department_admin"]) {
      expect(presentPublicModel(image, role)).toMatchObject({ modelId: image.modelId, name: image.name, publicName: "出图模型7", modelIdentityHidden: false });
    }
    expect(presentAdminModel(image)).toMatchObject({ modelId: image.modelId, providerName: image.providerName, publicName: "出图模型7" });
  });

  test.each([
    ["gpt-image-2", "apimart", "pixel"], ["gemini-image", "apimart", "resolution"],
    ["midjourney", "apimart", "speed"], ["midjourney-blend", "apimart", "blend"],
    ["gemini-3.1-flash-image", "openai", "unverified"], ["other", "openai", "standard"],
  ])("%s exposes only a neutral capability profile", (modelId, protocol, expected) => {
    expect(presentPublicModel({ ...image, modelId, protocol }, "designer").imageParameterProfile).toBe(expected);
  });

  test("demo numbers include disabled catalog entries and survive filtering, rename and reorder", () => {
    const models: Record<string, unknown>[] = [
      { ...image, publicNumber: undefined, modelId: "demo-placeholder" },
      { ...image, id: "first", publicNumber: undefined, enabled: false },
      { ...image, id: "second", publicNumber: undefined, enabled: true },
    ];
    assignDemoPublicModelNumbers(models);
    expect(models.map((model) => model.publicNumber)).toEqual([undefined, 1, 2]);
    models[1]!.name = "New name";
    models[1]!.enabled = true;
    models.reverse();
    assignDemoPublicModelNumbers(models);
    expect(models.find((model) => model.id === "first")!.publicNumber).toBe(1);
    models.push({ ...image, id: "third", publicNumber: undefined });
    assignDemoPublicModelNumbers(models);
    expect(models.at(-1)!.publicNumber).toBe(3);
  });
});

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve()); server.closeAllConnections();
  })));
});

test("formal HTTP router selects stored aliases, keeps admin identity and rejects designer admin access", async () => {
  const sqlCalls: string[] = [];
  const db = { query: async (sql: string) => {
    sqlCalls.push(sql);
    if (sql.includes("FROM model_configs m")) return { rows: [image] };
    return { rows: [] };
  } } as unknown as Database;
  const app = express();
  app.use((request, _response, next) => { Object.assign(request, { auth: { role: request.headers["x-test-role"] || "designer" } }); next(); });
  app.use("/models", createPublicModelRouter(db));
  app.use("/admin", createModelConfigurationRouter(db, {} as AppConfig));
  const server = app.listen(0, "127.0.0.1"); servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  const designer = await fetch(`${url}/models`).then((response) => response.json());
  expect(designer.models[0]).toMatchObject({ name: "出图模型7", modelId: image.id, imageParameterProfile: "pixel" });
  expect(JSON.stringify(designer)).not.toMatch(/gpt|Vendor|Secret|private|secret-key/);
  expect(sqlCalls[0]).toContain('m.public_number AS "publicNumber"');
  for (const role of ["super_admin", "department_admin"]) {
    const admin = await fetch(`${url}/models`, { headers: { "x-test-role": role } }).then((response) => response.json());
    expect(admin.models[0]).toMatchObject({ name: image.name, modelId: image.modelId, publicName: "出图模型7" });
  }
  expect((await fetch(`${url}/admin/models`)).status).toBe(403);
  const configured = await fetch(`${url}/admin/models`, { headers: { "x-test-role": "super_admin" } }).then((response) => response.json());
  expect(configured.models[0]).toMatchObject({ modelId: image.modelId, name: image.name, publicName: "出图模型7" });
});
