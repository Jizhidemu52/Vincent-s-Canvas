import { afterEach, describe, expect, test } from "bun:test";
import express from "express";
import type { Server } from "node:http";
import type { Database } from "../src/db";
import { assignDemoPublicModelNumbers, isImageModel, presentAdminModel, presentPublicModel, selectCreativeModels } from "../src/model-presentation";
import { createModelConfigurationRouter, createPublicModelRouter } from "../src/routes/model-configuration";
import type { AppConfig } from "../src/config";

const image = {
  id: "40000000-0000-4000-8000-000000000099", publicNumber: 7, name: "Vendor image",
  modelId: "gpt-image-2", protocol: "apimart", capabilities: ["generate", "edit"], creditCost: 4, rmbCost: 0,
  providerName: "Secret Provider", baseUrl: "https://private.invalid", credentials: { apiKey: "secret-key" },
};

describe("image identity presentation", () => {
  test.each([
    ["gpt-image-2", "日常生图"], ["gpt-image-2.5-flare", "快速试稿"],
    ["gpt-image-2.5-sunburst", "细节精修"], ["gemini-3.1-flash-image", "备用生图"],
  ])("OpenToken %s uses its short feature label without changing admin or request identity", (modelId, label) => {
    const model = { ...image, modelId, providerName: "OpenToken" };
    expect(presentPublicModel(model, "designer")).toMatchObject({ name: label, publicName: label, modelId: image.id });
    expect(presentPublicModel(model, "designer").publicDescription).toEqual(expect.any(String));
    expect(presentAdminModel(model)).toMatchObject({ name: image.name, modelId, publicName: label });
    expect(presentPublicModel({ ...model, publicNumber: 99, name: "Administrator renamed it" }, "designer").name).toBe(label);
  });
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

test("formal HTTP router curates OpenToken images, keeps admin identity and rejects designer admin access", async () => {
  const sqlCalls: string[] = [];
  const configuredImage = { ...image, providerName: "OpenToken" };
  const db = { query: async (sql: string) => {
    sqlCalls.push(sql);
    if (sql.includes("FROM model_configs m")) return { rows: [configuredImage, { ...image, id: "other-channel" }] };
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
  expect(designer.models).toHaveLength(1);
  expect(designer.models[0]).toMatchObject({ name: "日常生图", modelId: image.id, imageParameterProfile: "pixel" });
  expect(JSON.stringify(designer)).not.toMatch(/gpt|Vendor|Secret|private|secret-key/);
  expect(sqlCalls[0]).toContain('m.public_number AS "publicNumber"');
  for (const role of ["super_admin", "department_admin"]) {
    const admin = await fetch(`${url}/models`, { headers: { "x-test-role": role } }).then((response) => response.json());
    expect(admin.models[0]).toMatchObject({ name: image.name, modelId: image.modelId, publicName: "日常生图" });
  }
  expect((await fetch(`${url}/admin/models`)).status).toBe(403);
  const configured = await fetch(`${url}/admin/models`, { headers: { "x-test-role": "super_admin" } }).then((response) => response.json());
  expect(configured.models).toHaveLength(2);
  expect(configured.models[0]).toMatchObject({ modelId: image.modelId, name: image.name, publicName: "日常生图" });
});

test("image choices deduplicate OpenToken models without removing other media or retained configurations", () => {
  const selected = { ...image, id: "selected", providerName: "Custom name", providerBaseUrl: "https://cn2.gw.opentoken.io/v1" };
  const chat = { ...image, id: "chat", capabilities: ["chat"] };
  const catalog = [image, selected, { ...selected, id: "duplicate" }, { ...selected, id: "unknown", modelId: "constructor" }, chat];
  expect(selectCreativeModels(catalog).map(model => model.id)).toEqual(["selected", "chat"]);
  expect(catalog).toHaveLength(5);
});

test("image choices have a fixed use-case order with Gemini last regardless of catalog order", () => {
  const gemini = { ...image, providerName: "OpenToken", modelId: "gemini-3.1-flash-image" };
  const chat = { ...image, id: "chat", capabilities: ["chat"] };
  const models = [gemini, chat, { ...gemini, modelId: "gpt-image-2.5-sunburst" }, { ...gemini, modelId: "gpt-image-2.5-flare" }, { ...gemini, modelId: "gpt-image-2" }];
  const result = selectCreativeModels(models);
  expect(result.filter(isImageModel).map(model => model.modelId)).toEqual(["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gemini-3.1-flash-image"]);
  expect(result[1]).toBe(chat);
  expect(models[0]).toBe(gemini);
});
