import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { canvasGenerationEditorState, storeCanvasEditorReferences } from "@/lib/canvas/canvas-generation-editor";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

type QuickGeneration = ReturnType<typeof import("@/pages/canvas/use-canvas-quick-generation").useCanvasQuickGeneration>;
const code = ts.transpileModule(readFileSync(new URL("../src/pages/canvas/use-canvas-quick-generation.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
}).outputText;
const noop = () => undefined;
const image = (id: string): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, width: 100, height: 100, position: { x: 0, y: 0 }, metadata: {
    content: `https://local/${id}.png`, prompt: `original ${id}`, generationRecord: {
        version: 1, id: `run-${id}`, createdAt: "2026-10-30T00:00:00Z", prompt: `original ${id}`, inputPrompt: `input ${id}`, references: [],
        parameters: { model: `retired-${id}`, size: "1:1", quality: "unsupported", count: 5, imageOptions: "", systemPrompt: "", generationType: "generation" },
    },
} });

// Run the real hook and editor hydration with local hook storage. All network,
// provider and UI boundaries are inert; graph-setter calls are observable.
function harness() {
    const nodes = { current: [image("a"), image("b")] };
    const slots: any[] = [];
    let cursor = 0, writes = 0, projectId = "project-a";
    let account = { status: "authenticated", user: { id: "employee-a" } };
    let effects: Array<() => void> = [];
    const effect = (callback: () => void, dependencies: unknown[]) => {
        const index = cursor++, previous = slots[index];
        if (!previous || dependencies.some((value, i) => value !== previous[i])) effects.push(callback);
        slots[index] = dependencies;
    };
    const react = {
        useState(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (next: any) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }]; },
        useRef(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
        useCallback(callback: Function, dependencies: unknown[]) { const index = cursor++, previous = slots[index]; if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) slots[index] = { callback, dependencies }; return slots[index].callback; },
        useMemo: (callback: () => unknown) => callback(), useEffect: effect, useLayoutEffect: effect,
    };
    const setNodes = (update: (current: CanvasNodeData[]) => CanvasNodeData[]) => { writes++; nodes.current = update(nodes.current); };
    const useUserStore = Object.assign((select: (state: typeof account) => unknown) => select(account), { getState: () => account });
    const dependencies: Record<string, unknown> = {
        react, antd: { App: { useApp: () => ({ message: {}, modal: {} }) } }, "react-router-dom": { useSearchParams: () => [new URLSearchParams()] },
        "@/stores/use-user-store": { useUserStore },
        "@/stores/use-config-store": { defaultConfig, useEffectiveConfig: () => defaultConfig },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: Function) => select({ estimate: () => ({ credits: 0, rmbCost: 0 }) }) },
        "@/stores/use-asset-store": { useAssetStore: (select: Function) => select({ addAsset: noop }) },
        "@/stores/canvas/use-canvas-panel-store": { useCanvasPanelStore: (select: Function) => select({ creationOpen: true, setCreationOpen: noop }) },
        "@/stores/canvas/canvas-graph-store": { useCanvasGraphSetter: (field: string) => field === "nodes" ? setNodes : noop },
        "@/lib/canvas/canvas-image-usage": { canvasImageUsageInput: () => ({}) },
        "@/lib/canvas/canvas-generation-editor": { canvasGenerationEditorState, storeCanvasEditorReferences },
    };
    const module = { exports: {} as { useCanvasQuickGeneration: (options: unknown) => QuickGeneration } };
    new Function("require", "module", "exports", code)((name: string) => dependencies[name] || {}, module, module.exports);
    return {
        nodes, get writes() { return writes; },
        switchAccount: () => { account = { ...account, user: { id: "employee-b" } }; },
        switchProject: () => { projectId = "project-b"; },
        render() {
            cursor = 0; effects = [];
            const result = module.exports.useCanvasQuickGeneration({ projectId, projectLoaded: true, nodesRef: nodes, connectionsRef: { current: [] },
                runtime: {}, batchEdit: {}, setDialogNodeId: noop, getCanvasCenter: () => ({ x: 0, y: 0 }), handleMissingModelConfig: noop, isAiConfigReady: () => true });
            effects.forEach(run => run());
            return result;
        },
    };
}

test("normalization updates only the active form; genuine user settings persist without changing the archive", () => {
    const h = harness(), original = structuredClone(h.nodes.current);
    h.render().loadQuickGenerationNode(h.nodes.current[0]!);
    let form = h.render();
    form.normalizeQuickGenerateSettings({ model: "gpt-image-2", size: "1024x1024", quality: "auto", count: 1, imageOptions: '{"resolution":"1k"}' });
    form = h.render();
    expect(form).toMatchObject({ quickGenerateModel: "gpt-image-2", quickGenerateSize: "1024x1024", quickGenerateQuality: "auto", quickGenerateCount: 1, quickGenerateImageOptions: '{"resolution":"1k"}' });
    expect(h.writes).toBe(0);
    expect(h.nodes.current).toEqual(original);
    form.setQuickGenerateSize("1536x1024"); form.setQuickGenerateQuality("high"); form.setQuickGenerateImageOptions('{"resolution":"4k"}');
    expect(h.nodes.current[0]!.metadata).toMatchObject({ size: "1536x1024", quality: "high", imageOptions: '{"resolution":"4k"}' });
    expect(h.nodes.current[0]!.metadata!.generationRecord).toEqual(original[0]!.metadata!.generationRecord);
    expect(h.nodes.current[1]).toEqual(original[1]);
    expect(h.writes).toBe(3);
});

test("old creation and A/B/A normalization closures cannot alter the newly loaded form or graph", () => {
    const h = harness(), original = structuredClone(h.nodes.current);
    const creation = h.render();
    creation.loadQuickGenerationNode(h.nodes.current[0]!);
    creation.normalizeQuickGenerateSettings({ model: "stale creation" });
    const firstA = h.render();
    expect(firstA.quickGenerateModel).toBe("retired-a");
    firstA.loadQuickGenerationNode(h.nodes.current[1]!);
    firstA.normalizeQuickGenerateSettings({ model: "stale a" });
    const b = h.render();
    expect(b.quickGenerateModel).toBe("retired-b");
    b.loadQuickGenerationNode(h.nodes.current[0]!);
    firstA.normalizeQuickGenerateSettings({ size: "stale earlier a" });
    b.normalizeQuickGenerateSettings({ model: "stale b" });
    let latestA = h.render();
    expect(latestA.quickGenerateModel).toBe("retired-a");
    expect(latestA.quickGenerateSize).toBe("1:1");
    latestA.normalizeQuickGenerateSettings({ size: "1024x1024" });
    latestA = h.render();
    expect(latestA.quickGenerateSize).toBe("1024x1024");
    expect(h.nodes.current).toEqual(original);
    expect(h.writes).toBe(0);
});

test("account and project changes invalidate normalization callbacks before any graph write", () => {
    for (const boundary of ["account", "project"] as const) {
        const h = harness();
        h.render().loadQuickGenerationNode(h.nodes.current[0]!);
        const previous = h.render();
        if (boundary === "account") h.switchAccount(); else { h.switchProject(); h.render(); }
        previous.normalizeQuickGenerateSettings({ model: "stale owner" });
        expect(h.render().quickGenerateModel).toBe("retired-a");
        expect(h.writes).toBe(0);
    }
});
