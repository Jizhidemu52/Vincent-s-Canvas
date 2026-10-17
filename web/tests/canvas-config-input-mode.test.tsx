import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { CanvasConfigNodePanel, configImageInputModeChange } from "@/components/canvas/canvas-config-node-panel";
import type { NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { createCanvasTextDraft } from "@/lib/canvas/canvas-text-draft";
import { createImageReferenceItem } from "@/lib/image-reference-policy";
import { runCanvasGeneration, type SharedGenerationExecution } from "@/pages/canvas/canvas-shared-generation-runtime";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { defaultConfig } from "@/stores/use-config-store";
import { useModuleStore } from "@/stores/use-module-store";
import { moduleKeys } from "@/services/api/modules";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

const configNode = (prompt: string): CanvasNodeData => ({ id: "config", type: CanvasNodeType.Config, title: "配置", position: { x: 0, y: 0 }, width: 360, height: 420,
    metadata: { generationMode: "image", model: "gpt-image-2", configImageInputMode: "combined", composerContent: prompt } });
const reference = (id: string, connection = true) => ({ ...createImageReferenceItem({ id, name: `${id}.png`, type: "image/png", dataUrl: `blob:${id}`, storageKey: `image:${id}` }, connection ? "connection" : "upload"), referenceKey: `${connection ? "node" : "upload"}:${id}` });
const references = [reference("a"), reference("b"), reference("common", false)];
const inputs: NodeGenerationInput[] = references.slice(0, 2).map(image => ({ nodeId: image.id, type: "image", title: image.name, image }));
const model = { id: "gpt", modelId: "gpt-image-2", name: "GPT", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 };

test("switching to per-image normalizes one connected image and retains common/text references", () => {
    const node = configNode("将 @[node:a] 按 @[node:common] 改色；保留 @[node:node:a] 结构及 @[node:text] 要求");
    const before = structuredClone({ node, references, inputs });
    const result = configImageInputModeChange(node, references, inputs, "per-image", node.metadata!.composerContent!);
    expect(result.patch).toEqual({ configImageInputMode: "per-image", composerContent: "将 图片1 按 @[node:common] 改色；保留 图片1 结构及 @[node:text] 要求" });
    expect(result.feedback).toMatchObject({ error: false });
    expect(result.feedback!.text).toContain("每个任务的当前主图");
    expect({ node, references, inputs }).toEqual(before);
});

test("different connected image roles cannot silently collapse into the same primary", () => {
    const node = configNode("以 @[node:a] 为主体，采用 @[node:b] 的图案");
    const result = configImageInputModeChange(node, references, inputs, "per-image", node.metadata!.composerContent!);
    expect(result.patch).toBeUndefined();
    expect(result.feedback).toMatchObject({ error: true });
    expect(result.feedback!.text).toContain("多张不同");
    expect(result.feedback!.text).toContain("公共参考");
    expect(node.metadata!.configImageInputMode).toBe("combined");
    expect(node.metadata!.composerContent).toBe("以 @[node:a] 为主体，采用 @[node:b] 的图案");
});

test("a removed connected image is never silently restored or normalized", () => {
    const node = configNode("修改 @[node:a]");
    node.metadata!.excludedConnectedImageReferenceKeys = ["node:a"];
    const result = configImageInputModeChange(node, references.slice(1), inputs, "per-image", node.metadata!.composerContent!);
    expect(result.patch).toBeUndefined();
    expect(result.feedback!.text).toContain("已移除");
    expect(node.metadata!.excludedConnectedImageReferenceKeys).toEqual(["node:a"]);
});

test("explicit common manual aliases remain fixed references, including a copy of a task input", () => {
    const node = configNode("按 @[node:a] 和 @[node:upload:common] 修改图片1");
    node.metadata!.manualImageReferences = [{ id: "common", referenceKey: "upload:common", sourceNodeId: "a", name: "shared.png", type: "image/png", content: "blob:common", origin: "canvas" }];
    expect(configImageInputModeChange(node, references, inputs, "per-image", node.metadata!.composerContent!).patch).toEqual({ configImageInputMode: "per-image" });
});

test("plain text, unknown tokens and switching back to combined are not rewritten", () => {
    const prompt = "图片1保留结构，@[node:missing] 需要另行核对";
    const node = configNode(prompt);
    expect(configImageInputModeChange(node, references, inputs, "per-image", prompt).patch).toEqual({ configImageInputMode: "per-image" });
    expect(configImageInputModeChange(node, references, inputs, "combined", "最新草稿 @[node:b]").patch).toEqual({ configImageInputMode: "combined", composerContent: "最新草稿 @[node:b]" });
});

function callback(path: string, name: string) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let expression: ts.Expression | undefined;
    function visit(value: ts.Node) {
        if (ts.isVariableDeclaration(value) && value.name.getText(ast) === name) expression = value.initializer;
        if (ts.isCallExpression(value) && value.expression.getText(ast) === name && value.arguments[1]) expression = value.arguments[1];
        ts.forEachChild(value, visit);
    }
    visit(ast);
    if (!expression) throw new Error(`Missing actual callback ${name}`);
    const code = ts.transpileModule(`return (${expression.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    return (env: Record<string, unknown>) => new Function("env", `const {${Object.keys(env).join(",")}} = env; ${code}`)(env);
}
const modeHandler = callback("../src/components/canvas/canvas-config-node-panel.tsx", "changeInputMode");
const composerHandle = callback("../src/components/canvas/canvas-config-composer.tsx", "useImperativeHandle");

test.each([false, true])("actual mode handler reads pending composer draft and preserves it on ambiguity=%s", ambiguous => {
    const node = configNode("旧草稿");
    const latest = ambiguous ? "以 @[node:a] 为主体、@[node:b] 为花型" : "最新草稿：将 @[node:a] 改为红色";
    const patches: Partial<CanvasNodeMetadata>[] = [], replacements: string[] = [], feedback: unknown[] = [];
    const change = modeHandler({ node, references, inputs, configImageInputModeChange, composerRef: { current: { read: () => latest, replace: (next: string) => replacements.push(next) } },
        onConfigChange: (_id: string, patch: Partial<CanvasNodeMetadata>) => patches.push(patch), setInputModeFeedback: (value: unknown) => feedback.push(value) });
    change("per-image");
    expect(feedback).toHaveLength(1);
    if (ambiguous) {
        expect(patches).toEqual([]);
        expect(replacements).toEqual([]);
    } else {
        expect(patches).toEqual([{ configImageInputMode: "per-image", composerContent: "最新草稿：将 图片1 改为红色" }]);
        expect(replacements).toEqual(["最新草稿：将 图片1 改为红色"]);
    }
});

test("actual composer handle reads current editor contents and cancels the pre-switch debounce", () => {
    const timers = new Set<() => void>(), committed: string[] = [], draftValues: string[] = [];
    const draft = createCanvasTextDraft("old", next => committed.push(next), { set: action => { timers.add(action); return action; }, clear: timer => { timers.delete(timer as () => void); } });
    draft.change("pending @[node:a]");
    const handle = composerHandle({ editorRef: { current: {} }, draftValue: "old", serializeEditor: () => "pending @[node:a]", draftRef: { current: draft }, setDraftValue: (next: string) => draftValues.push(next) })();
    expect(handle.read()).toBe("pending @[node:a]");
    handle.replace("pending 图片1");
    for (const action of timers) action();
    draft.flush();
    expect(timers.size).toBe(0);
    expect(committed).toEqual([]);
    expect(draftValues).toEqual(["pending 图片1"]);
});

test("converted prompt executes both isolated single-image tasks and preserves a common manual reference", async () => {
    const saved = useBusinessConfigStore.getState();
    useBusinessConfigStore.setState({ models: [model], tools: [], status: "ready" });
    try {
        const config = configNode("将 @[node:a] 改为 @[node:common] 的配色");
        config.metadata!.manualImageReferences = [{ id: "common", referenceKey: "upload:common", name: "common.png", type: "image/png", content: "blob:common", origin: "upload" }];
        config.metadata = { ...config.metadata, ...configImageInputModeChange(config, references, inputs, "per-image", config.metadata!.composerContent!).patch };
        let nodes = [config, ...["a", "b"].map(id => ({ ...configNode(""), id, type: CanvasNodeType.Image, metadata: { content: `blob:${id}`, mimeType: "image/png" } }))];
        const connections = ["a", "b"].map(id => ({ id, fromNodeId: id, toNodeId: "config" }));
        const calls: SharedGenerationExecution[] = [], phases: string[] = [], errors: string[] = [];
        await runCanvasGeneration("config", "image", "unused", undefined, {
            snapshot: { nodes, connections }, getSnapshot: () => ({ nodes, connections }), buildConfig: () => ({ ...defaultConfig, model: "gpt-image-2" }), isAiConfigReady: () => true,
            execute: async (id, mode, _prompt, onResult, shared) => { phases.push(`start:${id}`); calls.push(shared!); await Promise.resolve(); onResult?.({ mode, outputs: [{ nodeId: id, status: "success" }] }); phases.push(`finish:${id}`); },
            recover: async () => { throw new Error("No pending tasks expected"); }, start: () => new AbortController(), finish: () => {}, setRunning: () => {},
            setNodes: update => { nodes = typeof update === "function" ? update(nodes) : update; }, message: { info: () => {}, error: value => errors.push(value) },
        });
        expect(errors).toEqual([]);
        expect(phases).toEqual(["start:a", "finish:a", "start:b", "finish:b"]);
        expect(calls.map(call => call.plan.context.referenceImages.map(image => image.id))).toEqual([["a", "common"], ["b", "common"]]);
        expect(calls.map(call => call.plan.prompt)).toEqual(["将 图片1 改为 图片2 的配色", "将 图片1 改为 图片2 的配色"]);
        expect(calls.every(call => call.config.count === "1" && call.toolKey === "canvas-edit")).toBe(true);
    } finally { useBusinessConfigStore.setState(saved); }
});

test.each([undefined, "per-image"] as const)("adding a second input to an existing %s config gives an actionable warning and blocks the invalid run", inputMode => {
    const business = useBusinessConfigStore.getInitialState(), savedBusiness = { ...business };
    const modules = useModuleStore.getInitialState(), savedModules = { ...modules };
    Object.assign(business, { models: [model], tools: [], status: "ready" });
    Object.assign(modules, { status: "ready", flags: Object.fromEntries(moduleKeys.map(key => [key, true])) });
    try {
        const node = configNode("修改 @[node:a]"); node.metadata!.configImageInputMode = inputMode;
        const markup = (count: number) => renderToStaticMarkup(<CanvasConfigNodePanel node={node} isRunning={false} inputs={inputs.slice(0, count)} imageReferences={references.slice(0, count)} inputImageTaskCount={count}
            inputSummary={{ textCount: 0, imageCount: count, videoCount: 0, audioCount: 0 }} onConfigChange={() => {}} onGenerate={() => {}} onStop={() => {}} />);
        expect(markup(1)).not.toContain("逐图提示词仍固定引用");
        const html = markup(2);
        expect(html).toContain("逐图提示词仍固定引用");
        expect(html).toContain("切回合并参考");
        const action = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find(button => button.includes("执行 2 个任务"));
        expect(action).toContain('disabled=""');
        expect(node.metadata!.composerContent).toBe("修改 @[node:a]");
    } finally { Object.assign(business, savedBusiness); Object.assign(modules, savedModules); }
});
