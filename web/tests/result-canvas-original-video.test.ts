import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import ts from "typescript";

test("placing a video preserves original bytes and records only the server id returned by the existing explicit upload", async () => {
    const path = new URL("../src/hooks/use-result-canvas.ts", import.meta.url), requireModule = createRequire(path);
    const originalBytes = new Uint8Array([0, 255, 32, 104, 118, 99, 49, 10, 0, 17]);
    const original = new Blob([originalBytes], { type: "video/mp4" });
    const uploaded: File[] = [], persisted: Blob[] = [], imported: any[] = [], requests: string[] = [], sources: unknown[] = [], navigations: string[] = [], errors: unknown[] = [];
    const assetId = "7075c394-1184-44cc-9077-068d78e8b36d";
    const owner = { user: { id: "owner", status: "active" } };
    const deps: Record<string, unknown> = {
        react: { ...React, useRef: (value: unknown) => ({ current: value }), useState: (value: unknown) => [value, () => {}] },
        antd: { App: { useApp: () => ({ message: { error: (value: unknown) => errors.push(value) } }) } },
        "react-router-dom": { useNavigate: () => (url: string) => navigations.push(url) },
        "@/stores/use-module-store": { useModuleEnabled: () => true },
        "@/stores/use-user-store": { useUserStore: Object.assign((select: (state: typeof owner) => unknown) => select(owner), { getState: () => owner }) },
        "@/stores/canvas/use-canvas-store": { flushCanvasPersistence: async () => {}, useCanvasStore: { getState: () => ({ hydrated: true, openProject: () => false, importProject: (project: unknown) => { imported.push(project); return "canvas-id"; } }) } },
        "@/services/file-storage": { resolveMediaUrl: async (key: string, fallback: string) => { expect(key).toBe("video:original"); expect(fallback).toBe("blob:original"); return fallback; }, uploadMediaFile: async (blob: Blob) => { persisted.push(blob); return { url: "blob:persisted-original", storageKey: "video:stored-original" }; } },
        "@/services/api/server-assets": { uploadServerAsset: async (file: File) => { uploaded.push(file); return assetId; }, fetchServerAssetPlayback: () => { throw new Error("canvas placement must not read preview bytes"); } },
        "@/services/canvas-media-links": { rememberMediaSource: async (...args: unknown[]) => sources.push(args) },
    };
    const module = { exports: {} as any };
    const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018, esModuleInterop: true } }).outputText;
    new Function("require", "module", "exports", "fetch", code)((name: string) => deps[name] || requireModule(name), module, module.exports, async (url: string) => { requests.push(url); return new Response(original); });
    const media = { id: "result", kind: "video", title: "原视频", url: "blob:original", storageKey: "video:original", width: 0, height: 0, playbackUrl: "blob:compatibility-must-not-copy" };
    const before = structuredClone(media);
    await module.exports.useResultCanvas().place(media);
    expect(errors).toEqual([]); expect(requests).toEqual(["blob:original"]);
    expect(uploaded).toHaveLength(1); expect(persisted).toHaveLength(1);
    expect(new Uint8Array(await uploaded[0]!.arrayBuffer())).toEqual(originalBytes);
    expect(new Uint8Array(await persisted[0]!.arrayBuffer())).toEqual(originalBytes);
    expect(imported[0].nodes[0].metadata).toMatchObject({ serverAssetId: assetId, content: "blob:persisted-original", storageKey: "video:stored-original", bytes: original.size, mimeType: original.type });
    expect(sources).toEqual([["video:stored-original", `/api/assets/${assetId}/content`]]);
    expect(media).toEqual(before); expect(navigations).toEqual(["/canvas/canvas-id"]);
});
