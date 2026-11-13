import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import ts from "typescript";
import { i18nHarness } from "./helpers/i18n-harness";

const path = new URL("../src/pages/video/index.tsx", import.meta.url);
const requireModule = createRequire(path);
const code = ts.transpileModule(`${readFileSync(path, "utf8")}\nexports.ResultVideoCard = ResultVideoCard;`, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const module = { exports: {} as any };
const DisplayText = ({ text }: { text: string }) => text;
new Function("require", "module", "exports", code)((name: string) => name.endsWith(".css") ? {} : name === "@/lib/i18n" ? i18nHarness : name === "@/hooks/use-display-text" ? { DisplayText } : requireModule(name), module, module.exports);
function elements(node: unknown): React.ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement<any>(node)) return [];
    return [node, ...elements(node.props.children)];
}
function text(node: unknown): string {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(text).join("");
    if (!React.isValidElement<any>(node)) return "";
    return text(node.type === DisplayText ? DisplayText(node.props) : node.props.children);
}
const original = { id: "video", url: "blob:original-hevc", storageKey: "video:original", bytes: 9006734, mimeType: "video/mp4", durationMs: 100000, serverAssetId: "7075c394-1184-44cc-9077-068d78e8b36d" };
const card = (props = {}) => module.exports.ResultVideoCard({ video: original, onSelect() {}, onDownload() {}, onSaveAsset() {}, ...props });

test("only the video player uses the compatibility blob; downloads receive the unchanged original", () => {
    let downloaded: unknown;
    const tree = card({ playback: { status: "ready", playbackUrl: "blob:compatibility", width: 1248, height: 1664, durationMs: 6048 }, onDownload: (value: unknown) => { downloaded = value; } });
    expect(elements(tree).find(element => element.type === "video")?.props.src).toBe("blob:compatibility");
    elements(tree).find(element => text(element) === "下载" && element.props.onClick)?.props.onClick();
    expect(downloaded).toBe(original);
    expect(original.url).toBe("blob:original-hevc");
    expect(text(tree)).toContain("1248x1664");
});

test("a successful result awaiting compatibility playback does not expose the unsupported original", () => {
    const tree = card({ playback: { status: "preparing" } });
    expect(elements(tree).find(element => element.type === "video")?.props.src).toBeUndefined();
    expect(text(tree)).toContain("已生成");
    expect(text(tree)).toContain("准备");
    expect(text(tree)).toContain("尺寸未知");
    expect(text(tree)).not.toContain("1280x720");
});

test("local-only videos retain the original player and an explicit compatibility boundary", () => {
    const tree = card({ video: { ...original, serverAssetId: undefined }, playback: { status: "local" } });
    expect(elements(tree).find(element => element.type === "video")?.props.src).toBe(original.url);
    expect(text(tree)).toContain("仅有本地原件");
});

test("player decode errors and measured metadata are reported through view-only callbacks", () => {
    let errors = 0;
    let measured: unknown;
    const tree = card({ playback: { status: "ready", playbackUrl: "blob:compatibility" }, onPlaybackError: () => errors++, onMetadata: (value: unknown) => { measured = value; } });
    const player = elements(tree).find(element => element.type === "video")!;
    player.props.onError();
    player.props.onLoadedMetadata({ currentTarget: { videoWidth: 1248, videoHeight: 1664, duration: 6.048 } });
    expect(errors).toBe(1);
    expect(measured).toEqual({ width: 1248, height: 1664, durationMs: 6048 });
    expect(text(card({ playback: { status: "error", error: "当前浏览器仍无法解码；原任务已成功。" } }))).toContain("原任务已成功");
});
