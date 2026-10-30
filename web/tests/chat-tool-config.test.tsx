import { expect, test } from "bun:test";
import { i18nHarness } from "./helpers/i18n-harness";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type DependencyList, type EffectCallback, type ReactElement } from "react";
import ts from "typescript";
import { defaultConfig } from "@/stores/use-config-store";
import { imageModelProfile } from "@/lib/image-model-settings";
import type { BusinessConfig } from "@/services/api/business-config";

const pageUrl = new URL("../src/pages/chat/index.tsx", import.meta.url);
const requireModule = createRequire(pageUrl);
const code = ts.transpileModule(readFileSync(pageUrl, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;

function elements(node: unknown): ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement(node)) return [];
    const element = node as ReactElement<any>;
    return [element, ...elements(element.props.children), ...(element.type === "Select" ? (element.props.options || []).map((option: any) => React.createElement("option", { value: option.value }, option.label)) : [])];
}

function chatPageHarness(initial: BusinessConfig, savedImageModelId?: string) {
    type State = BusinessConfig & { status: "ready" | "loading" | "error"; error: string | null; refresh: () => Promise<void> };
    let refreshes = 0;
    let directModelReads = 0;
    const plannedConfigs: Array<{ model: string; textModel: string }> = [];
    let business: State = { ...initial, status: "ready", error: null, refresh: async () => { refreshes++; } };
    const values: any[] = [];
    const effects: Array<{ deps?: DependencyList; cleanup?: ReturnType<EffectCallback> }> = [];
    const pending: Array<() => void> = [];
    let cursor = 0;
    const equal = (a?: DependencyList, b?: DependencyList) => Boolean(a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index])));
    const useState = (initialValue: any) => {
        const index = cursor++;
        if (!(index in values)) values[index] = typeof initialValue === "function" ? initialValue() : initialValue;
        return [values[index], (next: any) => { values[index] = typeof next === "function" ? next(values[index]) : next; }];
    };
    const useMemo = (factory: () => unknown, deps?: DependencyList) => {
        const index = cursor++;
        if (!values[index] || !equal(values[index].deps, deps)) values[index] = { deps, value: factory() };
        return values[index].value;
    };
    const userState = { user: { id: "designer", role: "designer", status: "active" } };
    const app = { message: { error() {}, warning() {}, success() {} }, modal: { confirm() {} } };
    const config = { ...defaultConfig, imageModel: "old-image" };
    const deps: Record<string, any> = {
        "@/lib/i18n": i18nHarness,
        "@/hooks/use-conversation-image-tools": { useConversationImageTools: () => ({ download: async () => undefined, compare() {}, compareDialog: null }) },
        "@/hooks/use-image-mentions": { useImageMentions: ({ onChange }: { onChange: (value: string) => void }) => ({ menu: null, inputProps: {}, handleChange: (event: { target: { value: string } }) => onChange(event.target.value), handleSelect() {}, handleKeyDown: () => false }) },
        "@/hooks/use-copy-text": { useCopyText: () => async () => true },
        // External drops have isolated browser coverage; this harness owns no React context.
        "@/hooks/use-image-drop": { useImageDrop: () => ({ dropProps: {}, dragging: false, reading: false }) },
        react: { ...React, useState, useMemo, useCallback: (callback: unknown, dependencies?: DependencyList) => useMemo(() => callback, dependencies),
            useRef: (value: unknown) => { const index = cursor++; return values[index] ||= { current: value }; },
            useEffect: (effect: EffectCallback, dependencies?: DependencyList) => {
                const index = cursor++;
                if (!effects[index] || !equal(effects[index].deps, dependencies)) pending.push(() => { effects[index]?.cleanup?.(); effects[index] = { deps: dependencies, cleanup: effect() }; });
            } },
        antd: { App: { useApp: () => app }, Button: "Button", Tooltip: "Tooltip", Select: "Select", Checkbox: "Checkbox" },
        "lucide-react": new Proxy({}, { get: (_, name) => String(name) }),
        "react-router-dom": { useNavigate: () => () => undefined },
        "@/lib/deployment-features": { deploymentFeatures: { oaLoginEnabled: true, creditsEnabled: false } },
        "@/lib/deferred-persist-queue": { createDeferredPersistQueue: () => ({ schedule() {}, flush() {}, clear() {} }) },
        "./chat-session-storage": { chatSessionStorage: { load: async () => [{ id: "session", title: "new", messages: [], updatedAt: "now", chatModelId: "saved-old-model", imageModelId: savedImageModelId }], save: async () => undefined } },
        "./chat-media": { chatMedia: { hydrateSession: async (value: unknown, assertCurrent: () => void) => { assertCurrent(); return value; } } },
        "@/services/api/creative-chat": { requestCreativeChatPlan: async (config: { model: string; textModel: string }) => { plannedConfigs.push(config); return { kind: "discussion", content: "已收到" }; } },
        "@/stores/use-user-store": { useUserStore: Object.assign((select: Function) => select(userState), { getState: () => userState }) },
        "@/stores/use-config-store": { useConfigStore: (select: Function) => select({ updateConfig() {} }), useEffectiveConfig: () => config },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select?: Function) => select ? select(business) : business },
        "@/stores/use-module-store": { useModuleEnabled: () => true },
        "@/lib/image-model-settings": { useImageModelProfile: (model: string) => imageModelProfile(model, business.models, "designer") },
        "@/stores/canvas/use-canvas-store": { useCanvasStore: { getState: () => ({ hydrated: true, projects: [] }) }, flushCanvasPersistence: async () => undefined },
    };
    const module = { exports: {} as { default: () => ReactElement<any> } };
    new Function("require", "module", "exports", "window", "fetch", code)(
        (name: string) => Object.hasOwn(deps, name) ? deps[name] : requireModule(name), module, module.exports,
        { matchMedia: () => ({ matches: true }), addEventListener() {}, removeEventListener() {} },
        async () => { directModelReads++; throw new Error("Chat must use the shared model snapshot"); },
    );
    const render = () => { cursor = 0; const root = module.exports.default(); for (const effect of pending.splice(0)) effect(); return root; };
    return {
        set: (patch: Partial<State>) => { business = { ...business, ...patch }; },
        async settle() { let root = render(); for (let index = 0; index < 12; index++) { await Promise.resolve(); root = render(); } return elements(root); },
        dispose: () => effects.forEach(effect => effect.cleanup?.()),
        counts: () => ({ refreshes, directModelReads }),
        plannedConfigs,
    };
}

const model = (id: string, capability: string) => ({ id, modelId: id, name: id, capabilities: [capability], creditCost: 0, rmbCost: 0 });
const tool = (toolKey: string, modelConfigId: string) => ({ toolKey, modelConfigId, enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 });
const select = (tree: ReactElement<any>[], label: string) => tree.find(element => element.type === "Select" && element.props["aria-label"] === label)!;
const sendButton = (tree: ReactElement<any>[]) => tree.find(element => element.type === "Button" && element.props.children === "发送")!;
const draftInput = (tree: ReactElement<any>[]) => tree.find(element => element.type === "textarea" && element.props["aria-label"] === "对话内容")!;
const visibleText = (tree: ReactElement<any>[]) => tree.flatMap(element => [element.props.children, element.props.title]).filter(value => typeof value === "string").join(" ");

test("managed Sonnet retains stream/token controls without exposing a model picker or model name", async () => {
    const sonnetId = "d5000000-0000-4000-8000-000000000010";
    const astraId = "d5000000-0000-4000-8000-000000000004";
    const page = chatPageHarness({ models: [
        { ...model(sonnetId, "chat"), parameterModelId: "claude-sonnet-5-5", name: "claude-sonnet-5-5" },
        { ...model(astraId, "chat"), parameterModelId: "gpt-6-astra", name: "gpt-6-astra" },
        model("image", "generate"),
    ], tools: [tool("gpt-chat", sonnetId)], prices: [] });
    try {
        const tree = await page.settle();
        expect(select(tree, "对话模型")).toBeUndefined();
        expect(visibleText(tree)).toContain("对话改图");
        expect(visibleText(tree)).not.toContain("claude-sonnet-5-5");
        const control = tree.find(element => typeof element.type === "function" && element.type.name === "ClaudeChatControls")!;
        expect(control).toBeDefined();
        expect(control.props.model).toBe("claude-sonnet-5-5");
        const controls = elements((control.type as Function)(control.props));
        expect(visibleText(controls)).not.toContain("Claude");
        expect(visibleText(controls)).not.toContain("Sonnet");
        expect(controls.filter(element => element.type === "Checkbox")).toHaveLength(1);
        expect(controls.find(element => element.type === "span" && element.props.children === "思考模式 · 渠道默认")).toBeDefined();
        expect(controls.find(element => element.type === "Select")?.props.value).toBe(defaultConfig.claudeMaxTokens);
        expect(controls.find(element => element.type === "a")?.props.href).toBe("https://docs.apib.ai/cn/api-reference/texts/general/claude-messages");
        page.set({ tools: [tool("gpt-chat", astraId)] });
        expect((await page.settle()).some(element => typeof element.type === "function" && element.type.name === "ClaudeChatControls")).toBe(false);
    } finally { page.dispose(); }
});

test("the mounted chat follows a changed administrative binding despite a stale saved session model", async () => {
    const page = chatPageHarness({ models: [model("old-chat", "chat"), model("old-image", "generate")], tools: [tool("gpt-chat", "old-chat")], prices: [] });
    try {
        const initial = await page.settle();
        expect(select(initial, "对话模型")).toBeUndefined();
        draftInput(initial).props.onChange({ target: { value: "hello" } });
        sendButton(await page.settle()).props.onClick();
        await page.settle();
        expect(page.plannedConfigs.at(-1)).toMatchObject({ model: "old-chat", textModel: "old-chat" });
        page.set({ models: [model("new-chat", "chat"), { ...model("opaque-image", "generate"), imageParameterProfile: "standard-flex-plus", modelIdentityHidden: true }], tools: [tool("gpt-chat", "new-chat"), tool("gpt-chat-image", "opaque-image")] });
        const refreshed = await page.settle();
        expect(select(refreshed, "对话模型")).toBeUndefined();
        expect(visibleText(refreshed)).not.toContain("new-chat");
        draftInput(refreshed).props.onChange({ target: { value: "again" } });
        sendButton(await page.settle()).props.onClick();
        await page.settle();
        expect(page.plannedConfigs.at(-1)).toMatchObject({ model: "new-chat", textModel: "new-chat" });
        const quality = select(refreshed, "图片清晰度");
        expect(quality.props.disabled).toBe(false);
        expect(elements(quality).some(element => element.type === "option" && element.props.value === "xhigh")).toBe(true);
        expect(page.counts()).toEqual({ refreshes: 0, directModelReads: 0 });
    } finally { page.dispose(); }
});

test("chat disables stale models on shared loading/error and retry refreshes the same store", async () => {
    const page = chatPageHarness({ models: [model("chat", "chat"), model("image", "generate")], tools: [tool("gpt-chat", "chat")], prices: [] });
    try {
        draftInput(await page.settle()).props.onChange({ target: { value: "test" } });
        expect(sendButton(await page.settle()).props.disabled).toBe(false);
        for (const status of ["loading", "error"] as const) {
            page.set({ status, error: status === "error" ? "同步失败" : null });
            const tree = await page.settle();
            expect(select(tree, "对话模型")).toBeUndefined();
            expect(sendButton(tree).props.disabled).toBe(true);
            expect(select(tree, "图片清晰度").props.disabled).toBe(true);
            if (status === "error") tree.find(element => element.type === "Button" && element.props.children === "重试加载")!.props.onClick();
        }
        expect(page.counts()).toEqual({ refreshes: 1, directModelReads: 0 });
    } finally { page.dispose(); }
});

test("a missing or broken unified binding disables chat without exposing or using another available model", async () => {
    const page = chatPageHarness({ models: [model("chat", "chat"), model("image", "generate")], tools: [], prices: [] });
    try {
        draftInput(await page.settle()).props.onChange({ target: { value: "test" } });
        for (const tools of [[], [tool("gpt-chat", "removed")], [tool("gpt-chat", "image")]]) {
            page.set({ tools });
            const tree = await page.settle();
            expect(select(tree, "对话模型")).toBeUndefined();
            expect(sendButton(tree).props.disabled).toBe(true);
            expect(visibleText(tree)).toContain("对话服务暂不可用");
            sendButton(tree).props.onClick();
            await page.settle();
        }
        expect(page.plannedConfigs).toEqual([]);
    } finally { page.dispose(); }
});

test("image choices retain usage descriptions while all LLM choices and labels remain hidden", async () => {
    const page = chatPageHarness({ models: [
        { ...model("chat-primary-config", "chat"), modelId: "chat-primary", name: "通用对话", publicDescription: "  日常问答与推理  " },
        { ...model("chat-secondary-config", "chat"), modelId: "chat-secondary", name: "长文对话" },
        { ...model("image-primary-config", "generate"), modelId: "image-primary", name: "快速出图", publicDescription: "  适合草稿探索  " },
        { ...model("image-secondary-config", "generate"), modelId: "image-secondary", name: "精细出图", publicDescription: "   " },
    ], tools: [tool("gpt-chat", "chat-primary-config")], prices: [] });
    try {
        const initial = await page.settle();
        expect(select(initial, "对话模型")).toBeUndefined();
        const image = select(initial, "出图模型");
        expect(visibleText(initial)).not.toContain("通用对话");
        expect(visibleText(initial)).not.toContain("长文对话");
        expect(elements(image).filter(element => element.type === "option").map(element => ({ value: element.props.value, label: element.props.children }))).toEqual([
            { value: "image-primary", label: "快速出图 · 适合草稿探索" },
            { value: "image-secondary", label: "精细出图" },
        ]);
        expect(image.props.value).toBe("image-primary");
        image.props.onChange("image-secondary");
        const changed = await page.settle();
        expect(select(changed, "对话模型")).toBeUndefined();
        expect(select(changed, "出图模型").props.value).toBe("image-secondary");
    } finally { page.dispose(); }
});

test("switching the mounted chat image picker updates GPT, Nano2.1, and official Nano2 controls without changing the text model", async () => {
    const markGpt = { ...model("mark-gpt-uuid", "generate"), name: "aplmart-gpt2.5-flare", imageParameterProfile: "quality-resolution" };
    const markNano = { ...model("mark-nano-uuid", "generate"), name: "aplmart-nano2.1", imageParameterProfile: "resolution-1k" };
    const markNanoOfficial = { ...model("mark-nano-official-uuid", "generate"), name: "aplmart-nano2", imageParameterProfile: "resolution", imageSupportsMask: false, imageSupportsOfficialFallback: false };
    const page = chatPageHarness({ models: [model("chat", "chat"), markGpt, markNano, markNanoOfficial], tools: [tool("gpt-chat", "chat")], prices: [] });
    try {
        const initial = await page.settle();
        expect(select(initial, "出图模型").props.value).toBe("mark-gpt-uuid");
        expect(select(initial, "图片分辨率").props.value).toBe("1k");
        expect(select(initial, "图片质量").props.value).toBe("auto");
        select(initial, "图片分辨率").props.onChange("4k");
        select(initial, "图片质量").props.onChange("max");
        const changed = await page.settle();
        expect(select(changed, "图片分辨率").props.value).toBe("4k");
        expect(select(changed, "图片质量").props.value).toBe("max");
        select(changed, "出图模型").props.onChange("mark-nano-uuid");
        const nano = await page.settle();
        expect(select(nano, "对话模型")).toBeUndefined();
        expect(select(nano, "出图模型").props.value).toBe("mark-nano-uuid");
        expect(select(nano, "图片分辨率")).toBeUndefined();
        expect(select(nano, "图片质量")).toBeUndefined();
        expect(select(nano, "图片清晰度").props.value).toBe("1k");
        expect(elements(select(nano, "图片清晰度")).filter(element => element.type === "option").map(element => element.props.value)).toEqual(["1k", "2k", "4k"]);
        select(nano, "出图模型").props.onChange("mark-nano-official-uuid");
        const nanoOfficial = await page.settle();
        expect(select(nanoOfficial, "对话模型")).toBeUndefined();
        expect(select(nanoOfficial, "出图模型").props.value).toBe("mark-nano-official-uuid");
        expect(select(nanoOfficial, "图片分辨率")).toBeUndefined();
        expect(select(nanoOfficial, "图片质量")).toBeUndefined();
        const quality = select(nanoOfficial, "图片清晰度");
        expect(quality.props.value).toBe("1k");
        expect(elements(quality).filter(element => element.type === "option").map(element => element.props.value)).toEqual(["0.5k", "1k", "2k", "4k"]);
        quality.props.onChange("0.5k");
        const halfK = await page.settle();
        expect(select(halfK, "图片清晰度").props.value).toBe("0.5k");
        expect(select(halfK, "出图模型").props.value).toBe("mark-nano-official-uuid");
    } finally { page.dispose(); }
});

test("the mounted chat excludes promptless fusion while preserving provider-specific image choices and stale-session fallback", async () => {
    const blend = { ...model("opaque-fusion-id", "generate"), name: "多图融合", imageParameterProfile: "blend" as const };
    const open = { ...model("open-gpt2", "generate"), name: "gpt-image-2", parameterModelId: "gpt-image-2" };
    const apimart = { ...model("apimart-gpt2", "generate"), name: "aplmart-gpt2", parameterModelId: "gpt-image-2", imageParameterProfile: "pixel" as const };
    const page = chatPageHarness({ models: [model("chat", "chat"), blend, open, apimart], tools: [tool("gpt-chat", "chat")], prices: [] }, blend.id);
    try {
        const initial = await page.settle();
        const picker = select(initial, "出图模型");
        expect(elements(picker).filter(element => element.type === "option").map(element => element.props.value)).toEqual(["open-gpt2", "apimart-gpt2"]);
        expect(picker.props.value).toBe("apimart-gpt2");
        picker.props.onChange("open-gpt2");
        expect(select(await page.settle(), "出图模型").props.value).toBe("open-gpt2");
        page.set({ tools: [tool("gpt-chat", "chat"), tool("gpt-chat-image", "apimart-gpt2")] });
        const bound = select(await page.settle(), "出图模型");
        expect(bound.props.value).toBe("apimart-gpt2");
        expect(bound.props.disabled).toBe(true);
    } finally { page.dispose(); }
});

test("an administrative promptless image binding cannot fall back to another provider or block discussion", async () => {
    const page = chatPageHarness({ models: [model("chat", "chat"), { ...model("opaque-fusion-id", "generate"), imageParameterProfile: "blend" }, model("other-image", "generate")],
        tools: [tool("gpt-chat", "chat"), tool("gpt-chat-image", "opaque-fusion-id")], prices: [] }, "other-image");
    try {
        const initial = await page.settle();
        const picker = select(initial, "出图模型");
        expect(picker.props.value).toBeUndefined();
        expect(picker.props.disabled).toBe(true);
        expect(picker.props.options).toEqual([]);
        expect(picker.props.placeholder).toBe("暂无可用模型");
        draftInput(initial).props.onChange({ target: { value: "只讨论设计思路" } });
        const ready = await page.settle();
        expect(sendButton(ready).props.disabled).toBe(false);
        sendButton(ready).props.onClick();
        await page.settle();
        expect(page.plannedConfigs.at(-1)).toMatchObject({ model: "chat", textModel: "chat" });
    } finally { page.dispose(); }
});
