import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import ts from "typescript";
import { imageModelProfile } from "@/lib/image-model-settings";
import { CHAT_FOLLOW_IMAGE_SIZE, chatImageSizeForSource, chatImageSizeOptions, resolveChatImageSize } from "@/pages/chat/image-size";
import { chatImageTaskSignature, completeChatImageTask, duplicateChatImageTask } from "@/pages/chat/chat-image-tasks";
import { createChatSessionStorage } from "@/pages/chat/chat-session-storage";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { defaultConfig } from "@/stores/use-config-store";
import type { PendingChatImageTask } from "@/services/api/chat-image-recovery";
import type { ChatSession } from "@/pages/chat/chat-types";
import type { ReferenceImage } from "@/types/image";
import { i18nHarness } from "./helpers/i18n-harness";

const originalModels = useBusinessConfigStore.getState().models;
afterEach(() => useBusinessConfigStore.setState({ models: originalModels }));
const models = [
    { id: "ratio", modelId: "ratio", name: "比例模型", imageParameterProfile: "pixel", capabilities: ["generate", "edit"] },
    { id: "fixed", modelId: "fixed", name: "固定尺寸模型", imageParameterProfile: "standard", capabilities: ["generate", "edit"] },
    { id: "auto-only", modelId: "auto-only", name: "待确认模型", imageParameterProfile: "unverified", capabilities: ["generate", "edit"] },
] as any[];
const config = { ...defaultConfig, model: "ratio", imageModel: "ratio", size: "1:1", quality: "1k" };
const base: ReferenceImage = { id: "source", name: "底图.png", type: "image/png", dataUrl: "data:image/png;base64,AA==", width: 1, height: 1 };

test.each([
    [{ width: 1500, height: 2000 }, "3:4"],
    [{ width: 2000, height: 1500 }, "4:3"],
    [{ width: 1254, height: 1254 }, "1:1"],
    [{ width: 1080, height: 1920 }, "9:16"],
] as const)("follow source reads the actual %j pixels and explicitly submits %s, ignoring global square and stale dimensions", async (dimensions, expected) => {
    useBusinessConfigStore.setState({ models });
    const before = structuredClone({ config, base });
    const reads: ReferenceImage[] = [];
    const size = await resolveChatImageSize(config, undefined, "edit", base, () => {}, async source => { reads.push(source); return dimensions; });
    expect(size).toBe(expected);
    expect(reads).toEqual([base]);
    expect({ config, base }).toEqual(before);
});

test("a fixed pixel preset may preserve an exact source aspect but no arbitrary pixels are synthesized", () => {
    const profile = imageModelProfile("fixed", models);
    expect(chatImageSizeForSource({ width: 600, height: 900 }, profile)).toBe("1024x1536");
    expect(() => chatImageSizeForSource({ width: 1500, height: 2000 }, profile)).toThrow("不能精确保留底图画幅");
    expect(() => chatImageSizeForSource({ width: 1500, height: 2000 }, profile)).toThrow("1024x1536");
    expect(() => chatImageSizeForSource({ width: 1500, height: 2000 }, imageModelProfile("auto-only", models))).toThrow("图片任务尚未提交");
});

test.each(["1:1", "4:3", "auto"])("explicit session selection %s wins without reading or changing the base", async requested => {
    useBusinessConfigStore.setState({ models });
    const size = await resolveChatImageSize(config, requested, "edit", base, () => {}, async () => { throw new Error("No source measurement needed for explicit size"); });
    expect(size).toBe(requested);
    expect(config.size).toBe("1:1");
});

test("generation without a base keeps its existing default unless the session explicitly chooses a size", async () => {
    useBusinessConfigStore.setState({ models });
    const noRead = async () => { throw new Error("New creation must not follow a previous image"); };
    expect(await resolveChatImageSize({ ...config, size: "16:9" }, undefined, "generate", base, () => {}, noRead)).toBe("16:9");
    expect(await resolveChatImageSize(config, "3:4", "generate", undefined, () => {}, noRead)).toBe("3:4");
});

test("model changes never silently replace an explicit aspect with the nearest different aspect", async () => {
    useBusinessConfigStore.setState({ models });
    expect(await resolveChatImageSize({ ...config, model: "fixed" }, "1:1", "edit", base, () => {})).toBe("1024x1024");
    await expect(resolveChatImageSize({ ...config, model: "fixed" }, "3:4", "edit", base, () => {})).rejects.toThrow("不支持已选择的图片尺寸");
});

test("unreadable or cancelled base measurement cannot fall back to a square task", async () => {
    useBusinessConfigStore.setState({ models });
    await expect(resolveChatImageSize(config, undefined, "edit", undefined, () => {})).rejects.toThrow("没有可用的编辑底图");
    await expect(resolveChatImageSize(config, undefined, "edit", base, () => {}, async () => { throw new Error("source unavailable"); })).rejects.toThrow("source unavailable");
    let cancelled = false;
    await expect(resolveChatImageSize(config, undefined, "edit", base, () => { if (cancelled) throw new DOMException("stopped", "AbortError"); }, async () => { cancelled = true; return { width: 1500, height: 2000 }; })).rejects.toThrow("stopped");
    expect(() => chatImageSizeForSource({ width: 0, height: 120 }, imageModelProfile("ratio", models))).toThrow("底图尺寸无法读取");
});

test("actual resolved size distinguishes duplicate tasks and is retained on original-task recovery", () => {
    const pending: PendingChatImageTask = { requestId: "original", action: "edit", modelId: "ratio", prompt: "只改颜色", size: "3:4", focusRevision: 1 };
    pending.signature = chatImageTaskSignature(pending);
    const session: ChatSession = { id: "a", title: "A", updatedAt: "now", focusRevision: 1, messages: [{ id: "slot", role: "assistant", content: "", createdAt: "now", pendingImageTask: pending }] };
    expect(duplicateChatImageTask(session, { ...pending, requestId: "next", signature: undefined })).toBe(session.messages[0]);
    expect(duplicateChatImageTask(session, { ...pending, requestId: "different", size: "1:1", signature: undefined })).toBeUndefined();
    const recovered = completeChatImageTask(session, "slot", pending, [{ id: "result", dataUrl: "original-result" }], true);
    expect(recovered.messages[0].generatedImages?.[0].size).toBe("3:4");
    expect(recovered.messages[0].pendingImageTask).toBeUndefined();
});

const source = readFileSync(new URL("../src/pages/chat/index.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("chat.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let sizeSelect: ts.JsxSelfClosingElement | undefined;
function visit(node: ts.Node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "Select" && node.attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.getText(ast) === "data-testid" && attr.initializer && ts.isStringLiteral(attr.initializer) && attr.initializer.text === "chat-image-size")) sizeSelect = node;
    ts.forEachChild(node, visit);
}
visit(ast);

test("the real size control saves only the active conversation, survives reload, and can return to following", async () => {
    if (!sizeSelect) throw new Error("Size selector missing");
    const sessions: ChatSession[] = [{ id: "a", title: "A", updatedAt: "now", messages: [] }, { id: "b", title: "B", updatedAt: "now", messages: [], imageSize: "16:9" }];
    const bindings = { ...i18nHarness, React, Select: "select", activeSession: sessions[0], CHAT_FOLLOW_IMAGE_SIZE, chatImageSizeOptions,
        qualityProfile: imageModelProfile("ratio", models), sessionsReady: true, modelsLoading: false, isSending: false, preferredImageModel: models[0],
        updateSession: (id: string, update: (session: ChatSession) => ChatSession) => { const index = sessions.findIndex(session => session.id === id); sessions[index] = update(sessions[index]); } };
    const code = ts.transpileModule(`exports.select = ${sizeSelect.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React } }).outputText;
    const exported = {} as { select: React.ReactElement<any> };
    new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exported);
    expect(exported.select.props.value).toBe(CHAT_FOLLOW_IMAGE_SIZE);
    expect(exported.select.props.options.some((item: any) => item.value === "3:4")).toBe(true);
    exported.select.props.onChange("1:1");
    expect(sessions.map(session => session.imageSize)).toEqual(["1:1", "16:9"]);
    const database = new Map();
    const storage = createChatSessionStorage({ getItem: async key => structuredClone(database.get(key)) ?? null, setItem: async (key, value) => { database.set(key, structuredClone(value)); return value; } });
    await storage.save("owner", sessions);
    expect((await storage.load<ChatSession>("owner", () => null)).map(session => session.imageSize)).toEqual(["1:1", "16:9"]);
    exported.select.props.onChange(CHAT_FOLLOW_IMAGE_SIZE);
    expect(sessions.map(session => session.imageSize)).toEqual([undefined, "16:9"]);
    expect(config.size).toBe("1:1");
});
