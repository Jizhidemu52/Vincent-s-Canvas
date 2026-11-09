import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { canvasGenerationEditorState, storeCanvasEditorReferences } from "@/lib/canvas/canvas-generation-editor";
import { canvasNodePromptDraftPatch } from "@/lib/canvas/canvas-node-prompt-draft";
import { createCanvasNodePromptDraft } from "@/components/canvas/canvas-node-prompt-panel-state";
import { syncCanvasSelectionReferences } from "@/lib/canvas/canvas-selection-references";
import { applyNodeConfigPatch } from "@/pages/canvas/canvas-project-utils";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";

type Form = ReturnType<typeof import("@/pages/canvas/use-canvas-quick-generation").useCanvasQuickGeneration>;
type BatchForm = ReturnType<typeof import("@/pages/canvas/use-canvas-batch-edit").useCanvasBatchEdit>;
const noop = () => undefined;
const transpile = (source: string) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
const hookCode = transpile(readFileSync(new URL("../src/pages/canvas/use-canvas-quick-generation.ts", import.meta.url), "utf8"));
const batchCode = transpile(readFileSync(new URL("../src/pages/canvas/use-canvas-batch-edit.ts", import.meta.url), "utf8"));
const templateCode = transpile(readFileSync(new URL("../src/pages/canvas/canvas-quick-template-reuse.ts", import.meta.url), "utf8"));
const page = ts.createSourceFile("project.tsx", readFileSync(new URL("../src/pages/canvas/project.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map<string, string>();
let selectionCode = "";
function collect(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ["handleNodePromptChange", "handleConfigNodeChange", "beginHistoryEditing"].includes(node.name.text)) callbacks.set(node.name.text, transpile(`return ${node.initializer!.getText(page)};`));
    if (ts.isCallExpression(node) && node.expression.getText(page) === "useEffect" && node.arguments[0]?.getText(page).includes("lastEditorSelectionRef.current === editorSelectionKey")) selectionCode = transpile(`return (${node.arguments[0].getText(page)})();`);
    ts.forEachChild(node, collect);
}
collect(page);
function execute(code: string, scope: Record<string, unknown>) { return new Function("scope", `const { ${Object.keys(scope).join(", ")} } = scope;\n${code}`)(scope); }
const image = (id: string): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { draftPrompt: `original ${id}`, draftModel: "gpt-image-2", size: "1024x1024", quality: "auto", count: 1 } });
const userReference: ReferenceImage = { id: "user-ref", name: "user.png", type: "image/png", dataUrl: "blob:user-image", storageKey: "user-image" };
const template = { template: { prompt: "template prompt", targetTool: "canvas", parameters: {}, referenceAssetIds: ["template-asset"] }, pricing: { selectedModel: { modelId: "template-model" }, modelChanged: false }, warnings: [], mode: "fill" };
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

// Execute the real hook, selection effect and node-panel commit callbacks. Only
// React scheduling, remote assets and unrelated UI/provider boundaries are inert.
function harness(reuse?: { hydrate?: Promise<typeof template>; upload?: Promise<{ mimeType: string; url: string; storageKey: string }> }) {
    const nodes = { current: [image("a"), image("b")] };
    const connections = { current: [] };
    const slots: any[] = [];
    const lastEditorSelectionRef = { current: "" };
    const notices: string[] = [], confirmations: Array<{ onOk: () => unknown }> = [];
    const searchParams = new URLSearchParams(reuse ? "reuseToken=template-token" : "");
    const message = { info: (value: string) => notices.push(value), success: (value: string) => notices.push(value), warning: (value: string) => notices.push(value), error: (value: string) => notices.push(value) };
    const modal = { confirm: (value: { onOk: () => unknown }) => confirmations.push(value) };
    let cursor = 0, dirty = false, active = true, projectId = "project-a", nextId = 0;
    let account = { status: "authenticated", user: { id: "employee-a", status: "active" } };
    let selectedNodeIds = new Set<string>();
    let effects: Array<() => void> = [], layouts: Array<() => void> = [];
    let form: Form;
    let batch: BatchForm;
    const effect = (queue: Array<() => void>, callback: () => (() => void) | void, dependencies?: unknown[]) => {
        const index = cursor++, previous = slots[index];
        if (!previous || !dependencies || dependencies.some((value, i) => value !== previous.dependencies?.[i])) {
            slots[index] = { dependencies, cleanup: previous?.cleanup };
            queue.push(() => { slots[index].cleanup?.(); slots[index].cleanup = callback(); });
        }
    };
    const react = {
        useState(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (update: any) => { const next = typeof update === "function" ? update(slots[index]) : update; if (!Object.is(next, slots[index])) dirty = true; slots[index] = next; }]; },
        useRef(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
        useCallback(callback: Function, dependencies: unknown[]) { const index = cursor++, previous = slots[index]; if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) slots[index] = { callback, dependencies }; return slots[index].callback; },
        useMemo(callback: () => unknown, dependencies: unknown[]) { const index = cursor++, previous = slots[index]; if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) slots[index] = { value: callback(), dependencies }; return slots[index].value; },
        useEffect: (callback: () => void, dependencies?: unknown[]) => effect(effects, callback, dependencies),
        useLayoutEffect: (callback: () => void, dependencies?: unknown[]) => effect(layouts, callback, dependencies),
    };
    const setNodes = (update: CanvasNodeData[] | ((current: CanvasNodeData[]) => CanvasNodeData[])) => { const next = typeof update === "function" ? update(nodes.current) : update; if (next !== nodes.current) dirty = true; nodes.current = next; };
    const useUserStore = Object.assign((select: (state: typeof account) => unknown) => select(account), { getState: () => account });
    const runtime = { isObservationCurrent: () => active, waitForWriteAccess: async () => active };
    const dependencies: Record<string, unknown> = {
        react, antd: { App: { useApp: () => ({ message, modal }) } }, "react-router-dom": { useSearchParams: () => [searchParams] },
        "@/lib/i18n": { uiText: (text: string) => text }, nanoid: { nanoid: () => `template-reference-${++nextId}` },
        "@/stores/use-user-store": { useUserStore }, "@/stores/use-config-store": { defaultConfig, useEffectiveConfig: () => defaultConfig },
        "@/hooks/use-tool-config": { useToolConfig: (config: unknown) => config },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: Function) => select({ estimate: () => ({ credits: 0, rmbCost: 0 }) }) },
        "@/stores/use-asset-store": { useAssetStore: (select: Function) => select({ addAsset: noop, addAssets: noop }) },
        "@/stores/canvas/use-canvas-panel-store": { useCanvasPanelStore: (select: Function) => select({ creationOpen: true, setCreationOpen: noop }) },
        "@/stores/canvas/canvas-graph-store": { useCanvasGraphSetter: (field: string) => field === "nodes" ? setNodes : noop },
        "@/lib/canvas/canvas-image-usage": { canvasImageUsageInput: () => ({}) },
        "@/lib/canvas/canvas-generation-editor": { canvasGenerationEditorState, storeCanvasEditorReferences },
        "@/services/api/prompts": { hydratePromptReuse: () => reuse?.hydrate || Promise.resolve(template) },
        "@/services/api/server-assets": { fetchServerAssetContent: async () => new Blob(["fixture"]) },
        "@/services/image-storage": { uploadImage: () => reuse?.upload || Promise.resolve({ mimeType: "image/png", url: "blob:template-image", storageKey: "template-image" }) },
        "@/lib/prompt-editor-parameters": { promptImageSettings: () => ({ size: "1:1", quality: "auto", count: "1", imageOptions: "" }) },
        "@/lib/deployment-features": { deploymentFeatures: { creditsEnabled: false } },
    };
    const module = { exports: {} as { useCanvasQuickGeneration: (options: unknown) => Form } };
    const batchModule = { exports: {} as { useCanvasBatchEdit: (options: unknown) => BatchForm } };
    new Function("require", "module", "exports", batchCode)((name: string) => dependencies[name] || {}, batchModule, batchModule.exports);
    const templateModule = { exports: {} };
    new Function("require", "module", "exports", templateCode)((name: string) => dependencies[name] || {}, templateModule, templateModule.exports);
    dependencies["./canvas-quick-template-reuse"] = templateModule.exports;
    new Function("require", "module", "exports", hookCode)((name: string) => dependencies[name] || {}, module, module.exports);
    const nodeScope = { useCallback: (callback: unknown) => callback, setNodes, nodesRef: nodes, canvasNodePromptDraftPatch, applyNodeConfigPatch,
        syncQuickGenerationNode: (node: CanvasNodeData) => form.syncQuickGenerationNode(node) };
    const nodePromptChange = execute(callbacks.get("handleNodePromptChange")!, nodeScope) as (id: string, prompt: string) => void;
    const nodeConfigChange = execute(callbacks.get("handleConfigNodeChange")!, nodeScope) as (id: string, patch: CanvasNodeData["metadata"]) => void;
    return {
        nodes, notices, confirmations, nodePromptChange, nodeConfigChange,
        batch() { return batch; },
        select(ids: string[]) { selectedNodeIds = new Set(ids); return this.render(); },
        switchAccount() { account = { ...account, user: { ...account.user, id: "employee-b" } }; },
        switchProject() { projectId = "project-b"; },
        restartEffects() { slots.forEach((slot, index) => { if (slot && Object.hasOwn(slot, "cleanup")) { slot.cleanup?.(); slots[index] = undefined; } }); return this.render(); },
        focusEditor(panelFlush = noop) {
            class InputElement { matches() { return true; } closest() { return null; } }
            const focus = execute(callbacks.get("beginHistoryEditing")!, { Element: InputElement, useCallback: (callback: unknown) => callback,
                editTransactionRef: { current: true }, historyCommitTimerRef: { current: null }, flushPendingHistory: noop,
                flushEditorDrafts: () => { form.flushQuickNodeDraft(); panelFlush(); } });
            focus(new InputElement());
        },
        unmount() { active = false; slots.forEach(slot => slot?.cleanup?.()); },
        render() {
            for (let attempt = 0; attempt < 12; attempt++) {
                cursor = 0; dirty = false; effects = []; layouts = [];
                // Execute both real page hooks in their normal order so batch
                // input versions are exercised through their actual setters.
                // biome-ignore lint/correctness/useHookAtTopLevel: The harness runs a complete render with its own deterministic hook slots.
                batch = batchModule.exports.useCanvasBatchEdit({ projectId, generationDispatchLocksRef: { current: new Set() }, getCanvasCenter: () => ({ x: 0, y: 0 }), handleMissingModelConfig: noop, isAiConfigReady: () => true,
                    waitForWriteAccess: runtime.waitForWriteAccess, isObservationCurrent: runtime.isObservationCurrent });
                // biome-ignore lint/correctness/useHookAtTopLevel: The harness runs a complete render with its own deterministic hook slots.
                form = module.exports.useCanvasQuickGeneration({ projectId, projectLoaded: true, nodesRef: nodes, connectionsRef: connections,
                    runtime, batchEdit: batch, setDialogNodeId: noop, getCanvasCenter: () => ({ x: 0, y: 0 }), handleMissingModelConfig: noop, isAiConfigReady: () => true });
                layouts.forEach(run => run()); effects.forEach(run => run());
                execute(selectionCode, { projectLoaded: true, lastEditorSelectionRef, editorSelectionKey: `${projectId}:${account.user.id}:${[...selectedNodeIds].sort().join(",")}`,
                    singleSelectedNodeId: selectedNodeIds.size === 1 ? [...selectedNodeIds][0] : null, selectedNodeIds, nodeById: new Map(nodes.current.map(node => [node.id, node])),
                    CanvasNodeType, syncCanvasSelectionReferences, ...form });
                if (!dirty) return form;
            }
            throw new Error("Editor did not settle");
        },
    };
}

test.each(["references", "prompt", "model", "clear", "a-b-a"])("late template assets cannot overwrite newer %s input", async change => {
    const upload = Promise.withResolvers<{ mimeType: string; url: string; storageKey: string }>();
    const h = harness({ upload: upload.promise }); h.render(); await settle();
    let form = h.render();
    if (change === "a-b-a") { h.select(["a"]); h.select(["b"]); form = h.select(["a"]); }
    if (change === "references" || change === "a-b-a") form.setQuickGenerateReferences([userReference]);
    else if (change === "prompt") form.onQuickPromptChange("new user prompt");
    else if (change === "model") form.setQuickGenerateModel("new-user-model");
    else form.setQuickGenerateReferences([]);
    form = h.render();
    const before = { prompt: form.quickGeneratePromptRef.current, model: form.quickGenerateModel, references: structuredClone(form.quickGenerateReferences), nodes: structuredClone(h.nodes.current) };
    upload.resolve({ mimeType: "image/png", url: "blob:template-image", storageKey: "template-image" }); await settle();
    form = h.render();
    expect({ prompt: form.quickGeneratePromptRef.current, model: form.quickGenerateModel, references: form.quickGenerateReferences, nodes: h.nodes.current }).toEqual(before);
    h.unmount();
});

test("typing before template hydration completes prevents even partial template application", async () => {
    const hydration = Promise.withResolvers<typeof template>();
    const h = harness({ hydrate: hydration.promise });
    h.render().onQuickPromptChange("user draft before hydration");
    hydration.resolve(template); await settle();
    const form = h.render();
    expect(form.quickGeneratePromptRef.current).toBe("user draft before hydration");
    expect(form.quickGenerateReferences).toEqual([]);
    h.unmount();
});

test.each(["prompt", "model"])("late batch template hydration preserves newer batch %s input", async change => {
    const hydration = Promise.withResolvers<typeof template>();
    const h = harness({ hydrate: hydration.promise }); h.render();
    if (change === "prompt") h.batch().setBatchEditPrompt("newer batch prompt");
    else h.batch().setBatchImageSettings({ model: "newer-batch-model" });
    h.render();
    const before = { prompt: h.batch().batchEditPrompt, settings: structuredClone(h.batch().batchImageSettings) };
    hydration.resolve({ ...template, template: { ...template.template, targetTool: "batch-edit" } }); await settle();
    h.render();
    expect({ prompt: h.batch().batchEditPrompt, settings: h.batch().batchImageSettings }).toEqual(before);
    expect(h.batch().batchEditOpen).toBe(false);
    h.unmount();
});

test("unchanged batch input receives the complete template through the real batch hook", async () => {
    const h = harness({ hydrate: Promise.resolve({ ...template, template: { ...template.template, targetTool: "batch-edit" } }) });
    h.render(); await settle(); h.render();
    expect(h.batch().batchEditPrompt).toBe("template prompt");
    expect(h.batch().batchImageSettings.model).toBe("template-model");
    expect(h.batch().batchEditOpen).toBe(true);
    h.unmount();
});

test.each(["account", "project", "unmount"])("late template assets cannot cross the %s boundary", async boundary => {
    const upload = Promise.withResolvers<{ mimeType: string; url: string; storageKey: string }>();
    const h = harness({ upload: upload.promise }); h.render(); await settle();
    h.select(["b"]);
    const before = structuredClone(h.nodes.current), notices = h.notices.length;
    if (boundary === "account") h.switchAccount(); else if (boundary === "project") { h.switchProject(); h.render(); } else h.unmount();
    upload.resolve({ mimeType: "image/png", url: "blob:template-image", storageKey: "template-image" }); await settle();
    expect(h.nodes.current).toEqual(before);
    expect(h.notices.length).toBe(notices);
    if (boundary !== "unmount") h.unmount();
});

test("an unchanged creation still receives the complete template without generating", async () => {
    const h = harness({}); h.render(); await settle();
    const form = h.render();
    expect(form.quickGeneratePromptRef.current).toBe("template prompt");
    expect(form.quickGenerateModel).toBe("template-model");
    expect(form.quickGenerateReferences.map(reference => reference.storageKey)).toEqual(["template-image"]);
    expect(h.confirmations).toEqual([]);
    expect(h.nodes.current).toEqual([image("a"), image("b")]);
    h.unmount();
});

test("effect setup-cleanup-setup restarts an unfinished template but does not replay a completed fill", async () => {
    const upload = Promise.withResolvers<{ mimeType: string; url: string; storageKey: string }>();
    const h = harness({ upload: upload.promise }); h.render(); h.restartEffects(); await settle();
    upload.resolve({ mimeType: "image/png", url: "blob:template-image", storageKey: "template-image" }); await settle();
    expect(h.render().quickGenerateReferences.map(reference => reference.storageKey)).toEqual(["template-image"]);
    h.render().onQuickPromptChange("after completed fill"); h.restartEffects(); await settle();
    expect(h.render().quickGeneratePromptRef.current).toBe("after completed fill");
    h.unmount();
});

test("committing a node-panel prompt refreshes the same selected quick editor", () => {
    const h = harness(); const beforeRender = h.select(["a"]);
    h.nodePromptChange("a", "new node-panel prompt");
    // Blur commits before a Generate click; submission reads this ref even if
    // the next passive effect has not run yet.
    expect(beforeRender.quickGeneratePromptRef.current).toBe("new node-panel prompt");
    const form = h.render();
    expect(form.quickGenerateNodeId).toBe("a");
    expect(form.quickGeneratePromptRef.current).toBe("new node-panel prompt");
    h.unmount();
});

test("focus transfer commits the previous textarea before the next editor starts a newer draft", () => {
    const h = harness(); let form = h.select(["a"]);
    form.onQuickPromptChange("left draft");
    h.focusEditor();
    expect(h.nodes.current[0].metadata?.draftPrompt).toBe("left draft");
    const timers = new Map<number, () => void>(); let nextTimer = 0;
    const panel = createCanvasNodePromptDraft("a", "left draft", h.nodePromptChange, { set: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clear: timer => timers.delete(timer as number) });
    panel.change("node-panel draft");
    h.focusEditor(panel.flush);
    expect(timers.size).toBe(0);
    expect(form.quickGeneratePromptRef.current).toBe("node-panel draft");
    form = h.render(); form.onQuickPromptChange("newest left draft"); form.flushQuickNodeDraft();
    panel.flush();
    expect(h.render().quickGeneratePromptRef.current).toBe("newest left draft");
    expect(h.nodes.current[0].metadata?.draftPrompt).toBe("newest left draft");
    h.unmount();
});

test("a template confirmation cannot generate a different draft edited after the fill", async () => {
    const h = harness({ hydrate: Promise.resolve({ ...template, mode: "fill_and_generate" }) }); h.render(); await settle();
    const form = h.render();
    expect(h.confirmations).toHaveLength(1);
    form.onQuickPromptChange("later user draft");
    await h.confirmations[0].onOk();
    expect(h.nodes.current).toEqual([image("a"), image("b")]);
    expect(h.render().quickGeneratePromptRef.current).toBe("later user draft");
    h.unmount();
});

test("same-node reference and parameter edits refresh the quick editor without replacing unaffected normalized fields", () => {
    const h = harness(); let form = h.select(["a"]);
    form.normalizeQuickGenerateSettings({ quality: "high" });
    h.nodeConfigChange("a", { model: "new-model", size: "1536x1024", manualImageReferences: [{ id: "panel-ref", referenceKey: "panel-ref", name: "panel.png", type: "image/png", content: "blob:panel-ref", storageKey: "panel-image", origin: "upload" }] });
    form = h.render();
    expect(form.quickGenerateModel).toBe("new-model");
    expect(form.quickGenerateSize).toBe("1536x1024");
    expect(form.quickGenerateQuality).toBe("high");
    expect(form.quickGenerateReferences.map(reference => reference.storageKey)).toEqual(["panel-image"]);
    h.unmount();
});

test("unrelated metadata refresh never replaces a pending quick prompt or normalized settings", () => {
    const h = harness(); let form = h.select(["a"]);
    form.normalizeQuickGenerateSettings({ quality: "high" });
    form.onQuickPromptChange("still typing");
    h.nodeConfigChange("a", { status: "loading" });
    form = h.render();
    expect(form.quickGeneratePromptRef.current).toBe("still typing");
    expect(form.quickGenerateQuality).toBe("high");
    form.flushQuickNodeDraft();
    expect(h.nodes.current[0].metadata?.draftPrompt).toBe("still typing");
    h.unmount();
});
