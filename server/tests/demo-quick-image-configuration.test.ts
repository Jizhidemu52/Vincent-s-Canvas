import { describe, expect, test } from "bun:test";
import { DemoQuickImageConfigurationStore } from "../src/demo-quick-image-configuration";
import { resolveDemoToolConfiguration } from "../src/demo-tool-configuration";
import { QUICK_IMAGE_SNAPSHOT } from "../src/quick-image-tools";
import { moduleKeys } from "../../shared/feature-catalog";
import { MARK_IMAGE_PROVIDER_ID } from "../../shared/mark-image-models";
import { quickImageTaskTarget } from "../../shared/quick-image-tools";

const admin = { id: "admin", role: "super_admin" }, employee = { id: "employee", role: "designer" };
const mai = "10000000-0000-4000-8000-000000000001", nano = "10000000-0000-4000-8000-000000000002", alternative = "10000000-0000-4000-8000-000000000003";
const models = [{ id: mai, modelId: "mai-image-2.6-flash", providerId: MARK_IMAGE_PROVIDER_ID, enabled: true, capabilities: ["edit"] },
  { id: nano, modelId: "gemini-nano-banana-2.1", providerId: MARK_IMAGE_PROVIDER_ID, enabled: true, capabilities: ["edit"] },
  { id: alternative, modelId: "gpt-image-2.6-flare", providerId: "alternative", enabled: true, capabilities: ["edit"] }];
const providers = [{ id: MARK_IMAGE_PROVIDER_ID, protocol: "apimart", enabled: true }, { id: "alternative", protocol: "apimart", enabled: true }];
const draft = { modelConfigId: alternative, prompt: "Restore selected product", parameters: { resolution: "2k", size: "auto" } };
const input = { ...quickImageTaskTarget("hd-upscale"), sourceUrls: ["owned"], prompt: "FORGED", parameters: { quickImageAction: "hd-upscale", n: 4 } };

describe("in-memory demo quick configuration shares production contract without opening an admin login", () => {
  test("default and model catalog match production; internal mutations still require super-admin", () => {
    const store = new DemoQuickImageConfigurationStore(models, providers);
    expect(store.read("remove-background")).toMatchObject({ modelConfigId: mai, configurationVersion: 0, isDefault: true });
    expect(store.read("hd-upscale")).toMatchObject({ modelConfigId: nano, parameters: { resolution: "4k" } });
    expect(store.catalog(admin).models.map(model => model.id)).toEqual([mai, nano, alternative]);
    for (const actor of [null, employee, { id: "department", role: "department_admin" }]) {
      expect(() => store.catalog(actor)).toThrow(); expect(() => store.save("hd-upscale", { ...draft, expectedVersion: 0 }, actor)).toThrow();
      expect(() => store.prepare(input, { configuration: draft, actor })).toThrow();
    }
  });
  test("CAS, draft non-save and immutable admission snapshots match the real backend", () => {
    const store = new DemoQuickImageConfigurationStore(models, providers);
    expect(store.save("hd-upscale", { ...draft, expectedVersion: 0 }, admin).configuration.configurationVersion).toBe(1);
    expect(() => store.save("hd-upscale", { ...draft, expectedVersion: 0 }, admin)).toThrow("其他管理员");
    const prepared = store.prepare(input);
    store.save("hd-upscale", { modelConfigId: nano, prompt: "NEW VERSION", parameters: { resolution: "4k", size: "auto" }, expectedVersion: 1 }, admin);
    expect(store.prepare(prepared)).toBe(prepared);
    expect(prepared.prompt).toBe(draft.prompt); expect(prepared.parameters).toMatchObject({ resolution: "2k", n: 1, count: 1, quickImage: { configurationVersion: 1 } });
    expect(Object.isFrozen(prepared[QUICK_IMAGE_SNAPSHOT])).toBe(true);
    const tested = store.prepare(input, { configuration: { ...draft, prompt: "UNSAVED" }, actor: admin });
    expect(tested.prompt).toBe("UNSAVED"); expect(tested.parameters).toMatchObject({ quickImage: { adminTest: true } });
    expect(store.read("hd-upscale")).toMatchObject({ prompt: "NEW VERSION", configurationVersion: 2 });
    const binding = [{ toolKey: "detail-enhance", modelConfigId: nano, enabled: true }];
    expect(resolveDemoToolConfiguration(prepared, binding, models, providers, Object.fromEntries(moduleKeys.map(key => [key, true]))).modelConfigId).toBe(alternative);
    expect(binding[0]!.modelConfigId).toBe(nano);
    const copy = store.read("hd-upscale"); copy.parameters.resolution = "FORGED"; expect(store.read("hd-upscale").parameters.resolution).toBe("4k");
  });
  test("the same scalar allowlist and adapter rules reject unsafe drafts without changing saved state", () => {
    const store = new DemoQuickImageConfigurationStore(models, providers);
    for (const parameters of [{ n: 9 }, { output_format: "gif" }, { mask_url: "https://evil.invalid" }, { resolution: "8k" }, { size: false }]) {
      expect(() => store.save("hd-upscale", { ...draft, parameters, expectedVersion: 0 }, admin)).toThrow();
    }
    expect(store.read("hd-upscale").configurationVersion).toBe(0);
  });
});
