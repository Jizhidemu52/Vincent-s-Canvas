import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { storeCanvasEditorReferences } from "@/lib/canvas/canvas-generation-editor";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import type { PromptInputData } from "../../shared/prompt-contracts";
import { i18nHarness } from "./helpers/i18n-harness";

type Hook = typeof import("@/pages/canvas/use-canvas-quick-generation").useCanvasQuickGeneration;
const url = new URL("../src/pages/canvas/use-canvas-quick-generation.ts", import.meta.url);
const requireModule = createRequire(url);
const code = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
const noop = () => undefined;
const prompt = "提取 Image 1 背心，条纹使用 Image 2 的配色。";
const reference = (id: string): ReferenceImage => ({ id, name: id, type: "image/png", dataUrl: `blob:${id}`, url: `blob:${id}`, storageKey: `image:${id}` });
const input = (id = "11111111-1111-4111-8111-111111111111"): PromptInputData => ({
    scene: "free-optimize", userText: "提取背心并替换配色", fields: {}, mode: "edit", referenceRoles: ["背心", "配色"], compilationId: id,
});
const image = (id: string): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, width: 320, height: 320, position: { x: 0, y: 0 }, metadata: {
    content: `blob:${id}`, model: "gpt-image-2", draftPrompt: prompt, draftImageReferences: storeCanvasEditorReferences([reference("shape"), reference("color")]),
} });

// Run the real hook with persistent hook slots and inert external boundaries.
// Deferred createOptions exercises the actual asynchronous submission window.
function harness(prepare: () => Promise<void> = async () => undefined) {
    const nodes = { current: [image("a"), image("b")] };
    const slots: any[] = [], feedback: string[] = [];
    const submissions: Array<{ config: AiConfig; prompt: string; references: ReferenceImage[]; promptInput?: PromptInputData }> = [];
    let cursor = 0, serial = 0, projectId = "project-a", boundModel: string | undefined;
    let account = { status: "authenticated", user: { id: "employee-a", status: "active", creditBalance: 100 } };
    let effects: Array<() => void> = [];
    const effect = (callback: () => void, dependencies?: unknown[]) => {
        const index = cursor++, previous = slots[index];
        if (!dependencies || !previous || dependencies.some((value, i) => value !== previous[i])) effects.push(callback);
        slots[index] = dependencies;
    };
    const react = {
        useState(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (next: any) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }]; },
        useRef(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
        useCallback(callback: Function, dependencies: unknown[]) { const index = cursor++, previous = slots[index]; if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) slots[index] = { callback, dependencies }; return slots[index].callback; },
        useMemo: (callback: () => unknown) => callback(), useEffect: effect, useLayoutEffect: effect,
    };
    const config = { ...defaultConfig, model: "gpt-image-2", imageModel: "gpt-image-2", size: "1:1", quality: "low", systemPrompt: "" };
    const setNodes = (update: (current: CanvasNodeData[]) => CanvasNodeData[]) => { nodes.current = update(nodes.current); };
    const useUserStore = Object.assign((select: (state: typeof account) => unknown) => select(account), { getState: () => account });
    const dependencies: Record<string, unknown> = {
        react, antd: { App: { useApp: () => ({ message: { error: (value: string) => feedback.push(value), warning: (value: string) => feedback.push(value), success: noop }, modal: {} }) } },
        nanoid: { nanoid: () => `id-${++serial}` }, "react-router-dom": { useSearchParams: () => [new URLSearchParams()] },
        "@/lib/i18n": i18nHarness,
        "@/lib/deployment-features": { deploymentFeatures: { creditsEnabled: false } },
        "@/stores/use-user-store": { useUserStore },
        "@/stores/use-config-store": { ...requireModule("@/stores/use-config-store"), useEffectiveConfig: () => config },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: Function) => select({ estimate: () => ({ credits: 0, rmbCost: 0 }) }) },
        "@/stores/use-asset-store": { useAssetStore: (select: Function) => select({ addAsset: noop }) },
        "@/stores/canvas/use-canvas-panel-store": { useCanvasPanelStore: (select: Function) => select({ creationOpen: true, setCreationOpen: noop }) },
        "@/stores/canvas/canvas-graph-store": { useCanvasGraphSetter: (field: string) => field === "nodes" ? setNodes : noop },
        "@/hooks/use-tool-config": { ...requireModule("@/hooks/use-tool-config"), currentToolConfig: (current: AiConfig) => ({ ...current, model: boundModel || current.model }) },
    };
    const runtime = {
        async createOptions() {
            await prepare();
            return { async generate(config: AiConfig, prompt: string, references: ReferenceImage[], _mask: unknown, _edit: boolean, promptInput?: PromptInputData) {
                submissions.push(structuredClone({ config, prompt, references, promptInput }));
                return { metadata: { status: "success", content: "blob:result" }, uploaded: { url: "blob:result", storageKey: "image:result", width: 320, height: 320, bytes: 10, mimeType: "image/png" } };
            } };
        },
        startGenerationRequest: noop, finishGenerationRequest: noop, setRunningNodeId: noop,
    };
    const module = { exports: {} as { useCanvasQuickGeneration: Hook } };
    new Function("require", "module", "exports", code)((name: string) => dependencies[name] || requireModule(name), module, module.exports);
    return {
        nodes, submissions, feedback,
        bindModel: (model: string) => { boundModel = model; },
        switchAccount: () => { account = { ...account, user: { ...account.user, id: "employee-b" } }; },
        switchProject: () => { projectId = "project-b"; },
        render() {
            cursor = 0; effects = [];
            const result = module.exports.useCanvasQuickGeneration({ projectId, projectLoaded: true, nodesRef: nodes, connectionsRef: { current: [] },
                runtime: runtime as unknown as Parameters<Hook>[0]["runtime"], batchEdit: { setBatchEditOpen: noop, setBatchEditPrompt: noop, setBatchImageSettings: noop },
                setDialogNodeId: noop, getCanvasCenter: () => ({ x: 0, y: 0 }), handleMissingModelConfig: noop, isAiConfigReady: () => true });
            effects.forEach(run => run());
            return result;
        },
    };
}

function optimizedCreation(h: ReturnType<typeof harness>, compilation = input()) {
    const initial = h.render();
    initial.setQuickGeneratePrompt(prompt);
    initial.setQuickGenerateReferences([reference("shape"), reference("color")]);
    initial.setQuickGenerateCount(1);
    const form = h.render();
    form.onQuickOptimizedPrompt(prompt, compilation, form.quickGenerateReferences);
    return form;
}

test("quick optimization is reused only with its model, while changing model preserves text and references", async () => {
    for (const change of ["same", "model", "parameters", "binding"] as const) {
        const h = harness(), form = optimizedCreation(h);
        if (change === "model") form.setQuickGenerateModel("gemini-3.1-flash-image-preview");
        if (change === "parameters") { form.setQuickGenerateSize("1536x1024"); form.setQuickGenerateQuality("high"); }
        if (change === "binding") h.bindModel("gemini-3.1-flash-image-preview");
        const ready = h.render();
        await ready.runQuickCanvasGeneration();
        expect(h.feedback).toEqual([]);
        expect(h.submissions).toHaveLength(1);
        expect(h.submissions[0]!.prompt).toBe(prompt);
        expect(h.submissions[0]!.references).toEqual(form.quickGenerateReferences);
        expect(h.submissions[0]!.promptInput).toEqual(change === "model" || change === "binding" ? undefined : input());
        expect(ready.quickGeneratePromptRef.current).toBe(prompt);
    }
});

test("selection changes cannot reuse another image's compilation even with identical visible input", async () => {
    for (const returnToA of [false, true]) {
        const h = harness();
        h.render().loadQuickGenerationNode(h.nodes.current[0]!);
        const a = h.render();
        a.onQuickOptimizedPrompt(prompt, input(), a.quickGenerateReferences);
        a.loadQuickGenerationNode(h.nodes.current[1]!);
        if (returnToA) h.render().loadQuickGenerationNode(h.nodes.current[0]!);
        const ready = h.render();
        await ready.runQuickCanvasGeneration();
        expect(h.submissions).toHaveLength(1);
        expect(h.submissions[0]!.promptInput).toBeUndefined();
        expect(h.submissions[0]!.prompt).toBe(prompt);
    }
});

test("late optimization callbacks from a previous selection cannot overwrite the current compilation", async () => {
    const h = harness();
    h.render().loadQuickGenerationNode(h.nodes.current[0]!);
    const a = h.render();
    a.loadQuickGenerationNode(h.nodes.current[1]!);
    const b = h.render(), currentInput = input("22222222-2222-4222-8222-222222222222");
    b.onQuickOptimizedPrompt(prompt, currentInput, b.quickGenerateReferences);
    a.onQuickOptimizedPrompt(prompt, input(), a.quickGenerateReferences);
    await b.runQuickCanvasGeneration();
    expect(h.submissions).toHaveLength(1);
    expect(h.submissions[0]!.promptInput).toEqual(currentInput);
});

test("account and project boundaries reject stale callbacks and do not reuse old optimization", async () => {
    for (const boundary of ["account", "project"] as const) {
        const h = harness(), old = optimizedCreation(h);
        if (boundary === "account") h.switchAccount(); else h.switchProject();
        const next = h.render();
        old.onQuickOptimizedPrompt(prompt, input(), old.quickGenerateReferences);
        await old.runQuickCanvasGeneration();
        expect(h.submissions).toEqual([]);
        await next.runQuickCanvasGeneration();
        expect(h.submissions).toHaveLength(1);
        expect(h.submissions[0]!.promptInput).toBeUndefined();
    }
});

test("changed reference order, URL, or server asset identity invalidates optimization without changing text", async () => {
    for (const change of ["order", "url", "asset"] as const) {
        const h = harness(), form = optimizedCreation(h);
        const references = structuredClone(form.quickGenerateReferences);
        if (change === "order") references.reverse();
        if (change === "url") references[0]!.url = "blob:changed-source";
        if (change === "asset") references[0]!.sourceAssetId = "new-server-asset";
        form.setQuickGenerateReferences(references);
        await h.render().runQuickCanvasGeneration();
        expect(h.submissions).toHaveLength(1);
        expect(h.submissions[0]!).toMatchObject({ prompt, references, promptInput: undefined });
    }
});

test("a pending generation uses its frozen optimization snapshot despite later input mutation or optimization", async () => {
    const gate = Promise.withResolvers<void>(), originalInput = input();
    const h = harness(() => gate.promise), form = optimizedCreation(h, originalInput);
    originalInput.compilationId = "33333333-3333-4333-8333-333333333333";
    const ready = h.render(), expectedReferences = structuredClone(ready.quickGenerateReferences);
    const running = ready.runQuickCanvasGeneration();
    expect(h.submissions).toEqual([]);
    ready.quickGenerateReferences[0]!.dataUrl = "blob:mutated-later";
    ready.onQuickOptimizedPrompt(prompt, input("22222222-2222-4222-8222-222222222222"), ready.quickGenerateReferences);
    gate.resolve(); await running;
    expect(h.submissions).toHaveLength(1);
    expect(h.submissions.every(submission => submission.promptInput?.compilationId === input().compilationId)).toBe(true);
    expect(h.submissions.every(submission => JSON.stringify(submission.references) === JSON.stringify(expectedReferences))).toBe(true);
    const records = h.nodes.current.filter(node => node.id.startsWith("quick-image-")).map(node => node.metadata!.generationRecord!);
    expect(records.every(record => record.promptInput?.compilationId === input().compilationId)).toBe(true);
    expect(records.every(record => record.references[0]!.content === expectedReferences[0]!.dataUrl)).toBe(true);
});

test("a generation started after a model switch cannot acquire a later optimization during preparation", async () => {
    const gate = Promise.withResolvers<void>(), h = harness(() => gate.promise), form = optimizedCreation(h);
    form.setQuickGenerateModel("gemini-3.1-flash-image-preview");
    const ready = h.render(), running = ready.runQuickCanvasGeneration();
    ready.onQuickOptimizedPrompt(prompt, input("22222222-2222-4222-8222-222222222222"), ready.quickGenerateReferences);
    gate.resolve(); await running;
    expect(h.submissions).toHaveLength(1);
    expect(h.submissions[0]!.promptInput).toBeUndefined();
    expect(h.nodes.current.find(node => node.id.startsWith("quick-image-"))!.metadata!.generationRecord!.promptInput).toBeUndefined();
});
