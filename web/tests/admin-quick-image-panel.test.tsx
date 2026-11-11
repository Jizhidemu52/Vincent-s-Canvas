import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React, { type ReactElement } from "react";
import ts from "typescript";
import type * as Panel from "../src/pages/admin/components/quick-image-configuration-panel";
import { classifyTaskRecovery, submissionInvestigationMessage } from "../src/services/api/task-result-reconciliation";

const source = readFileSync(new URL("../src/pages/admin/components/quick-image-configuration-panel.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const model = { id: "model-1", name: "Model", modelId: "runtime-id", providerName: "API", protocol: "openai", capabilities: ["edit"] };
const configuration = { action: "remove-background" as const, modelConfigId: model.id, modelId: model.modelId, modelName: model.name, prompt: "原提示词", parameters: {}, configurationVersion: 2, isDefault: false };
function harness() {
    const state: any[] = [], effects: Array<() => unknown> = [], storage = new Map<string, string>();
    const writes: Array<{ kind: string; args: any[] }> = [];
    let cursor = 0, allowed = true;
    class RequestError extends Error { definitive = false; }
    const dependencies: Record<string, unknown> = {
        "react/jsx-runtime": require("react/jsx-runtime"),
        react: { ...React, useState: (initial: unknown) => { const index = cursor++; if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial; return [state[index], (value: any) => { state[index] = typeof value === "function" ? value(state[index]) : value; }]; }, useRef: (initial: unknown) => { const index = cursor++; return state[index] ||= { current: initial }; }, useEffect: (callback: () => unknown) => { const index = cursor++; if (!(index in state)) { state[index] = true; effects.push(callback); } } },
        antd: Object.fromEntries(["Alert", "Button", "Form", "Image", "Input", "Select", "Tag"].map(name => [name, Object.assign(() => null, { Item: () => null, TextArea: () => null, PreviewGroup: () => null })])),
        "lucide-react": { RefreshCw: () => null },
        "@/hooks/use-unsaved-guard": { useUnsavedGuard: () => null, useConfirmUnsavedChanges: () => async () => true },
        "@/lib/client-id": { createClientId: () => "request-1" },
        "@/lib/quick-image-tools": { quickImageTitle: () => "一键去背景", quickImageReferenceFileError: () => undefined },
        "@/services/api/admin-quick-image": { AdminQuickImageRequestError: RequestError,
            saveAdminQuickImageConfiguration: async (...args: any[]) => { writes.push({ kind: "save", args }); return { configuration: { ...configuration, ...args[1], configurationVersion: 3 } }; },
            testAdminQuickImageConfiguration: async (...args: any[]) => { writes.push({ kind: "test", args }); throw new RequestError("network unknown"); },
            findAdminQuickImageTest: async (...args: any[]) => { writes.push({ kind: "query", args }); return null; } },
        "@/services/api/admin-prompt-recipes": { requirePromptAdmin: () => { if (!allowed) throw new Error("session changed"); return "admin-1"; } },
        "@/services/api/server-assets": { uploadServerAsset: async (...args: any[]) => { writes.push({ kind: "upload", args }); return "own-asset"; } },
        "@/services/api/task-result-reconciliation": { classifyTaskRecovery, submissionInvestigationMessage },
        "@/stores/use-user-store": { useUserStore: (selector: (s: any) => any) => selector({ user: { id: "admin-1", status: "active", role: allowed ? "super_admin" : "designer" }, status: "authenticated" }) },
    };
    const module = { exports: {} as typeof Panel };
    new Function("require", "module", "exports", "sessionStorage", "URL", code)((name: string) => dependencies[name], module, module.exports, { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) }, { createObjectURL: () => "blob:preview", revokeObjectURL: () => null });
    const render = () => { cursor = 0; const view = module.exports.QuickImageConfigurationEditor({ owner: "admin-1", configuration, models: [model], locked: false }); effects.splice(0).forEach(effect => effect()); return view; };
    return { api: module.exports, render, writes, storage, deny: () => { allowed = false; } };
}
function nodes(node: unknown): ReactElement<any>[] {
    if (!React.isValidElement(node)) return Array.isArray(node) ? node.flatMap(nodes) : [];
    return [node as ReactElement<any>, ...nodes((node as ReactElement<any>).props.children)];
}
const control = (view: ReactElement, label: string) => nodes(view).find(node => node.props["aria-label"] === label)!;
const childrenText = (children: unknown): string => Array.isArray(children) ? children.map(childrenText).join("") : typeof children === "string" ? children : "";
const button = (view: ReactElement, text: string) => nodes(view).find(node => childrenText(node.props.children) === text)!;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("draft validation accepts only available models, bounded prompt and bounded JSON objects", () => {
    const h = harness(), parse = h.api.parseQuickImageDraft;
    expect(parse({ modelConfigId: model.id, prompt: "  主体  ", parametersJson: '{"quality":"high"}' }, [model])).toEqual({ modelConfigId: model.id, prompt: "主体", parameters: { quality: "high" } });
    for (const parametersJson of ["[]", "null", "42", "bad", JSON.stringify({ value: "x".repeat(4000) })]) expect(() => parse({ modelConfigId: model.id, prompt: "test", parametersJson }, [model])).toThrow();
    for (const prompt of ["  ", "x".repeat(4001)]) expect(() => parse({ modelConfigId: model.id, prompt, parametersJson: "{}" }, [model])).toThrow();
    expect(() => parse({ modelConfigId: "missing", prompt: "test", parametersJson: "{}" }, [model])).toThrow("不会自动回退");
});

test("save accepts a direct full-color transparent output prompt without uploading or testing", async () => {
    const h = harness();
    const prompt = "保留毛衫主体颜色与针织细节，直接输出全彩透明 PNG，不含底色或棋盘格。";
    control(h.render(), "一键去背景处理提示词").props.onChange({ target: { value: prompt } });
    button(h.render(), "保存一键去背景配置").props.onClick(); await tick();
    expect(h.writes.map(write => write.kind)).toEqual(["save"]);
    expect(h.writes[0].args[1]).toEqual({ modelConfigId: model.id, prompt, parameters: {}, expectedVersion: 2 });
});

test("unsaved draft testing stores a private-owner receipt before one paid call and never saves", async () => {
    const h = harness();
    control(h.render(), "一键去背景处理提示词").props.onChange({ target: { value: "未保存的提取要求" } });
    control(h.render(), "一键去背景测试原图").props.onChange({ target: { files: [new File(["png"], "own.png", { type: "image/png" })], value: "" } });
    const testButton = button(h.render(), "付费试运行 1 张");
    testButton.props.onClick(); testButton.props.onClick(); await tick();
    expect(h.writes.map(write => write.kind)).toEqual(["upload", "test"]);
    expect(h.writes[1].args[1]).toEqual({ requestId: "request-1", sourceUrl: "/api/assets/own-asset/content", configuration: { modelConfigId: model.id, prompt: "未保存的提取要求", parameters: {} } });
    expect([...h.storage.entries()]).toEqual([["canvas:admin-quick-image-test:admin-1:remove-background", "request-1"]]);
    expect(button(h.render(), "付费试运行 1 张").props.disabled).toBe(true);
    button(h.render(), "查询原测试任务").props.onClick(); await tick();
    expect(h.writes.map(write => write.kind)).toEqual(["upload", "test", "query"]);
    expect(button(h.render(), "付费试运行 1 张").props.disabled).toBe(true);
    expect(h.api.readQuickImageTestReceipt("another-admin", "remove-background")).toBeNull();
    expect(h.api.readQuickImageTestReceipt("admin-1", "remove-background")?.requestId).toBe("request-1");
});

test("session changes prevent draft writes even through an old click handler", async () => {
    const h = harness(), stale = button(h.render(), "保存一键去背景配置");
    h.deny(); stale.props.onClick(); await tick();
    expect(h.writes).toEqual([]);
    const result = h.api.QuickImageConfigurationPanel({ isAdmin: true });
    expect(result.props.title).toContain("仅超级管理员");
});

test("admin-only tab is integrated without a default model constant or cancel endpoint", () => {
    const hub = readFileSync(new URL("../src/pages/admin/components/api-configuration-hub.tsx", import.meta.url), "utf8");
    expect(hub).toContain('key: "quick-images"');
    expect(hub).toContain("<QuickImageConfigurationPanel isAdmin={isAdmin}");
    expect(source).not.toMatch(/quickImageModelId|mai-image-2\.6|gemini-nano-banana|cancelOriginalTask|\/cancel/);
});
