import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import ts from "typescript";
import { imageModelProfile } from "@/lib/image-model-settings";
import { chatImageQualitySettings, preferredChatImageModel, resolveChatImageQuality } from "@/pages/chat/image-quality";
import { createChatSessionStorage } from "@/pages/chat/chat-session-storage";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";

const originalModels = useBusinessConfigStore.getState().models;
afterEach(() => useBusinessConfigStore.setState({ models: originalModels }));
const models = [
    { id: "40000000-0000-4000-8000-000000000105", modelId: "40000000-0000-4000-8000-000000000105", name: "gpt-image-2", imageParameterProfile: "standard", capabilities: ["generate", "edit"] },
    { id: "pixel-model", modelId: "pixel-model", name: "像素模型", imageParameterProfile: "pixel", capabilities: ["generate", "edit"] },
    { id: "resolution-model", modelId: "resolution-model", name: "分辨率模型", imageParameterProfile: "resolution", capabilities: ["generate", "edit"] },
    { id: "speed-model", modelId: "speed-model", name: "速度模型", imageParameterProfile: "speed", capabilities: ["generate"] },
] as any[];
const source = readFileSync(new URL("../src/pages/chat/index.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("chat.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let sendExpression: ts.Expression | undefined;
let selectExpression: ts.JsxElement | undefined;
function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "send") sendExpression = node.initializer;
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === "select" && node.openingElement.attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.getText(ast) === "aria-label" && attr.initializer && ts.isStringLiteral(attr.initializer) && attr.initializer.text === "图片清晰度")) selectExpression = node;
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

function sendHarness({ action = "generate", quality = "high", imageModels = models.slice(0, 1), discussion = false, planGate = Promise.resolve() } = {}) {
    useBusinessConfigStore.setState({ models });
    if (!sendExpression) throw new Error("Actual send handler not found");
    const initial = { id: "session-a", title: "会话A", imageModelId: models[0].modelId, imageQuality: quality, messages: [] as any[] };
    const sessionsRef = { current: [initial] };
    const snapshots: any[] = [];
    const calls: any[] = [];
    const config = { model: "chat-model", imageModel: models[0].modelId, quality: "4k" };
    const bindings = {
        sessionsReady: true, draft: "只改花瓣", attachments: [], readingAttachments: false, sendingRef: { current: false }, placingImageRef: { current: false }, activeSession: initial,
        selectedModel: "chat-model", selected: { modelId: "chat-model" }, creativeModelId: "chat-model", config, imageModels, preferredChatImageModel, resolveChatImageQuality,
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

function qualitySelect({ ready = true, sending = false, modelsLoading = false, model = models[0], pending = false } = {}) {
    if (!selectExpression) throw new Error("Actual quality select not found");
    const sessions = [{ id: "a", imageQuality: "high" }, { id: "b", imageQuality: "low" }];
    const bindings = {
        React, imageQualitySettings: chatImageQualitySettings(imageModelProfile(model?.modelId || "", models), sessions[0]!.imageQuality),
        sessionsReady: ready, modelsLoading, isSending: sending, pendingImageMessage: pending, preferredImageModel: model,
        activeSession: sessions[0], updateSession: (id: string, update: (value: any) => any) => { const index = sessions.findIndex(value => value.id === id); sessions[index] = update(sessions[index]); },
    };
    const code = ts.transpileModule(`exports.select = ${selectExpression.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React } }).outputText;
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
