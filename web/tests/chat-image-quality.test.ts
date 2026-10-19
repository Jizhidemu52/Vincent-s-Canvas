import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import ts from "typescript";
import { imageModelProfile } from "@/lib/image-model-settings";
import { modelLabelWithUsage } from "@/lib/model-picker-options";
import { chatImageQualitySettings, chatImageRequestOptions, preferredChatImageModel, resolveChatImageQuality } from "@/pages/chat/image-quality";
import { createChatSessionStorage } from "@/pages/chat/chat-session-storage";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { defaultConfig } from "@/stores/use-config-store";
import { imageTaskParameters } from "@/services/api/image";

const originalModels = useBusinessConfigStore.getState().models;
afterEach(() => useBusinessConfigStore.setState({ models: originalModels }));
const models = [
    { id: "40000000-0000-4000-8000-000000000105", modelId: "40000000-0000-4000-8000-000000000105", name: "gpt-image-2", imageParameterProfile: "standard", capabilities: ["generate", "edit"] },
    { id: "pixel-model", modelId: "pixel-model", name: "像素模型", imageParameterProfile: "pixel", capabilities: ["generate", "edit"] },
    { id: "resolution-model", modelId: "resolution-model", name: "分辨率模型", imageParameterProfile: "resolution", capabilities: ["generate", "edit"] },
    { id: "speed-model", modelId: "speed-model", name: "速度模型", imageParameterProfile: "speed", capabilities: ["generate"] },
    { id: "mark-flare-id", modelId: "mark-flare-id", name: "aplmart-gpt2.5-flare", imageParameterProfile: "quality-resolution", capabilities: ["generate", "edit"] },
    { id: "mark-sunburst-id", modelId: "mark-sunburst-id", name: "aplmart-gpt2.5-sunburst", imageParameterProfile: "quality-resolution", capabilities: ["generate", "edit"] },
    { id: "mark-nano-id", modelId: "mark-nano-id", name: "aplmart-nano2.1", imageParameterProfile: "resolution-1k", capabilities: ["generate", "edit"] },
] as any[];

test.each(["blend", "midjourney-blend"])("chat rejects promptless %s profiles and safely falls back from saved selections", profile => {
    const blend = { ...models[0], id: "opaque-fusion-id", modelId: "opaque-fusion-id", name: "多图融合", imageParameterProfile: profile, capabilities: ["generate"] };
    const open = { ...models[0], id: "open-gpt2", modelId: "open-gpt2", name: "gpt-image-2", parameterModelId: "gpt-image-2" };
    const apimart = { ...models[0], id: "apimart-gpt2", modelId: "apimart-gpt2", name: "aplmart-gpt2", parameterModelId: "gpt-image-2" };
    const available = [blend, open, apimart];
    expect(preferredChatImageModel(available, [blend.id])?.id).toBe("apimart-gpt2");
    expect(preferredChatImageModel(available, [blend.id], "generate")?.id).toBe("apimart-gpt2");
    expect(preferredChatImageModel(available, [blend.id, open.id], "generate")?.id).toBe("open-gpt2");
    expect(preferredChatImageModel(available, [apimart.id], "edit")?.id).toBe("apimart-gpt2");
    expect(preferredChatImageModel([blend], [blend.id])).toBeUndefined();
    expect(preferredChatImageModel([blend], [blend.id], "generate")).toBeUndefined();
    expect(available.map(model => model.id)).toEqual(["opaque-fusion-id", "open-gpt2", "apimart-gpt2"]);
});
const source = readFileSync(new URL("../src/pages/chat/index.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("chat.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let sendExpression: ts.Expression | undefined;
let selectExpression: ts.JsxElement | undefined;
let resolutionExpression: ts.JsxElement | undefined;
let modelExpression: ts.JsxElement | undefined;
function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "send") sendExpression = node.initializer;
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === "select") {
        for (const attr of node.openingElement.attributes.properties) {
            if (!ts.isJsxAttribute(attr) || !attr.initializer || !ts.isStringLiteral(attr.initializer)) continue;
            if (attr.name.getText(ast) === "data-testid" && attr.initializer.text === "chat-image-quality") selectExpression = node;
            if (attr.name.getText(ast) === "data-testid" && attr.initializer.text === "chat-image-resolution") resolutionExpression = node;
            if (attr.name.getText(ast) === "aria-label" && attr.initializer.text === "出图模型") modelExpression = node;
        }
    }
    ts.forEachChild(node, visit);
}
visit(ast);

test("public standard models expose actual quality tiers, not invented K resolutions", () => {
    const settings = chatImageQualitySettings(imageModelProfile(models[0].modelId, models));
    expect(settings.quality).toBe("auto");
    expect(settings.options).toEqual([{ value: "auto", label: "自动" }, { value: "high", label: "高画质" }, { value: "medium", label: "标准" }, { value: "low", label: "普通" }]);
    expect(chatImageQualitySettings(imageModelProfile("pixel-model", models)).options.map(option => option.label)).toEqual(["1K", "2K", "4K"]);
    expect(chatImageQualitySettings(imageModelProfile("resolution-model", models)).options.map(option => option.label)).toEqual(["0.5K", "1K", "2K", "4K"]);
    const speed = chatImageQualitySettings(imageModelProfile("speed-model", models));
    expect(speed.adjustable).toBe(false);
    expect(speed.options).toEqual([{ value: "relax", label: "模型默认" }]);
});

function sendHarness({ action = "generate", quality = "high", resolution = undefined as string | undefined, imageModels = models.slice(0, 1), discussion = false, planGate = Promise.resolve() } = {}) {
    useBusinessConfigStore.setState({ models });
    if (!sendExpression) throw new Error("Actual send handler not found");
    const initial = { id: "session-a", title: "会话A", imageModelId: models[0].modelId, imageQuality: quality, imageResolution: resolution, messages: [] as any[] };
    const sessionsRef = { current: [initial] };
    const snapshots: any[] = [];
    const calls: any[] = [];
    const config = { model: "chat-model", imageModel: models[0].modelId, quality: "4k", imageOptions: '{"resolution":"2k","output_format":"webp"}' };
    const bindings = {
        sessionsReady: true, draft: "只改花瓣", attachments: [], readingAttachments: false, sendingRef: { current: false }, placingImageRef: { current: false }, activeSession: initial,
        selectedModel: "chat-model", selected: { modelId: "chat-model" }, creativeModelId: "chat-model", config, imageModels, preferredChatImageModel, resolveChatImageQuality, chatImageRequestOptions,
        activeSendRef: { current: null }, preparingMessageRef: { current: false }, loadedStorageKeyRef: { current: "user-a" }, storageKey: "user-a", sessionsRef,
        createClientId: (() => { let count = 0; return () => `message-${++count}`; })(),
        persistSessions: async (value: any[]) => { snapshots.push(structuredClone(value)); }, persistence: { clear() {} }, setIsSending() {}, setSendPhase() {}, setDraft() {}, setAttachments() {},
        updateSession: (id: string, update: (value: any) => any) => { sessionsRef.current = sessionsRef.current.map(value => value.id === id ? update(value) : value); },
        followBottomRef: { current: false }, activeStreamRef: { current: null }, createChatStreamBuffer: () => ({ push() {}, flush() {}, cancel() {} }),
        requestCreativeChatPlan: async () => { await planGate; return discussion ? { kind: "discussion", content: "只讨论" } : { kind: "image", action, prompt: "只改花瓣", content: "", references: [], lineage: { sourceImageIds: [], preservedConstraints: [] } }; },
        requestGeneration: async (cfg: any, _prompt: string, options: any) => submit(cfg, options),
        requestEdit: async (cfg: any, _prompt: string, _refs: any, _mask: any, options: any) => submit(cfg, options),
        imageToDataUrl: async (image: any) => image.dataUrl, message: { warning() {}, error() {} },
    };
    async function submit(cfg: any, options: any) {
        calls.push(structuredClone(cfg));
        options.onSubmissionStarted();
        await options.onSubmitted(["task-quality"]);
        return [{ id: "image", sourceTaskId: "task-quality", dataUrl: "data:image/png;base64,AQID" }];
    }
    const code = ts.transpileModule(`exports.send = ${sendExpression.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    const exports = {} as { send: () => Promise<void> };
    new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exports);
    return { ...exports, calls, snapshots, sessionsRef, config, initial };
}

test.each(["generate", "edit"])("session quality reaches the real %s request config and is retained before submission and after success", async action => {
    const page = sendHarness({ action });
    await page.send();
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]).toMatchObject({ quality: "high", model: models[0].modelId, imageModel: models[0].modelId });
    expect(page.config.quality).toBe("4k");
    expect(page.snapshots[1][0].messages.at(-1).pendingImageTask).toMatchObject({ quality: "high", modelId: models[0].modelId });
    expect(page.snapshots[2][0].messages.at(-1).pendingImageTask).toMatchObject({ quality: "high", taskId: "task-quality" });
    expect(page.sessionsRef.current[0]!.messages.at(-1).generatedImages[0]).toMatchObject({ id: "task-quality:0", quality: "high" });
    expect(page.sessionsRef.current[0]!.imageQuality).toBe("high");
});

test("a planning delay cannot change the quality snapshot of the already sent request", async () => {
    const gate = Promise.withResolvers<void>();
    const page = sendHarness({ quality: "medium", planGate: gate.promise });
    const pending = page.send();
    await Promise.resolve();
    page.sessionsRef.current[0] = { ...page.sessionsRef.current[0]!, imageQuality: "low" };
    gate.resolve();
    await pending;
    expect(page.calls[0].quality).toBe("medium");
});

test("an incompatible action fallback blocks submission and changes the available profile so the user can resolve it", async () => {
    const page = sendHarness({ action: "edit", imageModels: [{ ...models[0], capabilities: ["generate"] }, { ...models[1], capabilities: ["edit"] }] });
    await page.send();
    expect(page.calls).toEqual([]);
    expect(page.sessionsRef.current[0]).toMatchObject({ imageModelId: "pixel-model", imageQuality: "1k" });
    expect(page.sessionsRef.current[0]!.messages.at(-1).content).toContain("已更新可选档位");
    expect(page.sessionsRef.current[0]!.messages.at(-1).pendingImageTask).toBeUndefined();
});

test("quality and image-model availability do not block a discussion", async () => {
    const page = sendHarness({ discussion: true, imageModels: [] });
    await page.send();
    expect(page.calls).toEqual([]);
    expect(page.sessionsRef.current[0]!.messages.at(-1).content).toBe("只讨论");
    expect(page.config.quality).toBe("4k");
});

test("the actual send path never submits a promptless image model even when it is the only configured choice", async () => {
    const blend = { ...models[0], id: "opaque-fusion-id", modelId: "opaque-fusion-id", name: "多图融合", imageParameterProfile: "blend", capabilities: ["generate"] };
    const page = sendHarness({ quality: "", imageModels: [blend] });
    await page.send();
    expect(page.calls).toEqual([]);
    expect(page.sessionsRef.current[0]!.messages.at(-1).content).toContain("尚未配置可用的图片生成服务");
    expect(page.sessionsRef.current[0]!.messages.at(-1).pendingImageTask).toBeUndefined();
});

function qualitySelect({ ready = true, sending = false, modelsLoading = false, model = models[0], pending = false, control = "quality", bound = false, quality = "high", resolution = undefined as string | undefined } = {}) {
    const expression = control === "resolution" ? resolutionExpression : control === "model" ? modelExpression : selectExpression;
    if (!expression) throw new Error("Actual image select not found");
    const sessions: any[] = [{ id: "a", imageQuality: quality, ...(resolution ? { imageResolution: resolution } : {}) }, { id: "b", imageQuality: "low" }];
    const bindings = {
        React, imageQualitySettings: chatImageQualitySettings(imageModelProfile(model?.modelId || "", models), sessions[0]!.imageQuality, sessions[0]!.imageResolution),
        imageModels: models, imageBinding: bound ? { modelConfigId: model?.id } : undefined, resolveChatImageQuality, modelLabelWithUsage,
        sessionsReady: ready, modelsLoading, isSending: sending, pendingImageMessage: pending, preferredImageModel: model,
        activeSession: sessions[0], updateSession: (id: string, update: (value: any) => any) => { const index = sessions.findIndex(value => value.id === id); sessions[index] = update(sessions[index]); },
    };
    const code = ts.transpileModule(`exports.select = ${expression.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React } }).outputText;
    const exports = {} as { select: React.ReactElement<any> };
    new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exports);
    return { select: exports.select, sessions };
}

test("the actual quality selector changes only the active session and persists distinct choices across reloads", async () => {
    const page = qualitySelect();
    expect(page.select.props.value).toBe("high");
    page.select.props.onChange({ target: { value: "medium" } });
    expect(page.sessions).toEqual([{ id: "a", imageModelId: models[0].modelId, imageQuality: "medium" }, { id: "b", imageQuality: "low" }]);
    const database = new Map<string, any>();
    const storage = createChatSessionStorage({ getItem: async <T,>(key: string) => structuredClone(database.get(key)) as T | null, setItem: async <T,>(key: string, value: T) => { database.set(key, structuredClone(value)); return value; } });
    await storage.save("owner-a", page.sessions);
    await storage.save("owner-b", [{ id: "other", imageQuality: "auto" }]);
    expect(await storage.load("owner-a", () => null)).toEqual(page.sessions);
    expect(await storage.load("owner-b", () => null)).toEqual([{ id: "other", imageQuality: "auto" }]);
});

test("the selector is disabled before hydration, while sending or recovering, with no image model, or for speed-only models", () => {
    expect(qualitySelect().select.props.disabled).toBe(false);
    for (const options of [{ ready: false }, { sending: true }, { modelsLoading: true }, { pending: true }, { model: null }, { model: models[3] }]) expect(qualitySelect(options).select.props.disabled).toBe(true);
});

test("Mark GPT exposes independent quality and resolution while Nano exposes only 1K / 2K / 4K", () => {
    for (const model of models.slice(4, 6)) {
        const settings = chatImageQualitySettings(imageModelProfile(model.modelId, models), "xhigh", "4k");
        expect(settings).toMatchObject({ quality: "xhigh", resolution: "4k", independentResolution: true, label: "图片质量" });
        expect(settings.options.map(option => option.value)).toEqual(["auto", "low", "medium", "high", "xhigh", "max"]);
        expect(settings.resolutionOptions.map(option => option.value)).toEqual(["1k", "2k", "4k"]);
    }
    const nano = chatImageQualitySettings(imageModelProfile(models[6].modelId, models), "2k", "4k");
    expect(nano).toMatchObject({ quality: "2k", resolution: undefined, independentResolution: false, label: "清晰度" });
    expect(nano.options.map(option => option.value)).toEqual(["1k", "2k", "4k"]);
    expect(nano.resolutionOptions).toEqual([]);
});

test.each(["generate", "edit"])("Mark GPT %s snapshots both session parameters into the actual task builder", async action => {
    const page = sendHarness({ action, quality: "xhigh", resolution: "4k", imageModels: [models[4]] });
    await page.send();
    expect(page.calls).toHaveLength(1);
    expect(JSON.parse(page.calls[0].imageOptions)).toEqual({ resolution: "4k", output_format: "webp" });
    expect(imageTaskParameters({ ...defaultConfig, ...page.calls[0] })).toMatchObject({ quality: "xhigh", resolution: "4k" });
    expect(page.config.imageOptions).toBe('{"resolution":"2k","output_format":"webp"}');
    expect(page.snapshots[1][0]).toMatchObject({ imageQuality: "xhigh", imageResolution: "4k" });
    expect(page.snapshots[1][0].messages.at(-1).pendingImageTask).toMatchObject({ quality: "xhigh", resolution: "4k" });
    expect(page.sessionsRef.current[0]!.messages.at(-1).generatedImages[0]).toMatchObject({ quality: "xhigh", resolution: "4k" });
});

test("Nano resolution remains the primary setting and independent GPT resolution never leaks to another model", async () => {
    const nano = sendHarness({ quality: "2k", resolution: "4k", imageModels: [models[6]] });
    await nano.send();
    expect(nano.calls).toHaveLength(1);
    expect(JSON.parse(nano.calls[0].imageOptions)).not.toHaveProperty("resolution");
    const nanoParameters = imageTaskParameters({ ...defaultConfig, ...nano.calls[0] });
    expect(nanoParameters).toMatchObject({ resolution: "2k" });
    expect(nanoParameters).not.toHaveProperty("quality");
    expect(nano.sessionsRef.current[0].imageResolution).toBeUndefined();

    const standard = sendHarness({ quality: "high", resolution: "4k" });
    await standard.send();
    expect(JSON.parse(standard.calls[0].imageOptions)).not.toHaveProperty("resolution");
    expect(imageTaskParameters({ ...defaultConfig, ...standard.calls[0] })).not.toHaveProperty("resolution");
});

test("resolution uses the send snapshot, not a later session mutation during planning", async () => {
    const gate = Promise.withResolvers<void>();
    const page = sendHarness({ quality: "high", resolution: "4k", imageModels: [models[5]], planGate: gate.promise });
    const pending = page.send();
    await Promise.resolve();
    page.sessionsRef.current[0] = { ...page.sessionsRef.current[0]!, imageResolution: "1k" };
    gate.resolve();
    await pending;
    expect(JSON.parse(page.calls[0].imageOptions).resolution).toBe("4k");
});

test("the actual Mark resolution selector changes only this session and survives storage reload", async () => {
    const page = qualitySelect({ model: models[4], control: "resolution", resolution: "2k" });
    expect(page.select.props.value).toBe("2k");
    page.select.props.onChange({ target: { value: "4k" } });
    expect(page.sessions[0]).toMatchObject({ imageModelId: models[4].modelId, imageQuality: "high", imageResolution: "4k" });
    expect(page.sessions[1]).toEqual({ id: "b", imageQuality: "low" });
    const data = new Map<string, any>();
    const storage = createChatSessionStorage({ getItem: async <T,>(key: string) => structuredClone(data.get(key)) as T | null, setItem: async <T,>(key: string, value: T) => { data.set(key, structuredClone(value)); return value; } });
    await storage.save("owner", page.sessions);
    expect(await storage.load("owner", () => null)).toEqual(page.sessions);
});

test("the actual image-model picker resets incompatible settings and respects backend binding", () => {
    useBusinessConfigStore.setState({ models });
    const page = qualitySelect({ model: models[4], control: "model", resolution: "4k" });
    page.select.props.onChange({ target: { value: models[6].modelId } });
    expect(page.sessions[0]).toMatchObject({ imageModelId: models[6].modelId, imageQuality: "1k", imageResolution: undefined });
    expect(page.sessions[1]).toEqual({ id: "b", imageQuality: "low" });
    expect(qualitySelect({ control: "model", bound: true }).select.props.disabled).toBe(true);
    expect(qualitySelect({ control: "model", bound: false }).select.props.disabled).toBe(false);
    expect(qualitySelect({ model: models[4] }).select.props["aria-label"]).toBe("图片质量");
    expect(qualitySelect({ model: models[6] }).select.props["aria-label"]).toBe("图片清晰度");
});
