import { describe, expect, test } from "bun:test";
import { getSharedConfigForTarget, getSharedConfigTargets, normalizeCanvasConnection, resolveSharedGenerationPlan } from "@/lib/canvas/canvas-shared-generation";
import { getConfigImageInputs } from "@/lib/canvas/canvas-shared-connections";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationMode, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

const node = (id: string, type: CanvasNodeType, metadata: CanvasNodeMetadata = {}): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata });
const image = (id: string) => node(id, CanvasNodeType.Image, { content: `blob:${id}`, storageKey: `image:${id}` });
const config = (mode: CanvasGenerationMode = "image", metadata: CanvasNodeMetadata = {}) => node("config", CanvasNodeType.Config, { generationMode: mode, prompt: "统一处理", ...metadata });
const edge = (fromNodeId: string, toNodeId: string, kind?: CanvasConnection["kind"]): CanvasConnection => ({ id: `${fromNodeId}:${toNodeId}:${kind || "input"}`, fromNodeId, toNodeId, ...(kind ? { kind } : {}) });
const targetEdge = (id: string, configId = "config") => edge(configId, id, "config-target");

describe("shared canvas generation relationships", () => {
    test("incoming image tasks ignore exclusions, empty nodes, generated edges and duplicate connections", () => {
        const settings = config("image", { excludedConnectedImageReferenceKeys: ["node:b"] });
        const nodes = [settings, image("a"), image("b"), image("generated"), node("empty", CanvasNodeType.Image), node("text", CanvasNodeType.Text), node("stored", CanvasNodeType.Image, { storageKey: "stored-only" })];
        const connections = [edge("a", "config"), edge("a", "config"), edge("b", "config"), edge("generated", "config", "generation-output"), edge("empty", "config"), edge("text", "config"), edge("stored", "config"), edge("missing", "config")];
        expect(getConfigImageInputs("config", nodes, connections).map(item => item.id)).toEqual(["a", "stored"]);
        expect(getConfigImageInputs("a", nodes, connections)).toEqual([]);
    });

    test("only fans out explicit one-hop targets and ignores historical results, inputs and duplicates", () => {
        const nodes = [config(), image("a"), image("b"), image("input"), image("output")];
        const connections = [targetEdge("a"), targetEdge("a"), edge("config", "b"), edge("input", "config"), edge("config", "output", "generation-output"), targetEdge("missing")];
        expect(getSharedConfigTargets("config", nodes, connections).map(item => item.id)).toEqual(["a"]);
        expect(getSharedConfigForTarget("a", nodes, connections)?.id).toBe("config");
        expect(getSharedConfigForTarget("b", nodes, connections)).toBeUndefined();
        expect(getSharedConfigTargets("a", nodes, connections)).toEqual([]);
    });

    test("rejects multiple distinct configurations but allows duplicate edges from the same config", () => {
        const second = { ...config(), id: "second" };
        const nodes = [config(), second, image("a")];
        expect(getSharedConfigForTarget("a", nodes, [targetEdge("a"), targetEdge("a")])?.id).toBe("config");
        const connections = [targetEdge("a"), targetEdge("a", "second")];
        expect(() => getSharedConfigForTarget("a", nodes, connections)).toThrow("多个共享配置");
        expect(() => resolveSharedGenerationPlan("a", "config", { nodes, connections })).toThrow("多个共享配置");
    });

    test("requires the requested explicit target relationship", () => {
        expect(() => resolveSharedGenerationPlan("a", "config", { nodes: [config(), image("a")], connections: [edge("config", "a")] })).toThrow("没有连接");
    });

    test("uses the starting handle direction for resources and config nodes", () => {
        const first = image("a"), second = image("b"), settings = config();
        expect(normalizeCanvasConnection(first, second, "source")).toEqual({ fromNodeId: "a", toNodeId: "b" });
        expect(normalizeCanvasConnection(first, second, "target")).toEqual({ fromNodeId: "b", toNodeId: "a" });
        expect(normalizeCanvasConnection(settings, first, "source")).toEqual({ fromNodeId: "config", toNodeId: "a", kind: "config-target" });
        expect(normalizeCanvasConnection(first, settings, "target")).toEqual({ fromNodeId: "config", toNodeId: "a", kind: "config-target" });
        expect(normalizeCanvasConnection(first, settings, "source")).toEqual({ fromNodeId: "a", toNodeId: "config" });
        expect(normalizeCanvasConnection(settings, first, "target")).toEqual({ fromNodeId: "a", toNodeId: "config" });
        expect(normalizeCanvasConnection(first, first, "source")).toBeNull();
        expect(normalizeCanvasConnection(settings, { ...settings, id: "other" }, "source")).toBeNull();
    });
});

describe("shared canvas generation plans", () => {
    test("keeps each target first, shared references ordered, and other targets out of the task", () => {
        const settings = config("image", {
            composerContent: "用 @[node:logo] 修改 @[node:a]，参考 @[node:common]。",
            manualImageReferences: [{ id: "logo", referenceKey: "manual:logo", name: "logo", content: "blob:logo", type: "image/png", origin: "upload" }],
            imageReferenceOrder: ["manual:logo", "node:common"],
        });
        const nodes = [settings, image("a"), image("b"), image("common")];
        const connections = [targetEdge("a"), targetEdge("b"), edge("common", "config")];
        const plan = resolveSharedGenerationPlan("a", "config", { nodes, connections });
        expect(plan.context.referenceImages.map(item => item.id)).toEqual(["a", "logo", "common"]);
        expect(plan.prompt).toBe("用 图片2 修改 图片1，参考 图片3。");
        expect(plan.context.prompt).toBe(plan.prompt);
        expect(plan.context.imageCount).toBe(3);
        settings.metadata!.composerContent = "统一处理";
        expect(resolveSharedGenerationPlan("b", "config", { nodes, connections }).context.referenceImages.map(item => item.id)).toEqual(["b", "logo", "common"]);
    });

    test("dedupes target aliases and same-data public references without losing token aliases", () => {
        const settings = config("image", {
            composerContent: "@[node:copy] @[node:common] @[node:upload] @[node:other-upload]",
            manualImageReferences: [
                { id: "copy", referenceKey: "manual:copy", name: "copy", content: "blob:old-a", storageKey: "image:a", type: "image/png", origin: "upload" },
                { id: "upload", referenceKey: "manual:upload", sourceNodeId: "common", name: "upload", content: "data:image/png;base64,AAAA", type: "image/png", origin: "canvas" },
                { id: "other-upload", referenceKey: "manual:other", name: "other", content: "data:image/png;base64,AAAA", type: "image/png", origin: "upload" },
            ],
        });
        const common = node("common", CanvasNodeType.Image, { content: "data:image/png;base64,AAAA" });
        const plan = resolveSharedGenerationPlan("a", "config", { nodes: [settings, image("a"), common], connections: [targetEdge("a"), edge("common", "config")] });
        expect(plan.context.referenceImages.map(item => item.id)).toEqual(["a", "upload"]);
        expect(plan.prompt).toBe("图片1 图片2 图片2 图片2");
    });

    test("honors excluded common references but never excludes the target's own original", () => {
        const settings = config("image", { composerContent: "@[node:a]", excludedConnectedImageReferenceKeys: ["node:a", "node:excluded"] });
        const snapshot = { nodes: [settings, image("a"), image("excluded")], connections: [targetEdge("a"), edge("a", "config"), edge("excluded", "config")] };
        expect(resolveSharedGenerationPlan("a", "config", snapshot).context.referenceImages.map(item => item.id)).toEqual(["a"]);
        settings.metadata!.composerContent = "@[node:excluded]";
        expect(() => resolveSharedGenerationPlan("a", "config", snapshot)).toThrow("已被排除");
    });

    test("rejects missing and sibling-target tokens instead of silently dropping them", () => {
        const settings = config("image", { composerContent: "@[node:b]" });
        const snapshot = { nodes: [settings, image("a"), image("b")], connections: [targetEdge("a"), targetEdge("b")] };
        expect(() => resolveSharedGenerationPlan("a", "config", snapshot)).toThrow("素材 b");
        settings.metadata!.composerContent = "@[node:missing]";
        expect(() => resolveSharedGenerationPlan("a", "config", snapshot)).toThrow("素材 missing");
    });

    test("injects each text body once despite duplicate edges, repeated tokens and target/common overlap", () => {
        const settings = config("text", { composerContent: "合并 @[node:source]、@[node:common]、@[node:common]" });
        const source = node("source", CanvasNodeType.Text, { content: "SOURCE_BODY" });
        const common = node("common", CanvasNodeType.Text, { content: "COMMON_BODY @[node:literal]" });
        const plan = resolveSharedGenerationPlan("source", "config", { nodes: [settings, source, common], connections: [targetEdge("source"), edge("source", "config"), edge("common", "config"), edge("common", "config")] });
        expect(plan.context.textCount).toBe(2);
        expect(plan.prompt.match(/SOURCE_BODY/g)).toHaveLength(1);
        expect(plan.prompt.match(/COMMON_BODY/g)).toHaveLength(1);
        expect(plan.prompt).toContain("合并 【文本1】、【文本2】、【文本2】");
        expect(plan.prompt).toContain("COMMON_BODY @[node:literal]");
    });

    test("retains unmentioned public text and images when the config composer contains no tokens", () => {
        const plan = resolveSharedGenerationPlan("a", "config", {
            nodes: [config("image", { composerContent: "按统一规则处理" }), image("a"), image("common"), node("instructions", CanvasNodeType.Text, { content: "公共要求" })],
            connections: [targetEdge("a"), edge("common", "config"), edge("instructions", "config")],
        });
        expect(plan.context.referenceImages.map(item => item.id)).toEqual(["a", "common"]);
        expect(plan.prompt).toContain("公共要求");
    });

    test.each(["image", "text", "video", "audio"] as const)("allows an empty %s output slot without inventing input media", mode => {
        const empty = node("empty", mode as CanvasNodeType, mode === "text" ? {} : { prompt: "未执行的草稿" });
        const plan = resolveSharedGenerationPlan("empty", "config", { nodes: [config(mode), empty], connections: [targetEdge("empty")] });
        expect(plan.context).toMatchObject({ imageCount: 0, videoCount: 0, audioCount: 0, textCount: 0 });
        expect(plan.prompt).toBe("统一处理");
    });

    test("ignores empty public media placeholders and whitespace-only text", () => {
        const plan = resolveSharedGenerationPlan("a", "config", {
            nodes: [config(), image("a"), node("empty", CanvasNodeType.Image, { prompt: "NOT_INPUT" }), node("blank", CanvasNodeType.Text, { content: "   " })],
            connections: [targetEdge("a"), edge("empty", "config"), edge("blank", "config")],
        });
        expect(plan.context.imageCount).toBe(1);
        expect(plan.context.textCount).toBe(0);
        expect(plan.prompt).not.toContain("NOT_INPUT");
    });

    test.each(["image", "text", "video"] as const)("keeps a storageKey-only original image first in a %s task", mode => {
        const source = node("source", CanvasNodeType.Image, { storageKey: "image:source", content: "", mimeType: "image/webp", naturalWidth: 1024, naturalHeight: 768, prompt: "NOT_INPUT_TEXT" });
        const plan = resolveSharedGenerationPlan("source", "config", {
            nodes: [config(mode, { composerContent: "@[node:common] 用于 @[node:source]" }), source, image("common")],
            connections: [targetEdge("source"), edge("common", "config")],
        });
        expect(plan.context.referenceImages.map(item => item.id)).toEqual(["source", "common"]);
        expect(plan.context.referenceImages[0]).toMatchObject({ storageKey: "image:source", dataUrl: "", type: "image/webp", width: 1024, height: 768 });
        expect(plan.context.imageCount).toBe(2);
        expect(plan.context.textCount).toBe(0);
        expect(plan.prompt).toBe("图片2 用于 图片1");
        expect(source.metadata!.storageKey).toBe("image:source");
    });

    test("does not mistake a stored audio original for an empty TTS output slot", () => {
        const source = node("source", CanvasNodeType.Audio, { content: "", storageKey: "audio:source" });
        expect(() => resolveSharedGenerationPlan("source", "config", {
            nodes: [config("audio"), source], connections: [targetEdge("source")],
        })).toThrow("仅支持文字转语音");
        expect(source.metadata!.storageKey).toBe("audio:source");
    });

    test("retains and numbers storage-only public references behind the stored target original", () => {
        const source = node("source", CanvasNodeType.Image, { storageKey: "image:source" });
        const common = node("common", CanvasNodeType.Image, { storageKey: "image:common", content: "" });
        const plan = resolveSharedGenerationPlan("source", "config", {
            nodes: [config("image", { composerContent: "@[node:common] 用于 @[node:source]" }), source, common],
            connections: [targetEdge("source"), edge("common", "config")],
        });
        expect(plan.context.referenceImages.map(reference => [reference.id, reference.dataUrl, reference.storageKey])).toEqual([
            ["source", "", "image:source"], ["common", "", "image:common"],
        ]);
        expect(plan.prompt).toBe("图片2 用于 图片1");
    });

    test("keeps video and audio in their own typed reference arrays with the target first", () => {
        const source = node("source", CanvasNodeType.Video, { storageKey: "video:source" });
        const commonVideo = node("common-video", CanvasNodeType.Video, { content: "blob:common-video" });
        const commonAudio = node("common-audio", CanvasNodeType.Audio, { storageKey: "audio:common-audio" });
        const plan = resolveSharedGenerationPlan("source", "config", {
            nodes: [config("video", { composerContent: "@[node:common-video] @[node:source] @[node:common-audio] @[node:picture]" }), source, commonVideo, commonAudio, image("picture")],
            connections: [targetEdge("source"), edge("common-video", "config"), edge("common-audio", "config"), edge("picture", "config")],
        });
        expect(plan.context.referenceVideos.map(item => item.id)).toEqual(["source", "common-video"]);
        expect(plan.context.referenceAudios.map(item => item.id)).toEqual(["common-audio"]);
        expect(plan.context.referenceImages.map(item => item.id)).toEqual(["picture"]);
        expect(plan.prompt).toBe("视频2 视频1 音频1 图片1");
    });

    test("rejects unsupported target and public input types instead of silently ignoring them", () => {
        const audio = node("a", CanvasNodeType.Audio, { content: "blob:audio" });
        for (const mode of ["image", "text", "audio"] as const) {
            expect(() => resolveSharedGenerationPlan("a", "config", { nodes: [config(mode), audio], connections: [targetEdge("a")] })).toThrow();
        }
        expect(() => resolveSharedGenerationPlan("a", "config", { nodes: [config("audio"), node("a", CanvasNodeType.Text, { content: "要朗读的文字" }), image("common")], connections: [targetEdge("a"), edge("common", "config")] })).toThrow("仅支持文字转语音");
    });

    test("returns isolated deeply frozen snapshots without freezing the user's graph", () => {
        const settings = config("image", { imageReferenceOrder: ["node:common"], imageOptions: '{"output_format":"png"}' });
        const source = image("a"), common = image("common");
        const snapshot = { nodes: [settings, source, common], connections: [targetEdge("a"), edge("common", "config")] };
        const plan = resolveSharedGenerationPlan("a", "config", snapshot);
        settings.metadata!.imageReferenceOrder!.push("new");
        source.metadata!.content = "blob:changed";
        common.metadata!.content = "blob:changed-common";
        expect(plan.targetNode.metadata!.content).toBe("blob:a");
        expect(plan.context.referenceImages[1]!.dataUrl).toBe("blob:common");
        expect(plan.configNode.metadata!.imageReferenceOrder).toEqual(["node:common"]);
        expect(Object.isFrozen(plan)).toBe(true);
        expect(Object.isFrozen(plan.configNode.metadata!.imageReferenceOrder)).toBe(true);
        expect(Object.isFrozen(plan.context.referenceImages[0])).toBe(true);
        expect(Object.isFrozen(settings.metadata)).toBe(false);
        expect(() => plan.context.referenceImages.push({ id: "x", name: "x", dataUrl: "blob:x", type: "image/png" })).toThrow();
    });
});
