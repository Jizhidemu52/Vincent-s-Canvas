import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import ts from "typescript";
import type { ServerAssetPlayback } from "../src/services/api/server-assets";

const assetId = "7075c394-1184-44cc-9077-068d78e8b36d";
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function harness(fetch: (id: string, options: { signal: AbortSignal }) => Promise<ServerAssetPlayback>, readSource: (key: string) => Promise<string | null> = async () => null) {
    const path = new URL("../src/hooks/use-video-playback.ts", import.meta.url), requireModule = createRequire(path);
    let owner = { status: "authenticated", user: { id: "employee-a", role: "designer" } };
    const listeners = new Set<(state: typeof owner) => void>(), workspace = new Set<(id: string | null) => void>();
    const states: any[] = [], effects: Array<{ deps?: readonly unknown[]; cleanup?: (() => void) | void }> = [], pending: Array<() => void> = [];
    const created: Blob[] = [], revoked: string[] = [];
    let stateIndex = 0, effectIndex = 0;
    const userStore = Object.assign((select: (state: typeof owner) => unknown) => select(owner), {
        getState: () => owner, subscribe: (callback: (state: typeof owner) => void) => { listeners.add(callback); return () => listeners.delete(callback); },
    });
    const deps: Record<string, unknown> = {
        react: { ...React,
            useState: (initial: any) => { const index = stateIndex++; if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial; return [states[index], (next: any) => { states[index] = typeof next === "function" ? next(states[index]) : next; }]; },
            useEffect: (effect: () => any, values?: readonly unknown[]) => {
                const index = effectIndex++, previous = effects[index];
                if (previous && values && previous.deps?.length === values.length && values.every((value, i) => Object.is(value, previous.deps![i]))) return;
                pending.push(() => { previous?.cleanup?.(); effects[index] = { deps: values, cleanup: effect() }; });
            },
        },
        "@/lib/deployment-features": { deploymentFeatures: { authenticationEnabled: true } },
        "@/lib/workspace-session-events": { subscribeWorkspaceIdentity: (callback: (id: string | null) => void) => { workspace.add(callback); return () => workspace.delete(callback); } },
        "@/stores/use-user-store": { useUserStore: userStore },
        "@/services/api/server-assets": { fetchServerAssetPlayback: fetch },
        "@/services/canvas-media-links": { serverMediaId: (url: string) => url.match(/^\/api\/assets\/([^/]+)\/content$/)?.[1] || "", readMediaSource: readSource },
    };
    const module = { exports: {} as any };
    const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018, esModuleInterop: true } }).outputText;
    new Function("require", "module", "exports", "URL", code)((name: string) => deps[name] || requireModule(name), module, module.exports, {
        createObjectURL: (blob: Blob) => { created.push(blob); return `blob:compatibility-${created.length}`; }, revokeObjectURL: (url: string) => revoked.push(url),
    });
    const render = (input: { assetId?: string; storageKey?: string; originalUrl: string; enabled?: boolean }) => {
        stateIndex = effectIndex = 0;
        const view = module.exports.useVideoPlayback(input);
        pending.splice(0).forEach(effect => effect());
        return view;
    };
    return { render, created, revoked, changeOwner(id: string, role = "designer") { owner = { status: "authenticated", user: { id, role } }; for (const listener of [...listeners]) listener(owner); },
        broadcastOwner(id: string | null) { for (const listener of [...workspace]) listener(id); },
        unmount: () => effects.forEach(effect => effect.cleanup?.()), subscriptions: () => listeners.size + workspace.size };
}

test("shared display hook drops a pending old-owner response and publishes only a freshly authorized preview", async () => {
    const requests: Array<{ signal: AbortSignal; resolve: (value: ServerAssetPlayback) => void }> = [];
    const h = harness(async (_id, { signal }) => new Promise(resolve => requests.push({ signal, resolve })));
    const input = { assetId, originalUrl: "blob:original", storageKey: "video:original" };
    h.render(input); await settle();
    expect(requests).toHaveLength(1);
    h.changeOwner("employee-b");
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(h.render(input).playbackUrl).toBeUndefined(); await settle();
    requests[0]!.resolve({ blob: new Blob(["private-a"]) });
    requests[1]!.resolve({ blob: new Blob(["private-b"]), width: 1248, height: 1664, durationMs: 6048 }); await settle();
    expect(h.created).toHaveLength(1);
    expect(await h.created[0]!.text()).toBe("private-b");
    expect(h.render(input)).toMatchObject({ status: "ready", playbackUrl: "blob:compatibility-1", width: 1248, height: 1664 });
    h.unmount();
    expect(h.revoked).toEqual(["blob:compatibility-1"]); expect(h.subscriptions()).toBe(0);
});

test("role and cross-tab identity changes revoke completed display blobs", async () => {
    let calls = 0;
    const h = harness(async () => { calls++; return { blob: new Blob(["private"]) }; });
    const input = { assetId, originalUrl: "blob:original" };
    h.render(input); await settle();
    expect(h.render(input).status).toBe("ready");
    h.changeOwner("employee-a", "viewer");
    expect(h.revoked).toEqual(["blob:compatibility-1"]);
    expect(h.render(input).playbackUrl).toBeUndefined(); await settle();
    expect(h.render(input).playbackUrl).toBe("blob:compatibility-2");
    expect(calls).toBe(2);
    h.broadcastOwner("employee-b");
    expect(h.revoked).toEqual(["blob:compatibility-1", "blob:compatibility-2"]);
    h.unmount(); expect(h.subscriptions()).toBe(0);
});

test("read-only missing provenance keeps a local original without any server request", async () => {
    let calls = 0;
    const read: string[] = [];
    const h = harness(async () => { calls++; throw new Error("must not request or upload a local video"); }, async key => { read.push(key); return null; });
    const input = { originalUrl: `/api/assets/${assetId}/content`, storageKey: "video:local" };
    h.render(input); await settle();
    expect(h.render(input)).toMatchObject({ status: "local", playbackUrl: input.originalUrl });
    expect(calls).toBe(0); expect(read).toEqual(["video:local"]); expect(h.created).toEqual([]);
    h.unmount();
});

test("leaving interactive canvas mode cancels preparation without altering its original source", async () => {
    let signal!: AbortSignal;
    const h = harness(async (_id, options) => { signal = options.signal; return new Promise(() => {}); });
    const input = { assetId, originalUrl: "blob:original", storageKey: "video:original" };
    h.render(input); await settle();
    expect(h.render({ ...input, enabled: false }).status).toBe("idle");
    expect(signal.aborted).toBe(true);
    expect(input.originalUrl).toBe("blob:original");
    h.unmount(); expect(h.subscriptions()).toBe(0);
});
