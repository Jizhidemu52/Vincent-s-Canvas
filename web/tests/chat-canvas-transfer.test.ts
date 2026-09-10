import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

import { applyCanvasProjectPatch, type CanvasProjectPatch } from "@/lib/canvas/canvas-project-update";
import { collectProjectChanges, createProjectChangeBuffer, mergeProjectChanges } from "@/lib/canvas/canvas-persistence-merge";
import { createChatSessionStorage } from "@/pages/chat/chat-session-storage";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

type GeneratedImage = { id: string; dataUrl: string; prompt?: string; modelId?: string };
type Session = { id: string; title: string; messages: unknown[]; canvasProjectId?: string };

// Execute the page handler itself. Only browser IO/navigation and the storage
// boundary are substituted; project patch/merge/retry and session ordering stay real.
const source = readFileSync(new URL("../src/pages/chat/index.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("chat.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let initializer: ts.Expression | undefined;
const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "placeImageOnCanvas") initializer = node.initializer;
    ts.forEachChild(node, visit);
};
visit(ast);
if (!initializer) throw new Error("The actual chat-to-canvas handler was not found");
const handlerCode = ts.transpileModule(`exports.place = ${initializer.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

const originalBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7, 42, 99, 18]);
const image: GeneratedImage = {
    id: "result-1",
    dataUrl: "/api/assets/original-result/content",
    prompt: "保留中文“春日”和 20cm 宽度，只将花瓣改细。",
    modelId: "gpt-image-2.5-flare",
};

function canvasProject(id: string, nodes: CanvasNodeData[] = []): CanvasProject {
    return {
        id, title: "Existing canvas", createdAt: "original", updatedAt: "original", nodes,
        connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots",
        showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
    };
}

function pageCanvasHarness(options: {
    canvasFailures?: number;
    sessionFailures?: number;
    project?: CanvasProject;
    fetchGate?: Promise<void>;
    flushGate?: Promise<void>;
    sessionGate?: Promise<void>;
    dimensions?: { width: number; height: number };
    hydrated?: boolean;
} = {}) {
    const events: string[] = [];
    const errors: string[] = [];
    const uploaded: Blob[] = [];
    const navigations: string[] = [];
    const sessionsRef = { current: [{ id: "session-1", title: "春日花卉", messages: [], ...(options.project ? { canvasProjectId: options.project.id } : {}) }] as Session[] };
    const dimensions = options.dimensions || { width: 4096, height: 2048 };
    let projectCreations = 0;
    let canvasFailures = options.canvasFailures || 0;
    let sessionFailures = options.sessionFailures || 0;
    let canvasWriteQueued = false;
    let lastCanvasError: unknown;
    let pendingChanges = new Map<string, CanvasProject | null>();
    const writeBuffer = createProjectChangeBuffer<CanvasProject>();
    let persistedProjects = options.project ? [structuredClone(options.project)] : [];
    const sessionDatabase = new Map<string, Session[]>();
    const sessionStorage = createChatSessionStorage({
        async getItem<T>(key: string) { return structuredClone(sessionDatabase.get(key) ?? null) as T | null; },
        async setItem<T>(key: string, value: T) {
            events.push("session-write");
            if (sessionFailures-- > 0) throw new Error("session write failed");
            sessionDatabase.set(key, structuredClone(value) as Session[]);
            return value;
        },
    });
    const state = {
        hydrated: options.hydrated !== false,
        projects: options.project ? [options.project] : [] as CanvasProject[],
        createProject(title: string) {
            const project = { ...canvasProject(`canvas-${++projectCreations}`), title };
            replaceProjects([project, ...state.projects]);
            events.push("create-project");
            return project.id;
        },
        openProject(id: string) { return state.projects.find((project) => project.id === id) || null; },
        updateProject(id: string, patch: CanvasProjectPatch) {
            const index = state.projects.findIndex((project) => project.id === id);
            if (index < 0) return;
            const next = applyCanvasProjectPatch(state.projects[index]!, patch);
            if (next === state.projects[index]) return;
            const projects = [...state.projects];
            projects[index] = next;
            replaceProjects(projects);
        },
    };
    function replaceProjects(projects: CanvasProject[]) {
        collectProjectChanges(state.projects, projects, pendingChanges);
        state.projects = projects;
        canvasWriteQueued = true;
    }
    const bindings = {
        sessionsReady: true,
        activeSession: sessionsRef.current[0]!,
        sendingRef: { current: false },
        placingImageRef: { current: false },
        loadedStorageKeyRef: { current: "user-a" },
        storageKey: "user-a",
        useCanvasStore: { getState: () => state },
        CanvasNodeType,
        sessionsRef,
        setPlacingImage(value: boolean) { events.push(`placing:${value}`); },
        message: { warning(value: string) { errors.push(value); }, error(value: string) { errors.push(value); } },
        sessionTitle(session: Session) { return session.title; },
        async fetch(url: string) {
            events.push(`read:${url}`);
            await options.fetchGate;
            return new Response(originalBytes, { headers: { "content-type": "image/png" } });
        },
        async uploadImage(blob: Blob) {
            uploaded.push(blob);
            events.push("store-image");
            return { ...dimensions, bytes: blob.size, mimeType: blob.type, storageKey: `image:stored-${uploaded.length}`, url: `blob:local-${uploaded.length}` };
        },
        updateSession(id: string, update: (session: Session) => Session) {
            sessionsRef.current = sessionsRef.current.map((session) => session.id === id ? update(session) : session);
        },
        async flushCanvasPersistence() {
            // Match the real queue: a failed flush does not itself enqueue a
            // retry. A new immutable project patch must trigger that write.
            if (canvasWriteQueued) {
                canvasWriteQueued = false;
                const changes = pendingChanges;
                pendingChanges = new Map();
                try {
                    await writeBuffer.write(changes, async (retainedChanges) => {
                        events.push("canvas-write");
                        if (canvasFailures-- > 0) throw new Error("canvas write failed");
                        persistedProjects = structuredClone(mergeProjectChanges(persistedProjects, retainedChanges));
                    });
                    lastCanvasError = null;
                } catch (error) { lastCanvasError = error; }
            }
            if (lastCanvasError) throw lastCanvasError;
            await options.flushGate;
        },
        persistence: { clear() { events.push("clear-session-queue"); } },
        async persistSessions(value: Session[]) { await sessionStorage.save("user-a", value); await options.sessionGate; },
        navigate(path: string) { navigations.push(path); },
    };
    const place = (generated = image) => {
        // A later click uses the updated React session snapshot. Concurrent
        // handlers still share the synchronous ref that prevents duplication.
        bindings.activeSession = sessionsRef.current[0]!;
        const exports = {} as { place: (value: GeneratedImage) => Promise<void> };
        new Function(...Object.keys(bindings), "exports", handlerCode)(...Object.values(bindings), exports);
        return exports.place(generated);
    };
    return { place, state, sessionsRef, events, errors, uploaded, navigations, bindings, persistedProjects: () => persistedProjects, sessionDatabase, projectCreations: () => projectCreations };
}

describe("actual chat-to-canvas transfer", () => {
    test("retry after the first canvas write failure keeps the same project, node and original image blob", async () => {
        const page = pageCanvasHarness({ canvasFailures: 1 });
        await page.place();
        expect(page.errors).toEqual(["canvas write failed"]);
        expect(page.navigations).toEqual([]);
        expect(page.sessionsRef.current[0]!.canvasProjectId).toBe("canvas-1");
        expect(page.persistedProjects()).toEqual([]);
        expect(page.sessionDatabase.size).toBe(0);

        await page.place();
        expect(page.projectCreations()).toBe(1);
        expect(page.uploaded).toHaveLength(1);
        expect(page.state.projects).toHaveLength(1);
        expect(page.state.projects[0]!.nodes.map((node) => node.id)).toEqual(["chat-image:result-1"]);
        expect(page.persistedProjects()[0]!.nodes).toHaveLength(1);
        expect(page.sessionDatabase.get("user-a")![0]!.canvasProjectId).toBe("canvas-1");
        expect(page.events.filter((event) => event === "canvas-write")).toHaveLength(2);
        expect(page.navigations).toEqual(["/canvas/canvas-1"]);
    });

    test("retry after session persistence fails reuses the already-saved canvas and original blob", async () => {
        const page = pageCanvasHarness({ sessionFailures: 1 });
        await page.place();
        expect(page.errors).toEqual(["session write failed"]);
        expect(page.persistedProjects()).toHaveLength(1);
        expect(page.navigations).toEqual([]);
        await page.place();
        expect(page.projectCreations()).toBe(1);
        expect(page.uploaded).toHaveLength(1);
        expect(page.persistedProjects()).toHaveLength(1);
        expect(page.persistedProjects()[0]!.nodes).toHaveLength(1);
        expect(page.sessionDatabase.get("user-a")![0]!.canvasProjectId).toBe("canvas-1");
        expect(page.navigations).toEqual(["/canvas/canvas-1"]);
    });

    test("an existing linked project retries its failed write rather than getting stuck on the previous error", async () => {
        const page = pageCanvasHarness({ project: canvasProject("existing"), canvasFailures: 1 });
        await page.place();
        await page.place();
        expect(page.projectCreations()).toBe(0);
        expect(page.uploaded).toHaveLength(1);
        expect(page.events.filter((event) => event === "canvas-write")).toHaveLength(2);
        expect(page.persistedProjects()[0]!.id).toBe("existing");
        expect(page.persistedProjects()[0]!.nodes.map((node) => node.id)).toEqual(["chat-image:result-1"]);
        expect(page.navigations).toEqual(["/canvas/existing"]);
    });

    test("repeated clicks on an already-imported image do not read, upload or add it again", async () => {
        const page = pageCanvasHarness();
        await page.place();
        const originalNode = page.state.projects[0]!.nodes[0]!;
        await page.place();
        await page.place();
        expect(page.events.filter((event) => event.startsWith("read:"))).toHaveLength(1);
        expect(page.projectCreations()).toBe(1);
        expect(page.uploaded).toHaveLength(1);
        expect(page.state.projects[0]!.nodes).toEqual([originalNode]);
    });

    test("simultaneous clicks share the synchronous guard before the first image read completes", async () => {
        const gate = Promise.withResolvers<void>();
        const page = pageCanvasHarness({ fetchGate: gate.promise });
        const first = page.place();
        await page.place();
        expect(page.events.filter((event) => event.startsWith("read:"))).toHaveLength(1);
        expect(page.bindings.placingImageRef.current).toBe(true);
        gate.resolve();
        await first;
        expect(page.projectCreations()).toBe(1);
        expect(page.uploaded).toHaveLength(1);
        expect(page.state.projects[0]!.nodes).toHaveLength(1);
        expect(page.bindings.placingImageRef.current).toBe(false);
    });

    test.each([
        [{ width: 4096, height: 2048 }, { width: 640, height: 320 }],
        [{ width: 320, height: 960 }, { width: 320, height: 960 }],
    ])("preserves original bytes, aspect ratio and generation metadata for %j", async (dimensions, display) => {
        const page = pageCanvasHarness({ dimensions });
        await page.place();
        expect(new Uint8Array(await page.uploaded[0]!.arrayBuffer())).toEqual(originalBytes);
        const node = page.persistedProjects()[0]!.nodes[0]!;
        expect({ width: node.width, height: node.height }).toEqual(display);
        expect(node.metadata).toMatchObject({
            content: "blob:local-1", storageKey: "image:stored-1", status: "success",
            naturalWidth: dimensions.width, naturalHeight: dimensions.height,
            bytes: originalBytes.byteLength, mimeType: "image/png", prompt: image.prompt,
            model: "gpt-image-2.5-flare", imageVersion: 1,
        });
    });

    test("does not read or create anything before the canvas store is hydrated", async () => {
        const page = pageCanvasHarness({ hydrated: false });
        await page.place();
        expect(page.errors).toHaveLength(1);
        expect(page.events).toEqual([]);
        expect(page.state.projects).toEqual([]);
    });

    test("an account switch while flushing the canvas cannot save account B sessions under account A", async () => {
        const gate = Promise.withResolvers<void>();
        const page = pageCanvasHarness({ flushGate: gate.promise });
        const transfer = page.place();
        for (let turn = 0; turn < 30 && !page.events.includes("canvas-write"); turn += 1) await Promise.resolve();
        expect(page.events).toContain("canvas-write");
        page.bindings.loadedStorageKeyRef.current = "user-b";
        page.sessionsRef.current = [{ id: "account-b-session", title: "B private history", messages: [] }];
        gate.resolve();
        await transfer;
        expect(page.sessionDatabase.size).toBe(0);
        expect(page.navigations).toEqual([]);
        expect(page.sessionsRef.current).toEqual([{ id: "account-b-session", title: "B private history", messages: [] }]);
    });

    test("an account switch while saving the session prevents navigation into the previous account's canvas", async () => {
        const gate = Promise.withResolvers<void>();
        const page = pageCanvasHarness({ sessionGate: gate.promise });
        const transfer = page.place();
        for (let turn = 0; turn < 30 && !page.events.includes("session-write"); turn += 1) await Promise.resolve();
        expect(page.events).toContain("session-write");
        page.bindings.loadedStorageKeyRef.current = "user-b";
        page.sessionsRef.current = [{ id: "account-b-session", title: "B private history", messages: [] }];
        gate.resolve();
        await transfer;
        expect(page.sessionDatabase.get("user-a")![0]!.id).toBe("session-1");
        expect(page.sessionDatabase.get("user-a")![0]!.canvasProjectId).toBe("canvas-1");
        expect(page.navigations).toEqual([]);
    });
});
