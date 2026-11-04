import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { audioExtension } from "@/lib/canvas/canvas-export-loader";
import type { backupCanvasEditorDraft, downloadCanvasEditorNode } from "../src/pages/canvas/canvas-editor-file-actions";

const source = readFileSync(new URL("../src/pages/canvas/canvas-editor-file-actions.ts", import.meta.url), "utf8").replace(/^import .*\n/gm, "").replaceAll("export async function", "async function");
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(result = true, exists = true) {
    const events: string[] = [];
    const saved = { id: "project", title: "Saved", nodes: [{ id: "durable" }] };
    let nodes = [{ id: "before-flush" }];
    const exports: unknown[] = [];
    const backup: typeof backupCanvasEditorDraft = new Function("useCanvasStore", `${code}; return backupCanvasEditorDraft;`)({ getState: () => ({ projects: exists ? [saved] : [] }) });
    const options = {
        projectId: "project", defaultTitle: "Canvas",
        flushEditorDrafts: () => { events.push("draft"); nodes = [{ id: "live-draft" }]; },
        flushPendingHistory: () => { events.push("history"); },
        createHistoryEntry: () => ({ nodes }),
        historyRef: { current: { past: [], future: [] } }, viewportRef: { current: { x: 4, y: 5, k: 0.6 } },
        exportProjects: async (...args: unknown[]) => { events.push("export"); exports.push(args); return result; },
    } as unknown as Parameters<typeof backupCanvasEditorDraft>[0];
    return { run: () => backup(options), options, saved, events, exports };
}

describe("on-demand revoked editor backup", () => {
    test("captures flushed in-memory drafts and history without mutating the shared saved project", async () => {
        const state = harness();
        await state.run();
        expect(state.events).toEqual(["draft", "history", "export"]);
        expect(state.exports).toEqual([[["project"], "Saved-本页未保存备份", [{ ...state.saved, nodes: [{ id: "live-draft" }], history: state.options.historyRef.current, viewport: state.options.viewportRef.current }]]]);
        expect(state.saved.nodes).toEqual([{ id: "durable" }]);
    });
    test("missing project fails without producing an empty archive", async () => {
        const state = harness(true, false);
        await expect(state.run()).rejects.toThrow("画布草稿尚未就绪");
        expect(state.events).toEqual(["draft", "history"]);
        expect(state.exports).toEqual([]);
    });
    test("export cancellation is not a successful recovery backup", async () => {
        const state = harness(false);
        await expect(state.run()).rejects.toThrow("备份未完成");
        expect(state.saved.nodes).toEqual([{ id: "durable" }]);
    });
    test("archive failure propagates so the session cannot authorize a replacement epoch", async () => {
        const state = harness();
        state.options.exportProjects = async () => { throw new Error("archive unavailable"); };
        await expect(state.run()).rejects.toThrow("archive unavailable");
        expect(state.saved.nodes).toEqual([{ id: "durable" }]);
    });
});

describe("on-demand canvas node download", () => {
    function downloadHarness() {
        const events: unknown[] = [];
        const node: CanvasNodeData = { id: "image", type: CanvasNodeType.Image, title: "original", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "blob:original", storageKey: "image:original" } };
        let loadVariants = async () => ({ variants: "fixture" });
        const run: typeof downloadCanvasEditorNode = new Function("CanvasNodeType", "uiText", "audioExtension", "loadCanvasExport", `${code}; return downloadCanvasEditorNode;`)(
            CanvasNodeType, (text: string) => text, audioExtension,
            async () => ({ loadCanvasImageVariants: () => loadVariants(), downloadCanvasContent: (...args: unknown[]) => events.push(args) }),
        );
        const options = {
            projectId: "project", nodesRef: { current: [node] }, savedProjectIdRef: { current: "project" },
            message: { loading: () => { events.push("loading"); return () => events.push("done"); } },
            setImageDownload: (value: unknown) => events.push(value),
        } as unknown as Parameters<typeof downloadCanvasEditorNode>[1];
        return { run: (input = node) => run(input, options), node, options, events, setVariants: (fn: typeof loadVariants) => { loadVariants = fn; } };
    }
    test("opens image choices from the still-current original node and clears progress", async () => {
        const state = downloadHarness();
        await state.run();
        expect(state.events).toEqual(["loading", { projectId: "project", node: state.node, variants: { variants: "fixture" } }, "done"]);
    });
    for (const change of ["project", "image"]) test(`late variant loading cannot open choices after the ${change} changes`, async () => {
        const state = downloadHarness();
        const gate = Promise.withResolvers<{ variants: string }>();
        state.setVariants(() => gate.promise);
        const running = state.run();
        if (change === "project") state.options.savedProjectIdRef.current = "next-project";
        else state.options.nodesRef.current = [{ ...state.node, metadata: { content: "blob:replacement", storageKey: "image:replacement" } }];
        gate.resolve({ variants: "stale" });
        await running;
        expect(state.events).toEqual(["loading", "done"]);
    });
    test("audio keeps sanitized filenames and original download URLs", async () => {
        const state = downloadHarness();
        await state.run({ ...state.node, type: CanvasNodeType.Audio, title: 'clip:one. ', metadata: { content: "blob:audio", mimeType: "audio/wav" } });
        expect(state.events).toEqual(["loading", ["blob:audio", "clip_one.wav"], "done"]);
    });
    test("failed variant loading always clears progress and remains an error", async () => {
        const state = downloadHarness();
        state.setVariants(async () => { throw new Error("variants unavailable"); });
        await expect(state.run()).rejects.toThrow("variants unavailable");
        expect(state.events).toEqual(["loading", "done"]);
    });
});
