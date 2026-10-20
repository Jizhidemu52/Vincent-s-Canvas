import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { canvasHistoryForSave } from "@/pages/canvas/use-canvas-history";
import { placeCanvasImageOutputs } from "@/lib/canvas/canvas-image-output-placement";
import { parseCanvasProject, serializeCanvasProject } from "@/lib/canvas/canvas-project-codec";
import { promptDestination, type PromptReusePayload, type PromptTargetTool } from "@/services/api/prompts";
import { CanvasNodeType } from "@/types/canvas";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type * as Reuse from "@/lib/prompt-template-reuse";
import type * as Insertion from "@/lib/canvas/prompt-canvas-insertion";

function load<T>(path: string, dependencies: Record<string, unknown>): T {
    const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS } }).outputText;
    const module = { exports: {} };
    new Function("require", "module", "exports", code)((name: string) => {
        if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
        return dependencies[name];
    }, module, module.exports);
    return module.exports as T;
}
const payload: PromptReusePayload = {
    template: {
        id: "template", currentVersionId: "version-8", version: 8, title: "完整模板", prompt: "完整提示词\n".repeat(2000),
        targetTool: "image-generation", scope: "team", ownerUserId: "author", groupId: "group", departmentId: null,
        modelConfigId: "original-config", modelSnapshot: { modelId: "original-model", name: "原模型" }, parameters: { quality: "high", count: 3, nested: { retain: true } },
        referenceAssetIds: ["accessible-asset"], sourceTaskId: "task", sourceAssetId: "asset", category: "", tags: [], notes: "",
        favorite: false, useCount: 0, lastUsedAt: null, createdAt: "", updatedAt: "",
    },
    mode: "fill", pricing: { operationType: "image.generate", modelChanged: true, reason: "disabled", selectedModel: { id: "enabled-config", name: "可用模型", modelId: "enabled-model" }, estimate: null, alternatives: [] },
    warnings: ["部分参考图已删除或当前无权访问"],
};
function project(): CanvasProject {
    return {
        id: "canvas", title: "原画布", createdAt: "original", updatedAt: "original",
        nodes: [{ id: "old-node", type: CanvasNodeType.Text, title: "旧文案", width: 420, height: 300, position: { x: 390, y: 250 }, metadata: { content: "保留" } }],
        groups: [{ id: "group", title: "原分组", nodeIds: ["old-node"], collapsed: false }],
        connections: [{ id: "edge", fromNodeId: "old-node", toNodeId: "else" }], chatSessions: [], activeChatId: null,
        backgroundMode: "dots", showImageInfo: true, viewport: { x: 0, y: 0, k: 1 }, history: { past: [], future: [] },
    };
}

function harness(options: { failResolve?: boolean; failHydrate?: boolean; failFlush?: boolean; onLoad?: () => void; onResolve?: () => void; onHydrate?: () => void; onFlush?: () => void } = {}) {
    let user = { status: "authenticated", user: { id: "owner-a", role: "designer" } };
    let alive = true, id = 0;
    const subscribers = new Set<(state: typeof user) => void>();
    const workspaceSubscribers = new Set<(owner: string | null) => void>();
    const steps: string[] = [], resolveCalls: unknown[][] = [], patches: unknown[] = [];
    const currentPayload = structuredClone(payload);
    const state = {
        hydrated: true, projects: [project()],
        openProject: (id: string) => state.projects.find(project => project.id === id) || null,
        createProject: (title: string) => { steps.push("create"); const next = { ...project(), id: "new", title, nodes: [], groups: [], connections: [], history: undefined }; state.projects.push(next); return next.id; },
        updateProject: (id: string, patch: unknown) => { steps.push("append"); patches.push(patch); state.projects = state.projects.map(project => project.id === id ? { ...project, ...patch as object } : project); },
    };
    const dependencies: Record<string, unknown> = {
        "@/lib/deployment-features": { deploymentFeatures: { authenticationEnabled: true } },
        "@/stores/use-user-store": { useUserStore: { getState: () => user, subscribe: (listener: (state: typeof user) => void) => { subscribers.add(listener); return () => subscribers.delete(listener); } } },
        "@/lib/workspace-session-events": { subscribeWorkspaceIdentity: (listener: (owner: string | null) => void) => { workspaceSubscribers.add(listener); return () => workspaceSubscribers.delete(listener); } },
        "@/services/api/prompts": {
            resolvePromptReuse: async (...args: unknown[]) => { steps.push("resolve"); resolveCalls.push(args); options.onResolve?.(); if (options.failResolve) throw new Error("permission denied"); return { reuseToken: "short-token" }; },
            hydratePromptReuse: async () => { steps.push("hydrate"); options.onHydrate?.(); if (options.failHydrate) throw new Error("expired token"); return currentPayload; },
        },
        nanoid: { nanoid: () => `inserted-${++id}` },
        "@/lib/canvas/canvas-image-output-placement": { placeCanvasImageOutputs },
        "@/pages/canvas/use-canvas-history": { canvasHistoryForSave },
        "@/types/canvas": { CanvasNodeType },
        "@/stores/canvas/use-canvas-store": {
            useCanvasStore: { getState: () => state },
            loadCanvasProject: async (id: string) => { steps.push("load"); options.onLoad?.(); return state.openProject(id); },
            flushCanvasPersistence: async () => { steps.push("flush"); options.onFlush?.(); if (options.failFlush) throw new Error("disk full"); },
        },
    };
    const reuse = load<typeof Reuse>("../src/lib/prompt-template-reuse.ts", dependencies);
    dependencies["@/lib/prompt-template-reuse"] = reuse;
    const insertion = load<typeof Insertion>("../src/lib/canvas/prompt-canvas-insertion.ts", dependencies);
    const start = (target: string | undefined = "canvas") => {
        const guard = reuse.createPromptActionGuard(reuse.promptActionIdentity(), () => alive);
        return insertion.insertPromptIntoCanvas("template", target, guard.assert).finally(guard.dispose);
    };
    return {
        ...reuse, ...insertion, start, state, steps, patches, resolveCalls, payload: currentPayload,
        close: () => { alive = false; }, subscriberCount: () => subscribers.size + workspaceSubscribers.size,
        setOwner: (id: string, role = "designer") => { user = { status: "authenticated", user: { id, role } }; subscribers.forEach(listener => listener(user)); },
        broadcast: (id: string | null) => workspaceSubscribers.forEach(listener => listener(id)),
    };
}

test("insertion authorizes and hydrates the complete template, preserving original graph and template provenance", async () => {
    const h = harness(), before = h.state.projects[0];
    expect(await h.start()).toEqual({ projectId: "canvas", nodeId: "inserted-1", warnings: payload.warnings });
    const after = h.state.projects[0], node = after.nodes[1];
    expect(h.steps).toEqual(["load", "resolve", "hydrate", "append", "flush"]);
    expect(h.resolveCalls).toEqual([["template", "fill"]]);
    expect(node.type).toBe(CanvasNodeType.Text);
    expect(node.metadata?.content).toBe(payload.template.prompt);
    expect(node.metadata?.promptTemplateSource).toMatchObject({
        templateId: "template", versionId: "version-8", version: 8, parameters: payload.template.parameters,
        referenceAssetIds: ["accessible-asset"], modelConfigId: "original-config", modelSnapshot: payload.template.modelSnapshot,
        resolvedModel: payload.pricing.selectedModel, sourceTaskId: "task", sourceAssetId: "asset",
    });
    expect(node.metadata?.generationMode).toBeUndefined();
    expect(node.metadata?.model).toBeUndefined();
    for (const key of ["groups", "connections", "chatSessions"] as const) expect(after[key]).toBe(before[key]);
    expect(after.nodes[0]).toBe(before.nodes[0]);
    expect(node.position.y).toBeGreaterThan(before.nodes[0].position.y + before.nodes[0].height);
    expect(after.viewport.x + (node.position.x + node.width / 2) * after.viewport.k).toBe(600);
    expect(after.viewport.y + (node.position.y + node.height / 2) * after.viewport.k).toBe(400);
    expect(h.subscriberCount()).toBe(0);
});

test("inserted text and undo snapshot survive the real persistence codec without nested project/history fields", async () => {
    const h = harness(); await h.start();
    const restored = parseCanvasProject(serializeCanvasProject(h.state.projects[0]));
    const previous = restored.history!.past.pop()!;
    expect(previous.nodes.map(node => node.id)).toEqual(["old-node"]);
    expect(Object.keys(previous)).not.toContain("history");
    expect(Object.keys(previous)).not.toContain("id");
    const nextHistory = canvasHistoryForSave({ past: [], future: [restored] }, restored, previous, true);
    expect(nextHistory.future[0].nodes[1].metadata?.content).toBe(payload.template.prompt);
    expect(restored.nodes[1].metadata?.promptTemplateSource?.parameters).toEqual(payload.template.parameters);
});

test("all target tools become ordinary editable text instead of unsupported or automatically running config nodes", async () => {
    for (const target of ["image-generation", "detail-enhance", "image-edit", "angle-control", "batch-edit", "seamless-stitch", "video", "canvas"] as PromptTargetTool[]) {
        const h = harness(); h.payload.template.targetTool = target;
        await h.start();
        expect(h.state.projects[0].nodes[1].type).toBe(CanvasNodeType.Text);
        expect(h.state.projects[0].nodes[1].metadata?.promptTemplateSource?.targetTool).toBe(target);
    }
});

test("new drafts are created only after permission and complete content are available", async () => {
    const h = harness(); const guard = h.createPromptActionGuard(h.promptActionIdentity());
    await h.insertPromptIntoCanvas("template", undefined, guard.assert); guard.dispose();
    expect(h.steps).toEqual(["resolve", "hydrate", "create", "append", "flush"]);
    expect(h.state.projects[1].title).toBe("完整模板 · 提示词草稿");
    expect(h.state.projects[1].history?.past[0].nodes).toHaveLength(0);
    for (const failure of ["failResolve", "failHydrate"] as const) {
        const failed = harness({ [failure]: true });
        await expect(failed.start()).rejects.toThrow();
        expect(failed.patches).toHaveLength(0);
        expect(failed.steps).not.toContain("create");
    }
});

test("latest graph is read after lazy loading and concurrent edits, including a bounded undo stack", async () => {
    const h = harness({ onHydrate: () => {
        const current = h.state.projects[0];
        h.state.projects[0] = { ...current, title: "并发改名", nodes: [...current.nodes, { ...current.nodes[0], id: "concurrent", position: { x: 2000, y: 2000 } }], history: { past: Array.from({ length: 55 }, () => ({ ...current, history: undefined })), future: [current] } };
    } });
    await h.start();
    expect(h.state.projects[0].nodes.map(node => node.id)).toEqual(["old-node", "concurrent", "inserted-1"]);
    expect(h.state.projects[0].title).toBe("并发改名");
    expect(h.state.projects[0].history?.past).toHaveLength(50);
    expect(h.state.projects[0].history?.future).toHaveLength(0);
});

test("missing/deleted targets, empty prompts, unavailable stores and administrators never create a replacement canvas", async () => {
    const missing = harness(); await expect(missing.start("missing")).rejects.toThrow("不存在");
    const deleted = harness({ onHydrate: () => { deleted.state.projects = []; } }); await expect(deleted.start()).rejects.toThrow("已被删除");
    const unready = harness(); unready.state.hydrated = false; await expect(unready.start()).rejects.toThrow("仍在加载");
    const empty = harness(); empty.payload.template.prompt = " "; await expect(empty.start()).rejects.toThrow("为空");
    const admin = harness(); admin.setOwner("admin", "super_admin"); await expect(admin.start()).rejects.toThrow("设计师");
    for (const h of [missing, deleted, unready, empty, admin]) { expect(h.patches).toHaveLength(0); expect(h.steps).not.toContain("create"); }
});

test("identity changes, including A-B-A and cross-tab changes, cannot insert stale content", async () => {
    for (const point of ["onLoad", "onResolve", "onHydrate"] as const) {
        for (const change of ["owner", "roundtrip", "broadcast", "close"] as const) {
            const h = harness({ [point]: () => {
                if (change === "close") h.close();
                else if (change === "broadcast") h.broadcast("owner-b");
                else { h.setOwner("owner-b"); if (change === "roundtrip") h.setOwner("owner-a"); }
            } });
            await expect(h.start()).rejects.toThrow("已取消");
            expect(h.patches).toHaveLength(0); expect(h.steps).not.toContain("create");
            expect(h.subscriberCount()).toBe(0);
        }
    }
});

test("save failures expose the recoverable project rather than success, and late changes cannot navigate stale results", async () => {
    const h = harness({ failFlush: true });
    const error = await h.start().catch(error => error);
    expect(error).toBeInstanceOf(h.PromptCanvasPersistenceError);
    expect(error.projectId).toBe("canvas");
    expect(error.message).toContain("不要重复插入");
    expect(h.state.projects[0].nodes).toHaveLength(2);
    const switched = harness({ onFlush: () => switched.setOwner("other") });
    await expect(switched.start()).rejects.toThrow("已取消");
    const deleted = harness({ onFlush: () => { deleted.state.projects = []; } });
    await expect(deleted.start()).rejects.toThrow("未完成插入");
});

test("generation-page routing uses the hydrated target and only a short token, never full prompt or model submission", async () => {
    const h = harness(); h.payload.template.targetTool = "video";
    const guard = h.createPromptActionGuard(h.promptActionIdentity());
    const result = await h.resolveCompletePrompt("template", "fill", guard.assert); guard.dispose();
    expect(promptDestination(result.template.targetTool, result.reuseToken)).toBe("/video?reuseToken=short-token");
    expect(h.steps).toEqual(["resolve", "hydrate"]);
    expect(h.resolveCalls).toEqual([["template", "fill"]]);
    expect(h.patches).toHaveLength(0);
});
