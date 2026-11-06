import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import ts from "typescript";
import { createSceneForm } from "@/pages/creative/scene-form-model";
import { defaultConfig } from "@/stores/use-config-store";
import type { SceneImage } from "@/pages/creative/use-scene-workspace";

const config = { ...defaultConfig, model: "gpt-image-2", imageModel: "gpt-image-2", count: "1", size: "1024x1024", quality: "auto" };
const source: SceneImage = { id: "result-original", name: "result.png", type: "image/png", mimeType: "image/png", storageKey: "original-bytes", dataUrl: "blob:original", width: 256, height: 128, bytes: 25 };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function harness(saved = new Map<string, unknown>(), token: string | null = "token-a") {
    const path = new URL("../src/pages/creative/use-scene-workspace.ts", import.meta.url), requireModule = createRequire(path);
    const compiled = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
    const states: any[] = [], refs: any[] = [], effects: any[] = [], pendingEffects: Array<() => void> = [];
    const calls: string[] = [];
    let stateIndex = 0, refIndex = 0, effectIndex = 0, error = "";
    const userState = () => ({ user: { id: "owner", role: "designer", status: "active", creditBalance: 100 }, status: "authenticated" });
    const userStore = Object.assign((select: Function) => select(userState()), { getState: userState });
    const dependencies: Record<string, any> = {
        react: { ...React,
            useState(initial: any) { const index = stateIndex++; if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial; return [states[index], (value: any) => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
            useRef: (initial: any) => refs[refIndex++] ||= { current: initial }, useMemo: (factory: Function) => factory(),
            useEffect(effect: Function, deps?: any[]) { const index = effectIndex++, prior = effects[index]; if (prior && deps?.every((value, i) => Object.is(value, prior.deps?.[i]))) return; pendingEffects.push(() => { prior?.cleanup?.(); effects[index] = { deps, cleanup: effect() }; }); },
        },
        "@/lib/workspace-storage": { createWorkspaceStorage: () => ({ getItem: async (key: string) => structuredClone(saved.get(key) ?? null), setItem: async (key: string, value: unknown) => { calls.push(`save ${key}`); saved.set(key, structuredClone(value)); return value; } }) },
        "@/lib/design-handoff": { designDraftScope: (id: string, destination: string) => `${destination}:design:${id}`, consumeDesignHandoff: async (id: string, destination: string) => { calls.push(`consume ${id} ${destination}`); if (error) throw new Error(error); return { source, brief: { version: 1, sourceScene: "style-to-sketch", requirements: ["目标产品：蓝色衬衫", "关键特征：保留六颗纽扣"] } }; } },
        "@/lib/image-utils": { ...requireModule("@/lib/image-utils"), readImageMeta: async () => ({ width: 256, height: 128, mimeType: "image/png" }) },
        "@/services/image-storage": { resolveImageUrl: async (key: string, fallback: string) => key ? "blob:original" : fallback, getImageBlob: async () => new Blob(["original bytes"], { type: "image/png" }) },
        "@/stores/use-user-store": { useUserStore: userStore },
        "@/stores/use-config-store": { ...requireModule("@/stores/use-config-store"), useEffectiveConfig: () => config },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: Function) => select({ status: "ready", models: [{ id: config.model, modelId: config.model, capabilities: ["generate", "edit"] }], estimate: () => ({ credits: 0, configured: true }) }) },
        "@/stores/use-module-store": { useModuleEnabled: () => true },
        "@/hooks/use-tool-config": { useToolConfig: (value: unknown) => value, useToolEnabled: () => true },
        "@/lib/deployment-features": { deploymentFeatures: { creditsEnabled: false } },
        "@/lib/image-model-settings": { ...requireModule("@/lib/image-model-settings"), useImageModelProfile: () => requireModule("@/lib/image-model-settings").imageModelProfile(config.model) },
        "@/services/api/image": { requestGeneration: () => { calls.push("paid generation"); throw new Error("not allowed"); }, requestEdit: () => { calls.push("paid edit"); throw new Error("not allowed"); } },
    };
    const module = { exports: {} as any };
    new Function("require", "module", "exports", compiled)((name: string) => dependencies[name] || requireModule(name), module, module.exports);
    const render = () => { stateIndex = refIndex = effectIndex = 0; const value = module.exports.useSceneWorkspace("garment-colorway", token); pendingEffects.splice(0).forEach(effect => effect()); return value; };
    return { saved, calls, render, initialize: async () => { render(); await tick(); render(); await tick(); return render(); }, failConsume: (message: string) => { error = message; }, unmount: () => effects.forEach(effect => effect?.cleanup?.()) };
}

test("handoff initializes an independent complete draft before enabling inputs, without replacing the ordinary draft", async () => {
    const ordinary = { form: { ...createSceneForm("garment-colorway"), targetProduct: "普通草稿产品", keepDetails: "普通草稿要求" }, images: {}, config };
    const saved = new Map<string, unknown>([["draft:owner:garment-colorway", ordinary]]);
    const app = harness(saved); const ws = await app.initialize();
    expect(ws.loading).toBe(false);
    expect(ws.form.carryoverRequirements).toEqual(["目标产品：蓝色衬衫", "关键特征：保留六颗纽扣"]);
    expect(ws.images.primary).toMatchObject({ id: source.id, storageKey: source.storageKey, width: 256, height: 128, dataUrl: "blob:original" });
    expect(ws.selection).toBeNull(); expect(ws.results).toEqual([]);
    expect(saved.get("draft:owner:garment-colorway")).toEqual(ordinary);
    const isolated = saved.get("draft:owner:garment-colorway:creative-garment-colorway:design:token-a") as any;
    expect(isolated.form.carryoverRequirements).toEqual(ws.form.carryoverRequirements);
    expect(isolated.images.primary.dataUrl).toBe("");
    expect(app.calls.filter(call => call.startsWith("consume"))).toHaveLength(1);
    expect(app.calls.some(call => call.startsWith("paid"))).toBe(false); app.unmount();
});

test("refresh restores token-specific edits without consuming or replaying the original handoff", async () => {
    const first = harness(); let ws = await first.initialize();
    ws.setForm({ ...ws.form, keepDetails: "刷新必须保留", carryoverRequirements: ["用户已修改的要求"] });
    first.render(); await tick(); first.unmount();
    const refreshed = harness(first.saved); refreshed.failConsume("must not consume again");
    ws = await refreshed.initialize();
    expect(ws.form.keepDetails).toBe("刷新必须保留"); expect(ws.form.carryoverRequirements).toEqual(["用户已修改的要求"]);
    expect(refreshed.calls.some(call => call.startsWith("consume"))).toBe(false);
    expect(refreshed.calls.some(call => call.startsWith("paid"))).toBe(false); refreshed.unmount();
});

test("missing or foreign handoff fails closed without saving a blank replacement or submitting", async () => {
    const app = harness(); app.failConsume("此设计交接不属于当前账号");
    const ws = await app.initialize();
    expect(ws.error).toContain("不属于当前账号");
    expect(ws.validation).toContain("设计交接草稿尚未准备好");
    expect([...app.saved.keys()].filter(key => key.startsWith("draft:"))).toEqual([]);
    expect(app.calls.some(call => call.startsWith("paid"))).toBe(false); app.unmount();
});

test("ordinary scene drafts do not attempt any handoff import", async () => {
    const app = harness(new Map(), null); app.failConsume("not expected");
    const ws = await app.initialize();
    expect(ws.form.carryoverRequirements).toEqual([]);
    expect(app.calls.some(call => call.startsWith("consume"))).toBe(false);
    expect(app.calls.some(call => call.startsWith("paid"))).toBe(false); app.unmount();
});
