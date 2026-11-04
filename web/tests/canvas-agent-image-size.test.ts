import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { buildAgentGenerationPlan, resolveAgentImageGenerationSettings, type AgentGenerationSettings } from "@/lib/agent-direct-generation";
import { imageModelProfile } from "@/lib/image-model-settings";
import { defaultConfig } from "@/stores/use-config-store";
import { QueuedTaskFailedError, QueuedTaskPausedError } from "@/services/api/generation-tasks";
import type { ReferenceImage } from "@/types/image";

const settings: AgentGenerationSettings = { mode: "image", imageModel: "vcen-gpt2", videoModel: "wan2.7", size: "1:1", quality: "1k", imageCount: "1", videoSeconds: "5", videoQuality: "720P", afterImage: "images_only" };
const base: ReferenceImage = { id: "resolved-base", name: "source", type: "image/png", dataUrl: "data:image/png;base64,AA==", width: 1, height: 1 };
const style: ReferenceImage = { ...base, id: "style" };
const ratioProfile = imageModelProfile("vcen-gpt2", []);
const fixedProfile = imageModelProfile("fixed", []);
const noRead = async () => { throw new Error("Source must not be measured"); };

test.each([
    [{ width: 1500, height: 2000 }, "3:4"],
    [{ width: 1280, height: 1707 }, "3:4"],
    [{ width: 1707, height: 1280 }, "4:3"],
    [{ width: 2000, height: 1500 }, "4:3"],
    [{ width: 1254, height: 1254 }, "1:1"],
    [{ width: 1080, height: 1920 }, "9:16"],
] as const)("canvas default edit uses actual resolved-base pixels %j, not global 1:1 or stale dimensions", async (dimensions, expected) => {
    const before = structuredClone({ settings, base });
    const reads: ReferenceImage[] = [];
    const result = await resolveAgentImageGenerationSettings(settings, [style, base], base.id, ratioProfile, () => {}, async source => { reads.push(source); return dimensions; });
    expect(result.size).toBe(expected);
    expect(reads).toEqual([base]);
    expect(buildAgentGenerationPlan(result, "只改颜色", [base], ratioProfile).size).toBe(expected);
    expect({ settings, base }).toEqual(before);
});

test.each(["1:1", "4:3", "auto"])("explicit canvas image size %s wins without reading the base", async requestedImageSize => {
    const result = await resolveAgentImageGenerationSettings({ ...settings, size: "16:9", requestedImageSize }, [base], base.id, ratioProfile, () => {}, noRead);
    expect(result.size).toBe(requestedImageSize);
    expect(result.requestedImageSize).toBe(requestedImageSize);
});

test("canvas new creation, including style references without a base, keeps its existing default", async () => {
    expect((await resolveAgentImageGenerationSettings({ ...settings, size: "16:9" }, [style], undefined, ratioProfile, () => {}, noRead)).size).toBe("16:9");
    expect((await resolveAgentImageGenerationSettings({ ...settings, requestedImageSize: "3:4" }, [], undefined, ratioProfile, () => {}, noRead)).size).toBe("3:4");
    expect(await resolveAgentImageGenerationSettings({ ...settings, mode: "video", size: "16:9", requestedImageSize: "3:4" }, [base], base.id, ratioProfile, () => {}, noRead)).toMatchObject({ mode: "video", size: "16:9" });
});

test("canvas exact fixed presets are allowed but unsupported proportions and model changes are rejected", async () => {
    expect((await resolveAgentImageGenerationSettings(settings, [base], base.id, fixedProfile, () => {}, async () => ({ width: 600, height: 900 }))).size).toBe("1024x1536");
    await expect(resolveAgentImageGenerationSettings(settings, [base], base.id, fixedProfile, () => {}, async () => ({ width: 1500, height: 2000 }))).rejects.toThrow("不能精确保留底图画幅");
    await expect(resolveAgentImageGenerationSettings({ ...settings, requestedImageSize: "3:4" }, [base], base.id, fixedProfile, () => {}, noRead)).rejects.toThrow("不支持已选择的图片尺寸");
    expect((await resolveAgentImageGenerationSettings({ ...settings, requestedImageSize: "1:1" }, [base], base.id, fixedProfile, () => {}, noRead)).size).toBe("1024x1024");
});

test("unreadable, missing, invalid or cancelled canvas base cannot fall back to a square task", async () => {
    await expect(resolveAgentImageGenerationSettings(settings, [style], base.id, ratioProfile, () => {}, noRead)).rejects.toThrow("没有可用的编辑底图");
    await expect(resolveAgentImageGenerationSettings(settings, [base], base.id, ratioProfile, () => {}, async () => { throw new Error("source unavailable"); })).rejects.toThrow("source unavailable");
    await expect(resolveAgentImageGenerationSettings(settings, [base], base.id, ratioProfile, () => {}, async () => ({ width: 0, height: 2 }))).rejects.toThrow("底图尺寸无法读取");
    const controller = new AbortController();
    await expect(resolveAgentImageGenerationSettings(settings, [base], base.id, ratioProfile, () => controller.signal.throwIfAborted(), async () => { controller.abort(new Error("stopped")); return { width: 1500, height: 2000 }; })).rejects.toThrow("stopped");
});

function panelGeneration(readSize: (source: ReferenceImage) => Promise<{ width: number; height: number }>, model = "vcen-gpt2") {
    const source = readFileSync(new URL("../src/components/canvas/canvas-assistant-panel.tsx", import.meta.url), "utf8");
    const ast = ts.createSourceFile("panel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let initializer: ts.Expression | undefined;
    function visit(node: ts.Node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "runDirectGeneration") initializer = node.initializer;
        ts.forEachChild(node, visit);
    }
    visit(ast);
    if (!initializer) throw new Error("Missing real generation handler");
    const requests: any[] = [], signatures: any[] = [], messages: any[] = [];
    const snapshotRef = { current: { projectId: "project", nodes: [{ id: "node" }] } };
    const sent = new Error("mock submit completed");
    const submit = async (config: unknown, prompt: string, references?: unknown) => { requests.push({ config, prompt, references }); throw sent; };
    const bindings = {
        imageModelProfile, buildAgentGenerationPlan, snapshotRef,
        resolveAgentImageGenerationSettings: (s: AgentGenerationSettings, refs: ReferenceImage[], baseId: string | undefined, profile: typeof ratioProfile, assertCurrent: () => void) => resolveAgentImageGenerationSettings(s, refs, baseId, profile, assertCurrent, readSize),
        canvasToolKey: () => "canvas-edit", resolveToolConfig: async (config: unknown) => ({ config: { ...config as any, model }, model: { id: model, modelId: model, name: model } }),
        nanoid: () => "request", imageModelDisplayName: (value: string) => value, modelOptionName: (value: string) => value,
        canvasImageAgentTaskSignature: async (value: unknown) => { signatures.push(value); return "signature"; },
        pendingSignaturesRef: { current: new Set() }, localSessionsRef: { current: [] }, turnIdsRef: { current: new WeakMap() },
        appendMessage: (_id: string, message: unknown) => messages.push(message), upsertMessage: () => {},
        requestEdit: submit, requestGeneration: submit, QueuedTaskFailedError, QueuedTaskPausedError,
    };
    const code = ts.transpileModule(`return ${initializer.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    const run = new Function(...Object.keys(bindings), code)(...Object.values(bindings));
    return { run, requests, signatures, messages, snapshotRef, sent };
}

test("real canvas handler resolves base size before plan, duplicate signature and requestEdit serialization", async () => {
    const reads: ReferenceImage[] = [];
    const run = panelGeneration(async source => { reads.push(source); return { width: 1500, height: 2000 }; });
    await expect(run.run("session", "改浅绿", settings, [style, base], defaultConfig, { baseImageId: base.id, referenceIds: [base.id, style.id], note: { summary: "", keep: [] } })).rejects.toThrow(run.sent.message);
    expect(reads).toEqual([base]);
    expect(run.requests).toHaveLength(1);
    expect(run.requests[0].config.size).toBe("3:4");
    expect(run.signatures[0]).toMatchObject({ base: base.id, settings: { size: "3:4" } });
    expect(run.messages[0].detail.settings.size).toBe("3:4");
});

test("real canvas handler keeps no-base creation unchanged and does not reinterpret style images as the base", async () => {
    const run = panelGeneration(noRead);
    await expect(run.run("session", "新创作", settings, [style], defaultConfig, { referenceIds: [style.id], note: { summary: "", keep: [] } })).rejects.toThrow(run.sent.message);
    expect(run.requests[0].config.size).toBe("1:1");
});

test("real canvas handler blocks unsupported base or removed target before any task signature or POST", async () => {
    const unsupported = panelGeneration(async () => ({ width: 1500, height: 2000 }), "fixed");
    await expect(unsupported.run("session", "改色", settings, [base], defaultConfig, { baseImageId: base.id, referenceIds: [base.id], note: { summary: "", keep: [] } })).rejects.toThrow("不能精确保留底图画幅");
    expect(unsupported.requests).toEqual([]); expect(unsupported.signatures).toEqual([]);
    const deleted = panelGeneration(async () => { deleted.snapshotRef.current.nodes = []; return { width: 1500, height: 2000 }; });
    await expect(deleted.run("session", "改色", settings, [base], defaultConfig, undefined, undefined, "node")).rejects.toThrow("生成源节点已删除");
    expect(deleted.requests).toEqual([]); expect(deleted.signatures).toEqual([]);
});
