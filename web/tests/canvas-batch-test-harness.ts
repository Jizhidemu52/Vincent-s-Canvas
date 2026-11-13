import { readFileSync } from "node:fs";
import ts from "typescript";
import { uiText } from "@/lib/i18n";
import { defaultConfig } from "@/stores/use-config-store";
import { assertCanvasImageUploadSize } from "@/lib/canvas/canvas-image-upload-limit";
import { compiledCanvasGenerationRecord, createCanvasGenerationRecord } from "@/lib/canvas/canvas-generation-record";
import { imageModelProfile, normalizeImageModelSettings } from "@/lib/image-model-settings";
import { shouldCancelCanvasGeneration, stopCanvasObservation } from "@/lib/canvas/canvas-project-async-lifecycle";
import { QueuedTaskHttpError, QueuedTaskSubmissionUncertainError } from "@/services/api/generation-tasks";
import { displayHooksHarness } from "./helpers/display-hooks-harness";

type BatchForm = ReturnType<typeof import("@/pages/canvas/use-canvas-batch-edit").useCanvasBatchEdit>;
type Setter = (update: any) => void;
const transpile = (path: string) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const hookCode = transpile("../src/pages/canvas/use-canvas-batch-edit.ts");
const runtimeCode = transpile("../src/pages/canvas/canvas-batch-edit-runtime.ts");
const noop = () => {};
export const settleBatch = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };

export function batchHarness(options: { upload?: (input: File | string) => Promise<unknown>; persist?: () => Promise<unknown>; loadFailure?: () => boolean } = {}) {
    const slots: any[] = [];
    const nodes = { current: [] as any[] }, connections = { current: [] as any[] }, selected = { current: new Set(["user-selection"]) };
    const assets: any[] = [], persisted: any[] = [], notices: string[] = [], controls: Array<{ id: string; action: string }> = [];
    const submissions: Array<{ prompt: string; files: any[]; options: any; id: string; requestId: string; finish: ReturnType<typeof Promise.withResolvers<any>> }> = [];
    const locks = new Set<string>();
    let account = { user: { id: "owner-a", status: "active", role: "employee", creditBalance: 1000 } };
    let projectId = "project-a", observed = true, writable = true, allocation = 0, cursor = 0, dirty = false;
    let layouts: Array<() => void> = [], effects: Array<() => void> = [], form: BatchForm;
    const effect = (queue: Array<() => void>, callback: () => void | (() => void), dependencies?: unknown[]) => {
        const index = cursor++, previous = slots[index];
        if (!previous || !dependencies || dependencies.some((value, i) => value !== previous.dependencies?.[i])) {
            slots[index] = { dependencies, cleanup: previous?.cleanup };
            queue.push(() => { slots[index].cleanup?.(); slots[index].cleanup = callback(); });
        }
    };
    const react = {
        useState(initial: any) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial; return [slots[index], (update: any) => { const next = typeof update === "function" ? update(slots[index]) : update; if (!Object.is(next, slots[index])) dirty = true; slots[index] = next; }]; },
        useRef(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
        useCallback(callback: Function, dependencies: unknown[]) { const index = cursor++, previous = slots[index]; if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) slots[index] = { callback, dependencies }; return slots[index].callback; },
        useMemo(callback: () => unknown, dependencies: unknown[]) { const index = cursor++, previous = slots[index]; if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) slots[index] = { value: callback(), dependencies }; return slots[index].value; },
        useLayoutEffect: (callback: () => void, dependencies?: unknown[]) => effect(layouts, callback, dependencies),
        useEffect: (callback: () => void, dependencies?: unknown[]) => effect(effects, callback, dependencies),
    };
    const setter = (target: { current: any }): Setter => update => { target.current = typeof update === "function" ? update(target.current) : update; };
    const setters = { nodes: setter(nodes), connections: setter(connections), selectedNodeIds: setter(selected) };
    const message = Object.fromEntries(["info", "warning", "error", "success"].map(level => [level, (text: string) => notices.push(level + ":" + text)]));
    const useUserStore = Object.assign((select: Function) => select(account), { getState: () => account });
    const uploadImage = async (input: File | string) => {
        if (options.upload) await options.upload(input);
        return { url: typeof input === "string" ? input : "source:" + input.name, storageKey: typeof input === "string" ? input : "source:" + input.name, width: 100, height: 100, bytes: 3, mimeType: "image/png" };
    };
    const requestBatchEdit = async (_config: unknown, prompt: string, files: any[], input: any) => {
        const id = "server-" + (submissions.length + 1), requestId = "request-" + (submissions.length + 1);
        await input.onSubmissionStarted(requestId, files.map((_file, itemIndex) => ({ itemIndex })));
        input.signal?.throwIfAborted();
        const finish = Promise.withResolvers<any>();
        submissions.push({ id, requestId, prompt, files, options: input, finish });
        await input.onSubmitted(id);
        return finish.promise;
    };
    const dependencies: Record<string, unknown> = {
        react, "react-dom": { flushSync: (run: () => void) => run() }, antd: { App: { useApp: () => ({ message }) } },
        nanoid: { nanoid: () => "id-" + ++allocation }, "@/lib/i18n": { uiText },
        "@/hooks/use-display-text": displayHooksHarness,
        "@/stores/use-user-store": { useUserStore },
        "@/stores/use-config-store": { useEffectiveConfig: () => defaultConfig, modelOptionName: (model: string) => model },
        "@/hooks/use-tool-config": { currentToolConfig: (config: unknown) => config },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: Function) => select({ estimate: () => ({ configured: false, credits: 0 }) }) },
        "@/stores/use-asset-store": { useAssetStore: (select: Function) => select({ addAssets: (values: any[]) => assets.push(...values) }) },
        "@/stores/canvas/canvas-graph-store": { useCanvasGraphSetter: (field: keyof typeof setters) => setters[field] },
        "@/stores/canvas/use-canvas-store": { useCanvasStore: { getState: () => ({ updateProject: (id: string, update: unknown) => persisted.push({ id, update: structuredClone(update) }) }) }, flushCanvasPersistence: async () => { await options.persist?.(); } },
        "@/services/api/image": { requestBatchEdit },
        "@/services/api/generation-tasks": { QueuedTaskHttpError, QueuedTaskSubmissionUncertainError, controlQueuedBatch: async (id: string, action: string) => { controls.push({ id, action }); return { changed: 1 }; } },
        "@/services/image-storage": { uploadImage },
        "@/lib/canvas/canvas-node-size": { fitNodeSize: () => ({ width: 100, height: 100 }) },
        "@/lib/canvas/canvas-async-pool": { mapCanvasAsyncPool: (values: any[], _limit: number, work: Function) => Promise.all(values.map(value => work(value))) },
        "@/lib/canvas/canvas-image-upload-limit": { assertCanvasImageUploadSize },
        "@/lib/canvas/canvas-generation-record": { compiledCanvasGenerationRecord, createCanvasGenerationRecord },
        "@/lib/image-model-settings": { imageModelProfile, normalizeImageModelSettings },
        "@/lib/canvas/canvas-project-async-lifecycle": { shouldCancelCanvasGeneration, stopCanvasObservation },
        "@/lib/deployment-features": { deploymentFeatures: { creditsEnabled: false } },
        "@/types/canvas": { CanvasNodeType: { Image: "image" } },
        "./canvas-project-utils": { imageMetadata: (image: any) => ({ content: image.url, storageKey: image.storageKey, status: "success" }) },
    };
    const runtimeModule = { exports: {} as any };
    new Function("require", "module", "exports", runtimeCode)((name: string) => dependencies[name] || {}, runtimeModule, runtimeModule.exports);
    const hookModule = { exports: {} as { useCanvasBatchEdit: (options: any) => BatchForm } };
    new Function("require", "module", "exports", hookCode)((name: string) => {
        if (name === "./canvas-batch-edit-runtime") { if (options.loadFailure?.()) throw new Error("chunk unavailable"); return runtimeModule.exports; }
        return dependencies[name] || {};
    }, hookModule, hookModule.exports);
    const guards = { waitForWriteAccess: async () => writable, isObservationCurrent: () => observed };
    const h = {
        nodes, connections, selected, assets, persisted, notices, controls, submissions, locks,
        render() {
            for (let attempt = 0; attempt < 15; attempt++) {
                cursor = 0; dirty = false; layouts = []; effects = [];
                // biome-ignore lint/correctness/useHookAtTopLevel: This is the complete actual hook under deterministic React scheduling.
                form = hookModule.exports.useCanvasBatchEdit({ projectId, generationDispatchLocksRef: { current: locks }, getCanvasCenter: () => ({ x: 0, y: 0 }),
                    handleMissingModelConfig: noop, isAiConfigReady: () => true, ...guards });
                layouts.forEach(run => run()); effects.forEach(run => run());
                if (!dirty) return form;
            }
            throw new Error("Batch hook did not settle");
        },
        draft(name: string) {
            let active = this.render();
            active.setBatchEditPrompt("prompt-" + name); active.setBatchImageSettings({ model: "gpt-image-2" });
            active.setBatchEditItems([{ id: "file-" + name, file: new File(["png"], name + ".png", { type: "image/png" }), relativePath: name + ".png", status: "waiting" }]);
            return this.render();
        },
        complete(index: number) {
            const submission = submissions[index]!;
            submission.finish.resolve({ batchId: submission.id, failures: [], tasks: submission.files.map((_file, itemIndex) => ({ id: submission.id + "-task-" + itemIndex, itemIndex, status: "success", resultUrls: ["result:" + submission.id + ":" + itemIndex] })) });
        },
        fail(index: number, error: unknown) { submissions[index]!.finish.reject(error); },
        switchAccount(id = "owner-b") { account = { user: { ...account.user, id } }; this.render(); },
        changeRole(role: string) { account = { user: { ...account.user, role } }; this.render(); },
        switchProject(id = "project-b") { projectId = id; this.render(); },
        revokeLease() { writable = false; },
        leaveObservation() { observed = false; },
        unmount() { slots.forEach(slot => slot?.cleanup?.()); },
    };
    h.render();
    return h;
}
