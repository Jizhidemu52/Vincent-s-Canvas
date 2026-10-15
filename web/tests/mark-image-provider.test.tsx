import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type DependencyList, type EffectCallback, type ReactElement } from "react";
import ts from "typescript";

import { MARK_IMAGE_BASE_URL, MARK_IMAGE_MODELS, MARK_PLATFORM_MODELS } from "../../shared/mark-image-models";
import { getMarkImageConfiguration, MarkImageConfigurationError, saveMarkImageConfiguration, type MarkImageConfiguration, type MarkImageConfigurationInput } from "@/services/api/mark-image-provider";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const savedConfiguration = (): MarkImageConfiguration => ({
    provider: { id: "mark-provider", name: "APIMart 平台", protocol: "apimart", baseUrl: MARK_IMAGE_BASE_URL, enabled: true, hasCredentials: true },
    models: MARK_PLATFORM_MODELS.map((model, index) => ({ ...model, id: `model-${index}`, enabled: true, creditCost: 0, rmbCost: 0, concurrencyLimit: 2 })),
});

test("Mark API uses only the dedicated authenticated endpoint and omits blank replacement credentials", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ path: String(input), init });
        return Response.json(savedConfiguration());
    }) as typeof fetch;
    await getMarkImageConfiguration();
    const input: MarkImageConfigurationInput = { baseUrl: MARK_IMAGE_BASE_URL, apiKey: "   ", enabled: true, models: savedConfiguration().models };
    await saveMarkImageConfiguration(input);
    await saveMarkImageConfiguration({ ...input, apiKey: " replacement-test-value " });
    expect(calls.every(call => call.path === "/api/admin/model-configuration/mark-images" && call.init?.credentials === "include" && call.init.cache === "no-store")).toBe(true);
    expect(calls[0].init?.method).toBeUndefined();
    expect(calls[1].init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[1].init?.body))).not.toHaveProperty("apiKey");
    expect(JSON.parse(String(calls[1].init?.body)).models.map((model: { modelId: string }) => model.modelId)).toEqual(MARK_PLATFORM_MODELS.map(model => model.modelId));
    expect(JSON.parse(String(calls[2].init?.body)).apiKey).toBe("replacement-test-value");
});

test("API errors do not expose arbitrary upstream response or network text", async () => {
    for (const status of [400, 401, 403, 404, 500]) {
        globalThis.fetch = (async () => Response.json({ message: "private-upstream-token", detail: "private-upstream-token" }, { status })) as typeof fetch;
        try { await getMarkImageConfiguration(); throw new Error("should reject"); }
        catch (error) {
            expect(error).toBeInstanceOf(MarkImageConfigurationError);
            expect((error as Error).message).not.toContain("private-upstream-token");
            if (status === 404) expect((error as Error).message).toContain("非演示服务");
        }
    }
    globalThis.fetch = (async () => { throw new Error("private-upstream-token"); }) as typeof fetch;
    await expect(getMarkImageConfiguration()).rejects.toThrow("请检查网络后重试");
});

const panelUrl = new URL("../src/pages/admin/components/mark-image-provider-panel.tsx", import.meta.url);
const requireModule = createRequire(panelUrl);
const panelCode = ts.transpileModule(readFileSync(panelUrl, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;

function elements(node: unknown): ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement(node)) return [];
    const element = node as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

function harness(options: { role?: string; load?: () => Promise<MarkImageConfiguration>; save?: (input: MarkImageConfigurationInput) => Promise<MarkImageConfiguration>; refresh?: () => Promise<void> } = {}) {
    const state: any[] = [];
    const effects: Array<{ deps?: DependencyList; cleanup?: ReturnType<EffectCallback> }> = [];
    const pending: Array<() => void> = [];
    let cursor = 0;
    let reads = 0;
    let refreshes = 0;
    const writes: MarkImageConfigurationInput[] = [];
    const messages = { success: [] as string[], error: [] as string[], warning: [] as string[] };
    const app = { message: Object.fromEntries(Object.entries(messages).map(([key, values]) => [key, (value: string) => values.push(value)])) };
    const form = {
        values: {} as Record<string, any>,
        setFieldsValue(values: Record<string, any>) { this.values = { ...this.values, ...values }; },
        setFieldValue(key: string, value: any) { this.values[key] = value; },
    };
    const Form = Object.assign(() => null, { useForm: () => [form], Item: "FormItem" });
    const equal = (a?: DependencyList, b?: DependencyList) => Boolean(a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index])));
    const useState = (initial: any) => {
        const index = cursor++;
        if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
        return [state[index], (next: any) => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
    };
    const userState = { user: { id: "operator", role: options.role || "super_admin" } };
    const business = { refresh: async () => { refreshes++; await options.refresh?.(); } };
    const dependencies: Record<string, any> = {
        react: { ...React, useState,
            useRef: (value: unknown) => { const index = cursor++; return state[index] ||= { current: value }; },
            useCallback: (callback: unknown, deps?: DependencyList) => { const index = cursor++; if (!state[index] || !equal(state[index].deps, deps)) state[index] = { deps, callback }; return state[index].callback; },
            useEffect: (effect: EffectCallback, deps?: DependencyList) => {
                const index = cursor++;
                if (!effects[index] || !equal(effects[index].deps, deps)) pending.push(() => { effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: effect() }; });
            },
        },
        antd: { App: { useApp: () => app }, Alert: "Alert", Button: "Button", Form, Input: Object.assign(() => null, { Password: "Password" }), InputNumber: "InputNumber", Space: "Space", Switch: "Switch", Tag: "Tag", Typography: { Title: "Title", Text: "Text" } },
        "lucide-react": new Proxy({}, { get: (_, key) => String(key) }),
        "@/stores/use-user-store": { useUserStore: (select: Function) => select(userState) },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: Function) => select(business) },
        "../../../../../shared/mark-image-models": { MARK_IMAGE_BASE_URL, MARK_IMAGE_MODELS, MARK_PLATFORM_MODELS },
        "@/services/api/mark-image-provider": {
            MarkImageConfigurationError,
            getMarkImageConfiguration: async () => { reads++; return options.load ? options.load() : { provider: null, models: [] }; },
            saveMarkImageConfiguration: async (input: MarkImageConfigurationInput) => { writes.push(input); return options.save ? options.save(input) : savedConfiguration(); },
        },
    };
    const module = { exports: {} as { MarkImageProviderPanel: () => ReactElement<any> } };
    new Function("require", "module", "exports", panelCode)((name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireModule(name), module, module.exports);
    const render = () => { cursor = 0; const result = module.exports.MarkImageProviderPanel(); for (const effect of pending.splice(0)) effect(); return elements(result); };
    return {
        form, Form, messages, writes,
        counts: () => ({ reads, refreshes }),
        render,
        async settle() { let tree = render(); for (let index = 0; index < 6; index++) { await Promise.resolve(); tree = render(); } return tree; },
        dispose: () => effects.forEach(effect => effect.cleanup?.()),
    };
}

test("only super admins read the dedicated configuration", async () => {
    const panel = harness({ role: "department_admin" });
    try {
        const tree = await panel.settle();
        expect(panel.counts().reads).toBe(0);
        expect(tree.some(element => element.type === panel.Form)).toBe(false);
        expect(tree[0].props.title).toBe("仅超级管理员可配置 APIMart 平台");
    } finally { panel.dispose(); }
});

test("first configuration groups every registered image, text, video and blend model with safe defaults and mandatory key", async () => {
    const panel = harness();
    try {
        const tree = await panel.settle();
        expect(panel.form.values.baseUrl).toBe(MARK_IMAGE_BASE_URL);
        expect(MARK_PLATFORM_MODELS).toHaveLength(9);
        expect(panel.form.values.models).toEqual(MARK_PLATFORM_MODELS.map(model => ({ enabled: model.defaultEnabled, creditCost: 0, rmbCost: 0, concurrencyLimit: 2 })));
        expect(MARK_PLATFORM_MODELS.filter(model => !model.defaultEnabled).map(model => model.modelId)).toEqual(["grok-imagine-image-2.0"]);
        expect(MARK_PLATFORM_MODELS.at(-1)?.modelId).toBe("gemini-3.1-flash-image-preview-official");
        expect(tree.filter(element => element.type === "Text" && element.props.strong).map(element => element.props.children).sort()).toEqual(MARK_PLATFORM_MODELS.map(model => model.name).sort());
        expect(tree.filter(element => element.type === "Title" && element.props.id).map(element => element.props.children)).toEqual(["图片模型", "文字模型", "视频模型", "多图融合"]);
        expect(tree.filter(element => element.type === "InputNumber")).toHaveLength(MARK_PLATFORM_MODELS.length * 3);
        expect(tree.filter(element => element.type === "Switch" && element.props["aria-label"])).toHaveLength(MARK_PLATFORM_MODELS.length);
        for (const model of MARK_PLATFORM_MODELS) {
            const usage = tree.find(element => element.type === "Text" && element.props["aria-label"] === `${model.name} 用途`);
            expect(usage?.props.children).toEqual(["用途：", model.description]);
        }
        expect(MARK_PLATFORM_MODELS.find(model => model.modelId === "gpt-image-2")?.description).toContain("日常最通用");
        expect(tree.filter(element => element.type === "Button").map(element => element.props.children)).toEqual(["保存 APIMart 平台配置"]);
        expect(tree.some(element => element.type === "Text" && element.props.children === "Midjourney Blend：上传 2–4 张参考图进行融合，无需提示词。")).toBe(true);
        const imageGroup = tree.find(element => element.props["aria-labelledby"] === "mark-model-group-image")!;
        expect(elements(imageGroup).filter(element => element.type === "Text" && element.props.strong).map(element => element.props.children)).toEqual(MARK_PLATFORM_MODELS.filter(model => String(model.modelId) !== "midjourney-blend" && model.capabilities.some(capability => capability === "generate")).map(model => model.name));
        const key = tree.find(element => element.type === "FormItem" && element.props.name === "apiKey")!;
        await expect(key.props.rules[0].validator({}, "  ")).rejects.toThrow("首次保存请填写 APIMart API Key");
        await expect(key.props.rules[0].validator({}, "test-value")).resolves.toBeUndefined();
    } finally { panel.dispose(); }
});

test("saving writes exact model identities once, clears the key and refreshes business models without binding a tool", async () => {
    let finish!: (value: MarkImageConfiguration) => void;
    const panel = harness({ save: () => new Promise(resolve => { finish = resolve; }) });
    try {
        const tree = await panel.settle();
        const submit = tree.find(element => element.type === panel.Form)!.props.onFinish;
        panel.form.values.apiKey = " test-value ";
        panel.form.values.models[1] = { enabled: false, creditCost: 7, rmbCost: 0.05, concurrencyLimit: 4 };
        panel.form.values.models[3] = { enabled: false, creditCost: 2, rmbCost: 0.0123, concurrencyLimit: 3 };
        panel.form.values.models[4] = { enabled: true, creditCost: 25, rmbCost: 0.6, concurrencyLimit: 1 };
        panel.form.values.models[5] = { enabled: false, creditCost: 13, rmbCost: 0.4, concurrencyLimit: 3 };
        const saving = submit(panel.form.values);
        await submit(panel.form.values);
        expect(panel.writes).toHaveLength(1);
        expect(panel.writes[0].models.map(model => model.modelId)).toEqual(MARK_PLATFORM_MODELS.map(model => model.modelId));
        expect(panel.writes[0].models[1]).toEqual({ modelId: MARK_IMAGE_MODELS[1].modelId, enabled: false, creditCost: 7, rmbCost: 0.05, concurrencyLimit: 4 });
        expect(panel.writes[0].models[3]).toEqual({ modelId: "gpt-6-astra", enabled: false, creditCost: 2, rmbCost: 0.0123, concurrencyLimit: 3 });
        expect(panel.writes[0].models[4]).toEqual({ modelId: "happyhorse-1.1", enabled: true, creditCost: 25, rmbCost: 0.6, concurrencyLimit: 1 });
        expect(panel.writes[0].models[5]).toEqual({ modelId: "midjourney-blend", enabled: false, creditCost: 13, rmbCost: 0.4, concurrencyLimit: 3 });
        expect(panel.writes[0].apiKey).toBe("test-value");
        expect(panel.render().find(element => element.type === panel.Form)!.props.disabled).toBe(true);
        finish(savedConfiguration());
        await saving;
        const savedTree = await panel.settle();
        expect(panel.form.values.apiKey).toBe("");
        expect(panel.counts()).toEqual({ reads: 1, refreshes: 1 });
        const key = savedTree.find(element => element.type === "FormItem" && element.props.name === "apiKey")!;
        await expect(key.props.rules[0].validator({}, "")).resolves.toBeUndefined();
        expect(panel.messages.success).toHaveLength(1);
        expect(panel.messages.error).toEqual([]);
    } finally { panel.dispose(); }
});

test("existing three-model configurations retain saved values and add independent defaults for later models", async () => {
    const existing = savedConfiguration();
    existing.models = existing.models.slice(0, 3);
    existing.models[0] = { ...existing.models[0]!, enabled: false, creditCost: 11, rmbCost: 0.45, concurrencyLimit: 7 };
    const panel = harness({ load: async () => existing });
    try {
        const tree = await panel.settle();
        expect(panel.form.values.models).toHaveLength(MARK_PLATFORM_MODELS.length);
        expect(panel.form.values.models[0]).toEqual({ enabled: false, creditCost: 11, rmbCost: 0.45, concurrencyLimit: 7 });
        expect(panel.form.values.models.slice(3)).toEqual(MARK_PLATFORM_MODELS.slice(3).map(model => ({ enabled: model.defaultEnabled, creditCost: 0, rmbCost: 0, concurrencyLimit: 2 })));
        expect(panel.form.values.apiKey).toBe("");
        await tree.find(element => element.type === panel.Form)!.props.onFinish(panel.form.values);
        expect(panel.writes[0].apiKey).toBeUndefined();
        expect(panel.writes[0].models).toHaveLength(MARK_PLATFORM_MODELS.length);
    } finally { panel.dispose(); }
});

test("adding Blend and image models preserves every setting on the existing five-model configuration", async () => {
    const existing = savedConfiguration();
    existing.models = existing.models.slice(0, 5).map((model, index) => ({ ...model, enabled: index % 2 === 0, creditCost: index + 3, rmbCost: (index + 1) / 10, concurrencyLimit: index + 2 }));
    const previous = existing.models.map(({ modelId, enabled, creditCost, rmbCost, concurrencyLimit }) => ({ modelId, enabled, creditCost, rmbCost, concurrencyLimit }));
    const panel = harness({ load: async () => existing });
    try {
        const tree = await panel.settle();
        await tree.find(element => element.type === panel.Form)!.props.onFinish(panel.form.values);
        expect(panel.writes[0].models.slice(0, 5)).toEqual(previous);
        expect(panel.writes[0].models.slice(5)).toEqual(MARK_PLATFORM_MODELS.slice(5).map(({ modelId, defaultEnabled }) => ({ modelId, enabled: defaultEnabled, creditCost: 0, rmbCost: 0, concurrencyLimit: 2 })));
        expect(panel.writes[0].apiKey).toBeUndefined();
    } finally { panel.dispose(); }
});

for (const grokEnabled of [false, true]) test(`adding Nano2 preserves an existing explicit Grok enabled=${grokEnabled} setting`, async () => {
    const existing = savedConfiguration();
    existing.models = existing.models.slice(0, 8).map(model => ({ ...model, enabled: model.modelId === "grok-imagine-image-2.0" ? grokEnabled : model.enabled }));
    const previous = existing.models.map(({ modelId, enabled, creditCost, rmbCost, concurrencyLimit }) => ({ modelId, enabled, creditCost, rmbCost, concurrencyLimit }));
    const panel = harness({ load: async () => existing });
    try {
        const tree = await panel.settle();
        await tree.find(element => element.type === panel.Form)!.props.onFinish(panel.form.values);
        expect(panel.writes[0].models.slice(0, 8)).toEqual(previous);
        expect(panel.writes[0].models[8]).toEqual({ modelId: "gemini-3.1-flash-image-preview-official", enabled: true, creditCost: 0, rmbCost: 0, concurrencyLimit: 2 });
        expect(panel.writes[0].apiKey).toBeUndefined();
    } finally { panel.dispose(); }
});

test("text billing and concurrency controls are disabled and disclosed while saved values survive unchanged", async () => {
    const existing = savedConfiguration();
    const textIndex = existing.models.findIndex(model => model.modelId === "gpt-6-astra");
    existing.models[textIndex] = { ...existing.models[textIndex]!, creditCost: 9, rmbCost: 0.1234, concurrencyLimit: 7 };
    const panel = harness({ load: async () => existing });
    try {
        const tree = await panel.settle();
        const inputs = tree.filter(element => element.type === "InputNumber");
        const textModelName = existing.models[textIndex]!.name;
        expect(inputs.filter(element => element.props.disabled).map(element => element.props["aria-label"])).toEqual([
            `${textModelName} 站内积分`, `${textModelName} 内部成本`, `${textModelName} 并发上限`,
        ]);
        expect(inputs.filter(element => !element.props.disabled)).toHaveLength((MARK_PLATFORM_MODELS.length - 1) * 3);
        expect(tree.find(element => element.type === "Switch" && element.props["aria-label"] === `启用 ${textModelName}`)?.props.disabled).not.toBe(true);
        expect(tree.some(element => element.type === "Text" && element.props.children === "文字模型当前仅配置接入与开关；站内计费/并发限制尚未执行，供应商仍按实际请求计费。")).toBe(true);
        await tree.find(element => element.type === panel.Form)!.props.onFinish(panel.form.values);
        expect(panel.writes[0].models[textIndex]).toEqual({ modelId: "gpt-6-astra", enabled: true, creditCost: 9, rmbCost: 0.1234, concurrencyLimit: 7 });
    } finally { panel.dispose(); }
});

test("load failures cannot overwrite configuration and retry recovers the form", async () => {
    let attempts = 0;
    const panel = harness({ load: async () => { if (++attempts === 1) throw new MarkImageConfigurationError("配置暂不可用"); return savedConfiguration(); } });
    try {
        const tree = await panel.settle();
        const form = tree.find(element => element.type === panel.Form)!;
        expect(form.props.disabled).toBe(true);
        await form.props.onFinish({ apiKey: "test-value" });
        expect(panel.writes).toHaveLength(0);
        const error = tree.find(element => element.type === "Alert" && element.props.type === "error")!;
        await error.props.action.props.onClick();
        const recovered = await panel.settle();
        expect(recovered.find(element => element.type === panel.Form)!.props.disabled).toBe(false);
        expect(panel.counts().reads).toBe(2);
    } finally { panel.dispose(); }
});

test("a successful save stays successful if model refresh fails, and unexpected errors are not displayed", async () => {
    const panel = harness({ refresh: async () => { throw new Error("private-upstream-token"); } });
    try {
        const tree = await panel.settle();
        panel.form.values.apiKey = "test-value";
        await tree.find(element => element.type === panel.Form)!.props.onFinish(panel.form.values);
        expect(panel.form.values.apiKey).toBe("");
        expect(panel.messages.success).toHaveLength(1);
        expect(panel.messages.error).toEqual([]);
        expect(panel.messages.warning).toEqual(["配置已保存，但模型列表同步失败；请刷新页面后再选择模型。"]);
    } finally { panel.dispose(); }
    const failed = harness({ save: async () => { throw new Error("private-upstream-token"); } });
    try {
        const tree = await failed.settle();
        await tree.find(element => element.type === failed.Form)!.props.onFinish(failed.form.values);
        expect(failed.messages.error).toEqual(["APIMart 平台配置保存失败，请重试。"]);
    } finally { failed.dispose(); }
});
