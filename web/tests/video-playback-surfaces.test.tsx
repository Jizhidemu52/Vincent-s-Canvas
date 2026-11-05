import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import ts from "typescript";
import { canvasThemes } from "@/lib/canvas-theme";
import { CanvasNodeType } from "@/types/canvas";
import { i18nHarness } from "./helpers/i18n-harness";

const assetId = "7075c394-1184-44cc-9077-068d78e8b36d";
function elements(node: unknown): React.ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement<any>(node)) return [];
    return [node, ...elements(node.props.children)];
}
function text(node: unknown): string {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(text).join("");
    return React.isValidElement<any>(node) ? text(node.props.children) : "";
}
function surface(kind: "canvas" | "asset", preview: Record<string, unknown>) {
    const path = new URL(kind === "canvas" ? "../src/components/canvas/canvas-video-node-content.tsx" : "../src/pages/assets/index.tsx", import.meta.url);
    const requireModule = createRequire(path), calls: any[] = [];
    const module = { exports: {} as any };
    const source = readFileSync(path, "utf8") + (kind === "asset" ? "\nexports.ResolvedAssetVideo = ResolvedAssetVideo;" : "");
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    new Function("require", "module", "exports", code)((name: string) => name === "react" ? { ...React, useRef: (value: unknown) => ({ current: value }), useEffect() {}, useState: (value: any) => [typeof value === "function" ? value() : value, () => {}] }
        : name === "@/lib/i18n" ? i18nHarness
        : name === "@/hooks/use-video-playback" ? { ...requireModule(name), useVideoPlayback: (input: unknown) => { calls.push(input); return { onError() {}, onLoadedMetadata() {}, retry() {}, ...preview }; } }
        : requireModule(name), module, module.exports);
    return { render: kind === "canvas" ? module.exports.CanvasVideoNodeContent : module.exports.ResolvedAssetVideo, calls };
}
const node = { id: "video", title: "原视频", type: CanvasNodeType.Video, position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: "blob:original", storageKey: "video:original", serverAssetId: assetId, status: "success" } };
const asset = { id: "local-asset", kind: "video", ownerId: "owner", title: "原视频", data: { url: "blob:original", storageKey: "video:original", width: 0, height: 0, bytes: 100, mimeType: "video/mp4" }, metadata: { serverAssetId: assetId }, coverUrl: "" };

test("canvas playback uses the display derivative and leaves node source and dimensions unchanged", () => {
    const before = structuredClone(node);
    const h = surface("canvas", { status: "ready", playbackUrl: "blob:compatibility", width: 1248, height: 1664, durationMs: 6048 });
    const tree = h.render({ node, theme: canvasThemes.light, renderQuality: "full" });
    expect(elements(tree).find(element => element.type === "video")?.props.src).toBe("blob:compatibility");
    expect(h.calls[0]).toMatchObject({ assetId, storageKey: "video:original", enabled: true });
    expect(text(tree)).toContain("1248x1664");
    expect(node).toEqual(before);
    const lightweight = h.render({ node, theme: canvasThemes.light, renderQuality: "moving" });
    expect(h.calls.at(-1)?.enabled).toBe(false);
    expect(elements(lightweight).some(element => element.type === "video")).toBe(false);
});

test("canvas preparation and errors are explicit and never fall back to unsupported server originals", () => {
    const preparing = surface("canvas", { status: "preparing" }).render({ node, theme: canvasThemes.light, renderQuality: "full" });
    expect(elements(preparing).some(element => element.type === "video")).toBe(false);
    expect(text(preparing)).toContain("兼容预览");
    const error = surface("canvas", { status: "error", error: "无权访问或素材不存在" }).render({ node, theme: canvasThemes.light, renderQuality: "full" });
    expect(text(error)).toContain("无权访问或素材不存在");
    expect(node.metadata.content).toBe("blob:original");
});

test("asset detail playback uses a preview while retaining download/export data and explicit asset identity", () => {
    const before = structuredClone(asset);
    const h = surface("asset", { status: "ready", playbackUrl: "blob:compatibility", width: 1248, height: 1664, durationMs: 6048 });
    const tree = h.render({ asset, controls: true, className: "preview" });
    const video = elements(tree).find(element => element.type === "video")!;
    expect(video.props.src).toBe("blob:compatibility");
    expect(video.props.controls).toBe(true);
    expect(h.calls[0]).toMatchObject({ assetId, storageKey: "video:original" });
    expect(text(tree)).toContain("1248x1664");
    expect(asset).toEqual(before);
});

test("local-only asset detail states its compatibility boundary without inventing an asset id", () => {
    const h = surface("asset", { status: "local", playbackUrl: "blob:local" });
    const tree = h.render({ asset: { ...asset, metadata: {}, data: { ...asset.data, url: `/api/assets/${assetId}/content` } }, controls: true });
    expect(h.calls[0]?.assetId).toBeUndefined();
    expect(text(tree)).toContain("本地原件");
    expect(elements(tree).find(element => element.type === "video")?.props.src).toBe("blob:local");
});
