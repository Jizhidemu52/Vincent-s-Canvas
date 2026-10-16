import { afterEach, describe, expect, test } from "bun:test";
import express from "express";
import type { Server } from "node:http";
import type { Database } from "../src/db";
import { assignDemoPublicModelNumbers, isImageModel, presentAdminModel, presentPublicModel, selectCreativeModels } from "../src/model-presentation";
import { createModelConfigurationRouter, createPublicModelRouter } from "../src/routes/model-configuration";
import type { AppConfig } from "../src/config";
import { MARK_IMAGE_PROVIDER_ID, MARK_PLATFORM_MODELS } from "../../shared/mark-image-models";

const image = {
  id: "40000000-0000-4000-8000-000000000099", publicNumber: 7, name: "Vendor image",
  modelId: "gpt-image-2", protocol: "apimart", capabilities: ["generate", "edit"], creditCost: 4, rmbCost: 0,
  providerName: "Secret Provider", baseUrl: "https://private.invalid", credentials: { apiKey: "secret-key" },
};

describe("image identity presentation", () => {
  test.each([
    ["gpt-image-2", "gpt-image-2"], ["gpt-image-2.5-flare", "gpt-image-2.5-flare"],
    ["gpt-image-2.5-sunburst", "gpt-image-2.5-sunburst"], ["gemini-3.1-flash-image", "gemini-3.1-flash-image"],
  ])("OpenToken %s displays its model ID without changing configuration or request identity", (modelId, label) => {
    const model = { ...image, modelId, providerName: "OpenToken" };
    expect(presentPublicModel(model, "designer")).toMatchObject({ name: label, publicName: label, modelId: image.id });
    expect(presentPublicModel(model, "designer").publicDescription).toEqual(expect.any(String));
    expect(presentAdminModel(model)).toMatchObject({ name: image.name, modelId, publicName: label });
    expect(presentPublicModel({ ...model, publicNumber: 99, name: "Administrator renamed it" }, "designer").name).toBe(label);
    for (const role of ["super_admin", "department_admin"]) {
      expect(presentPublicModel(model, role)).toMatchObject({ name: label, modelId, publicName: label });
    }
  });
  test("only image capabilities are anonymized and unknown fields are never copied", () => {
    const shown = presentPublicModel(image, "designer");
    expect(shown).toEqual({ id: image.id, modelId: image.id, name: "出图模型7", publicName: "出图模型7", modelIdentityHidden: true,
      capabilities: ["generate", "edit"], creditCost: 4, rmbCost: 0, imageParameterProfile: "pixel", isFeatured: false, displayOrder: 1100 + MARK_PLATFORM_MODELS.length });
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
    if (sql.includes("FROM model_configs m")) return { rows: [configuredImage, { ...image, id: "other-channel" },
      { ...image, id: "retired-chat", capabilities: ["chat"], modelId: "claude-opus-5" }] };
    if (sql.includes("FROM tool_api_configurations")) return { rows: [{ toolKey: "canvas-chat", enabled: true, modelConfigId: "retired-chat" }] };
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
  expect(designer.models[0]).toMatchObject({ name: image.modelId, modelId: image.id, imageParameterProfile: "pixel" });
  expect(JSON.stringify(designer)).not.toMatch(/Vendor|Secret|private|secret-key/);
  expect(sqlCalls[0]).toContain('m.public_number AS "publicNumber"');
  for (const role of ["super_admin", "department_admin"]) {
    const admin = await fetch(`${url}/models`, { headers: { "x-test-role": role } }).then((response) => response.json());
    expect(admin.models[0]).toMatchObject({ name: image.modelId, modelId: image.modelId, publicName: image.modelId });
  }
  expect((await fetch(`${url}/admin/models`)).status).toBe(403);
  const configured = await fetch(`${url}/admin/models`, { headers: { "x-test-role": "super_admin" } }).then((response) => response.json());
  expect(configured.models).toHaveLength(3);
  expect(configured.models[0]).toMatchObject({ modelId: image.modelId, name: image.name, publicName: image.modelId });
});

test("image choices deduplicate OpenToken models without removing other media or retained configurations", () => {
  const selected = { ...image, id: "selected", providerName: "Custom name", providerBaseUrl: "https://cn2.gw.opentoken.io/v1" };
  const chat = { ...image, id: "chat", modelId: "gpt-6-astra", providerName: "OpenToken", protocol: "openai", capabilities: ["chat"] };
  const catalog = [image, selected, { ...selected, id: "duplicate" }, { ...selected, id: "unknown", modelId: "constructor" }, chat];
  expect(selectCreativeModels(catalog).map(model => model.id)).toEqual(["selected", "chat"]);
  expect(catalog).toHaveLength(5);
});

test("image choices have a fixed use-case order with Gemini last regardless of catalog order", () => {
  const gemini = { ...image, providerName: "OpenToken", modelId: "gemini-3.1-flash-image" };
  const chat = { ...image, id: "chat", modelId: "gpt-6-astra", providerName: "OpenToken", protocol: "openai", capabilities: ["chat"] };
  const models = [gemini, chat, { ...gemini, modelId: "gpt-image-2.5-sunburst" }, { ...gemini, modelId: "gpt-image-2.5-flare" }, { ...gemini, modelId: "gpt-image-2" }];
  const result = selectCreativeModels(models);
  expect(result.filter(isImageModel).map(model => model.modelId)).toEqual(["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gemini-3.1-flash-image"]);
  expect(result[1]).toBe(chat);
  expect(models[0]).toBe(gemini);
});

test("text choices retain only two APIMart models and OpenToken Astra without deleting configurations", () => {
  const markChat = { ...image, providerId: MARK_IMAGE_PROVIDER_ID, capabilities: ["chat", "vision", "tools"] };
  const openTokenChat = { ...markChat, providerId: "opentoken", providerName: "OpenToken", protocol: "openai" };
  const models = [
    { ...markChat, id: "mark-astra", modelId: "gpt-6-astra" },
    { ...markChat, id: "mark-sonnet", modelId: "claude-sonnet-5-5" },
    { ...openTokenChat, id: "open-astra", modelId: "gpt-6-astra" },
    { ...openTokenChat, id: "duplicate-astra", modelId: "gpt-6-astra" },
    { ...openTokenChat, id: "open-claude", modelId: "claude-fable-5-1", protocol: "anthropic" },
    { ...markChat, id: "old-sonnet", modelId: "claude-sonnet-5" },
    { ...markChat, id: "old-opus", modelId: "claude-opus-5" },
    { ...markChat, id: "gemini", modelId: "gemini-3.1-pro-preview" },
    { ...markChat, id: "wrong-protocol", modelId: "claude-sonnet-5-5", protocol: "openai" },
    { ...markChat, id: "wrong-provider", modelId: "gpt-6-astra", providerId: "other" },
    { ...image, id: "video", capabilities: ["video"] },
  ];
  expect(selectCreativeModels(models).map(model => model.id)).toEqual(["mark-astra", "mark-sonnet", "open-astra", "video"]);
  expect(models).toHaveLength(11);
  const renamed = { ...openTokenChat, id: "renamed", modelId: "gpt-6-astra", providerName: "Renamed", providerBaseUrl: "https://cn2.gw.opentoken.io/v1" };
  expect(selectCreativeModels([renamed])).toEqual([renamed]);
});
