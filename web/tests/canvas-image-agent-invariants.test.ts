import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { applyCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { canvasImageAgentCatalog, canvasImageAgentResultOps, prepareCanvasImageAgentRepairPreviews, resolveCanvasImageAgentEdit, type CanvasImageAgentImage, type CanvasImageAgentRecord } from "@/lib/canvas/canvas-image-agent";
import { ImageAgentPlanningError } from "../../shared/image-agent-iteration";
import { pendingOnlineAgentTask, recoverOnlineAgentTask, type PendingOnlineAgentTask } from "@/lib/canvas/canvas-online-task-recovery";
import { originalImageAgentImage } from "@/lib/image-agent/focus";
import { buildImageAgentContext } from "@/lib/image-agent/context";
import { CanvasNodeType, type CanvasAssistantSession, type CanvasNodeData } from "@/types/canvas";
import { QueuedTaskFailedError, type QueuedTask } from "@/services/api/generation-tasks";

const node = (id: string, x = 0): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x, y: 20 }, width: 180, height: 120, metadata: { storageKey: `image:${id}` } });
const snapshot = (nodes = [node("original"), node("chosen", 500)], selectedNodeIds = ["chosen"]): CanvasAgentSnapshot => ({ projectId: "project", title: "Canvas", nodes, selectedNodeIds, connections: [], viewport: { x: 0, y: 0, k: 1 } });
const image = (id: string, label: string, extra: Partial<CanvasImageAgentImage> = {}): CanvasImageAgentImage => ({
    id, label, name: id, kind: "upload", nodeId: id, storageKey: `image:${id}`,
    reference: { id, title: id, type: CanvasNodeType.Image, storageKey: `image:${id}` }, ...extra,
});
const catalog = () => [image("original", "图3"), image("current", "图8", { kind: "generated", parentId: "original", workId: "work", note: { summary: "红色衬衫", keep: ["版型不变"] } }), image("color", "图12")];
const selection = { focusId: "current", previewedIds: ["current", "original", "color"], focusRevision: 4 };

describe("canvas image-agent execution invariants", () => {
    test("locked base wins over model directions and keeps persisted source identities", () => {
        const result = resolveCanvasImageAgentEdit({ base: "original", references: ["图12"], prompt: "参考配色" }, catalog(), { ...selection, lockedImageId: "current" });
        expect(result.base?.id).toBe("current");
        expect(result.references.map(item => item.id)).toEqual(["current", "color"]);
        expect(result.references.map(item => item.storageKey)).toEqual(["image:current", "image:color"]);
        expect(result.record).toMatchObject({ baseImageId: "current", sourceNodeId: "current", focusRevision: 4, workId: "work" });
        expect(result.record.note.keep).toEqual(["版型不变"]);
    });

    test("original is reachable after automatic focus changes without a user lock", () => {
        expect(resolveCanvasImageAgentEdit({ base: "original", prompt: "回原图改色" }, catalog(), selection).base?.id).toBe("original");
        expect(resolveCanvasImageAgentEdit({ prompt: "开始新作品" }, catalog(), { ...selection, newCreation: true }).references).toEqual([]);
    });

    test("an explicit empty keep clears old constraints; omitted keep inherits", () => {
        const cleared = resolveCanvasImageAgentEdit({ prompt: "换版型", keep: [], note_update: "新款宽松衬衫" }, catalog(), selection);
        expect(cleared.record.note).toEqual({ summary: "新款宽松衬衫", keep: [] });
        expect(cleared.prompt).not.toContain("版型不变");
        const inherited = resolveCanvasImageAgentEdit({ prompt: "换蓝色" }, catalog(), selection);
        expect(inherited.prompt).toContain("版型不变");
    });

    test.each(["planner", "inherited"] as const)("%s relative keep is scoped to the chosen base state, not another 1.2x edit", origin => {
        // The live case established this textual ambiguity, not a measured pixel change.
        const polluted = ["提手宽度（图3的1.2倍宽度）、长度、弧度、位置"];
        const source = image("bag-v3", "图3", { kind: "generated", note: {
            summary: "基于图2继续：包身改为深绿色，提手保持宝蓝色且保留当前1.2倍宽度。",
            keep: origin === "inherited" ? polluted : ["两根提手保持宝蓝色，宽度、长度、弧度、位置不变"],
        } });
        const before = structuredClone(source);
        const current = "只把图3背景改成浅米色，提手宽度保持图3当前状态。";
        const result = resolveCanvasImageAgentEdit({ base: "图3", prompt: current, ...(origin === "planner" ? { keep: polluted } : {}),
            edit_spec: { changes: ["背景改成浅米色"] } }, [source], { focusId: source.id, previewedIds: [source.id] });
        expect(result.base?.id).toBe(source.id);
        expect(result.references.map(item => item.storageKey)).toEqual(["image:bag-v3"]);
        expect(result.prompt).toContain("输入图1对应图3（修改底图）");
        expect(result.prompt).toContain(current);
        expect(result.prompt).toContain("修改底图当前可见状态");
        expect(result.prompt).toContain("历史加宽、缩短、旋转");
        expect(result.prompt).toContain("不作为本轮增量");
        expect(result.prompt).toContain("发生歧义时保持底图现状");
        // Retain the original requirement record: no numeric stripping or invented rewrite.
        expect(result.record.note.keep).toEqual(polluted);
        expect(result.prompt).toContain(polluted[0]!);
        expect(result.record.spec?.changes).toEqual(["背景改成浅米色"]);
        expect(source).toEqual(before);
    });

    test("an explicit new relative edit and legitimate static numeric constraints remain intact", () => {
        const current = "在图3当前宽度基础上，再次把提手加宽1.2倍，并顺时针旋转10度。";
        const keep = ["缝线间距3mm", "保留2颗纽扣", "包身长宽比1.2:1"];
        const changes = ["提手在图3当前宽度基础上再次加宽1.2倍", "顺时针旋转10度"];
        const source = image("bag-v3", "图3");
        const result = resolveCanvasImageAgentEdit({ prompt: current, keep, edit_spec: { changes } }, [source], { focusId: source.id });
        expect(result.prompt).toContain(current);
        expect(result.record.spec?.changes).toEqual(changes);
        expect(result.record.note.keep).toEqual(keep);
        for (const constraint of keep) expect(result.prompt).toContain(constraint);
        expect(result.prompt).toContain("本轮明确要求的变化优先");
        expect(result.prompt).toContain("明确要求再次变化时仍执行");
        expect(result.prompt).toContain("静态尺寸、数量和比例原样保留");
    });

    test("historical relative values stay attributed as context before the current instruction", async () => {
        const note = { summary: "图3提手已按原图1.2倍宽度提出修改，尚未测量验收。", keep: ["提手宽度不变"] };
        const before = structuredClone(note);
        const currentText = "只把图3背景改成浅米色，保持图3当前提手宽度。";
        const context = await buildImageAgentContext({ images: [image("bag-v3", "图3", { note })], history: [], focusId: "bag-v3", note,
            currentText, readImage: async () => "data:image/png;base64,AA==" });
        expect(context.messages.at(-1)?.content).toBe(currentText);
        const content = context.messages.flatMap(message => typeof message.content === "string" ? [] : message.content)
            .filter(part => part.type === "text").map(part => part.text).join("\n");
        expect(content).toContain("不代表视觉验收");
        expect(content).toContain("历史相对变化不是本轮增量");
        expect(content).toContain("本轮所选底图当前可见状态");
        expect(content).toContain(note.summary);
        expect(context.profileContext.workNote).toContain(note.summary);
        expect(note).toEqual(before);
    });

    test("the 400-character keep contract is shared with the server and chat surface", () => {
        const keep = "保".repeat(400);
        expect(resolveCanvasImageAgentEdit({ prompt: "换蓝色", keep: [keep] }, catalog(), selection).record.note.keep).toEqual([keep]);
    });

    test("the actual submitted image order is mapped to stable conversation labels", () => {
        const result = resolveCanvasImageAgentEdit({ prompt: "把图8改成图12的颜色", references: ["图12"] }, catalog(), selection);
        expect(result.prompt).toMatch(/输入图1[^\n]*图8[^\n]*底图/);
        expect(result.prompt).toMatch(/输入图2[^\n]*图12[^\n]*参考/);
    });

    test("the assembled prompt cannot exceed the server limit after adding retained requirements", () => {
        expect(() => resolveCanvasImageAgentEdit({ prompt: "改".repeat(20_000), keep: ["保留版型"] }, catalog(), selection)).toThrow();
    });

    test("missing or unpreviewed sources never fall back to unrelated images", () => {
        expect(() => resolveCanvasImageAgentEdit({ prompt: "改色", base: "missing" }, catalog(), selection)).toThrow();
        expect(() => resolveCanvasImageAgentEdit({ prompt: "改色", references: ["图12"] }, catalog(), { ...selection, previewedIds: ["current"] })).toThrow();
    });

    test("late result operations preserve the current selection in the real reducer", () => {
        const before = snapshot();
        const original = structuredClone(before);
        const record: CanvasImageAgentRecord = { sourceNodeId: "original", baseImageId: "original", workId: "work", referenceIds: ["original"], note: { summary: "蓝色", keep: [] }, focusRevision: 1 };
        const ops: CanvasAgentOp[] = [{ type: "add_node", nodeType: CanvasNodeType.Image, id: "result", width: 180, height: 120, metadata: { storageKey: "image:result" } }, { type: "select_nodes", ids: ["result"] }];
        const after = applyCanvasAgentOps(before, canvasImageAgentResultOps(ops, before, record, false));
        expect(after.selectedNodeIds).toEqual(["chosen"]);
        const added = after.nodes.find(item => item.id === "result")!;
        expect(added.position.x).toBeGreaterThanOrEqual(180);
        expect(added.metadata?.imageAgent).toMatchObject({ parentNodeId: "original", workId: "work", version: 2, note: record.note });
        expect(after.connections.some(edge => edge.fromNodeId === "original" && edge.toNodeId === "result")).toBe(true);
        expect(before).toEqual(original);
    });

    test("recovered duplicate result nodes are not inserted again", () => {
        const before = snapshot([node("original"), node("result")], ["original"]);
        const record: CanvasImageAgentRecord = { sourceNodeId: "original", referenceIds: ["original"], note: { summary: "蓝色", keep: [] } };
        const ops = canvasImageAgentResultOps([{ type: "add_node", nodeType: CanvasNodeType.Image, id: "result" }], before, record, false);
        expect(ops.filter(op => op.type === "add_node")).toEqual([]);
    });

    test("selecting an old canvas result keeps its original chain without unrelated viewport media", () => {
        const root = node("original"), next = node("result"), unrelated = node("unrelated");
        next.metadata!.imageAgent = { parentNodeId: root.id, workId: "work", version: 2, note: { summary: "蓝色", keep: [] } };
        const images = canvasImageAgentCatalog([], [root, next, unrelated], [{ id: next.id, type: CanvasNodeType.Image, title: next.title, storageKey: "image:result" }]);
        expect(images.map(item => item.nodeId)).toEqual(["original", "result"]);
        expect(originalImageAgentImage(images, images[1]!).nodeId).toBe("original");
    });

    test.each(["draft", "conversation"])("a deleted ancestor remains missing when an old result enters a new chat through %s", mode => {
        const next = node("result");
        next.metadata!.imageAgent = { parentNodeId: "deleted-original", workId: "work", version: 2, note: { summary: "蓝色", keep: [] } };
        const reference = { id: next.id, type: CanvasNodeType.Image, title: next.title, storageKey: "image:result" };
        const images = mode === "draft"
            ? canvasImageAgentCatalog([], [next], [reference])
            : canvasImageAgentCatalog([{ id: "new-chat-turn", role: "user", text: "查看这张图", references: [reference] }], [next]);
        const current = images[0]!;
        const selection = { focusId: current.id, previewedIds: [current.id] };
        expect(images).toHaveLength(1);
        expect(current.parentId).toBe("canvas-image:deleted-original");
        expect(resolveCanvasImageAgentEdit({ base: "focus", prompt: "继续改当前图" }, images, selection).base?.nodeId).toBe("result");
        expect(() => resolveCanvasImageAgentEdit({ base: "original", prompt: "回原图修改" }, images, selection)).toThrow("原图已不可用");
        expect(() => resolveCanvasImageAgentEdit({ base: "previous", prompt: "回上一版修改" }, images, selection)).toThrow("重新选择");
    });
});

describe("canvas image-agent repair preview bounds", () => {
    const issue = (requiredImageIds = ["original", "color"], missingImageIds = ["original"]) => new ImageAgentPlanningError(
        "IMAGE_AGENT_UNPREVIEWED_IMAGE", "需要先查看指定图片", { missingImageIds, requiredImageIds });
    const pixel = (id: string) => `data:image/png;base64,${Buffer.from(`pixels:${id}`).toString("base64")}`;

    test("only a fully legal plan reports canonical missing and required image identities", () => {
        try {
            resolveCanvasImageAgentEdit({ base: "图3", references: ["图12"], prompt: "原图改色" }, catalog(), { ...selection, previewedIds: ["current", "color"] });
            throw new Error("Expected an unpreviewed-image refusal");
        } catch (error) {
            expect(error).toMatchObject({ code: "IMAGE_AGENT_UNPREVIEWED_IMAGE", missingImageIds: ["original"], requiredImageIds: ["original", "color"], submitted: false });
        }
        try {
            resolveCanvasImageAgentEdit({ base: "图3", prompt: "原图改色", edit_spec: { changes: [] } }, catalog(), { ...selection, previewedIds: ["current"] });
            throw new Error("Expected an invalid-spec refusal");
        } catch (error) {
            expect(error).toMatchObject({ code: "IMAGE_AGENT_SPEC_INVALID", submitted: false });
            expect((error as ImageAgentPlanningError).missingImageIds).toBeUndefined();
        }
    });

    test("required original pixels precede the focus and do not mutate source identities or notes", async () => {
        const images = catalog(), before = structuredClone(images), read: string[] = [];
        const result = await prepareCanvasImageAgentRepairPreviews(issue(), images, { focusId: "current", previewedIds: ["current", "color"],
            readImage: async value => { read.push(value.id); return pixel(value.id); } });
        expect(read).toEqual(["original", "color", "current"]);
        expect(result?.previews).toEqual(read.map(id => ({ id, dataUrl: pixel(id) })));
        expect(result?.details.imageIds).toEqual(read);
        expect(images).toEqual(before);
    });

    test("five required images keep all exact references without treating unchanged focus identity as a sixth pixel", async () => {
        const images = Array.from({ length: 7 }, (_, index) => image(`v${index + 1}`, `图${index + 1}`));
        const required = images.slice(0, 5).map(value => value.id), read: string[] = [];
        const result = await prepareCanvasImageAgentRepairPreviews(issue(required, required), images, { focusId: "v6", previewedIds: ["v6", "v7"],
            readImage: async value => { read.push(value.id); return pixel(value.id); } });
        expect(read).toEqual(required);
        expect(result?.previews).toHaveLength(5);
    });

    test.each([
        ["missing scope", new ImageAgentPlanningError("IMAGE_AGENT_UNPREVIEWED_IMAGE", "缺图")],
        ["missing outside required", issue(["original"], ["color"])],
        ["duplicate required", issue(["original", "original"])],
        ["six required", issue(["original", "color", "a", "b", "c", "d"])],
    ])("invalid repair scope cannot read or falsely mark previews: %s", async (_name, error) => {
        const read: string[] = [];
        await expect(prepareCanvasImageAgentRepairPreviews(error as ImageAgentPlanningError, catalog(), { readImage: async value => { read.push(value.id); return pixel(value.id); } })).rejects.toThrow();
        expect(read).toEqual([]);
    });

    test.each([
        ["not actual pixels", "/api/assets/image/content", "预览不可用"],
        ["over 8 MB", `data:image/png;base64,${"A".repeat(Math.ceil(8 * 1024 * 1024 / 3) * 4 + 4)}`, "超过 8 MB"],
    ])("%s stops without returning any replacement previews", async (_name, dataUrl, reason) => {
        await expect(prepareCanvasImageAgentRepairPreviews(issue(["original"]), catalog(), { readImage: async () => dataUrl })).rejects.toThrow(reason);
    });
});

const pending: PendingOnlineAgentTask = { ownerId: "owner", projectId: "project", requestId: "request:0", taskIds: ["original-task"], mode: "image", prompt: "blue shirt", model: "image" };
const task: QueuedTask = { id: "original-task", requestId: "request:0", status: "success", resultUrls: ["/api/assets/result/content"], failureReason: null };
type RecoveryIO = NonNullable<Parameters<typeof recoverOnlineAgentTask>[3]>;
function recoveryFixture(overrides: Partial<RecoveryIO> = {}) {
    const calls: string[] = [];
    const stored = { url: "blob:test", storageKey: "image:stored", width: 100, height: 100, bytes: 2, mimeType: "image/png" };
    const io: RecoveryIO = {
        getQueuedTask: async () => { calls.push("read-task"); return task; },
        getQueuedTaskByRequestId: async () => { calls.push("read-request"); return task; },
        recoverQueuedTask: async () => { calls.push("recover"); return task; },
        waitForTasks: async () => { calls.push("wait"); return [task]; },
        uploadImage: async () => { calls.push("store"); return stored; },
        storeGeneratedVideo: async () => stored,
        storeGeneratedAudio: async () => stored,
        restoreChatMaskResult: async () => { calls.push("restore-mask"); return "data:image/png;base64,AA=="; },
        fetch: async () => new Response("unused"),
        ...overrides,
    } as RecoveryIO;
    return { io, calls };
}

describe("original task recovery identity", () => {
    test.each(["id", "requestId"] as const)("known task lookup rejects a mismatched %s before storing media", async field => {
        const run = recoveryFixture({ getQueuedTask: async () => ({ ...task, [field]: "wrong" }) });
        await expect(recoverOnlineAgentTask(pending, { x: 0, y: 0 }, new AbortController().signal, run.io)).rejects.toThrow();
        expect(run.calls).not.toContain("store");
    });

    test("request lookup validates the receipt rather than trusting endpoint selection", async () => {
        const run = recoveryFixture({ getQueuedTaskByRequestId: async () => ({ ...task, requestId: "wrong" }) });
        await expect(recoverOnlineAgentTask({ ...pending, taskIds: undefined }, { x: 0, y: 0 }, new AbortController().signal, run.io)).rejects.toThrow();
        expect(run.calls).not.toContain("store");
    });

    test.each(["resume", "wait"])("%s cannot substitute a different task receipt", async stage => {
        const run = recoveryFixture({
            getQueuedTask: async () => ({ ...task, status: stage === "resume" ? "paused" : "processing", upstreamTaskId: "upstream" }),
            recoverQueuedTask: async () => ({ ...task, requestId: "wrong" }),
            waitForTasks: async () => [{ ...task, id: "wrong" }],
        });
        await expect(recoverOnlineAgentTask(pending, { x: 0, y: 0 }, new AbortController().signal, run.io)).rejects.toThrow();
        expect(run.calls).not.toContain("store");
    });

    test("historical image batches accept their ordered request:0 and request:1 receipts", async () => {
        const second = { ...task, id: "second-task", requestId: "request:1", resultUrls: ["/api/assets/second/content"] };
        const storedUrls: string[] = [];
        const run = recoveryFixture({
            getQueuedTask: async id => id === task.id ? task : second,
            uploadImage: async url => {
                storedUrls.push(String(url));
                return { url: String(url), storageKey: `image:stored-${storedUrls.length}`, width: 100, height: 100, bytes: 2, mimeType: "image/png" };
            },
        });
        const result = await recoverOnlineAgentTask({ ...pending, taskIds: [task.id, second.id] }, { x: 0, y: 0 }, new AbortController().signal, run.io);
        expect(storedUrls).toEqual([task.resultUrls[0], second.resultUrls[0]]);
        expect(result.attachments.map(item => item.id)).toEqual(["agent-original-task-0", "agent-second-task-0"]);
        expect(result.attachments.map(item => item.storageKey)).toEqual(["image:stored-1", "image:stored-2"]);
    });

    test("a foreign receipt anywhere in a historical batch prevents all recovery and storage", async () => {
        const second = { ...task, id: "second-task", requestId: "different-request:1" };
        const run = recoveryFixture({
            getQueuedTask: async id => id === task.id ? { ...task, status: "paused", upstreamTaskId: "upstream" } : second,
        });
        await expect(recoverOnlineAgentTask({ ...pending, taskIds: [task.id, second.id] }, { x: 0, y: 0 }, new AbortController().signal, run.io)).rejects.toThrow();
        expect(run.calls).not.toContain("recover");
        expect(run.calls).not.toContain("wait");
        expect(run.calls).not.toContain("store");
    });

    test("mask recovery restores original coordinates before storing the final image", async () => {
        const run = recoveryFixture();
        const maskAdaptation = { width: 1024, height: 1024, sourceWidth: 100, sourceHeight: 100, x: 0, y: 0, fittedWidth: 1024, fittedHeight: 1024, sourceStorageKey: "image:source", maskStorageKey: "image:mask" };
        const result = await recoverOnlineAgentTask({ ...pending, maskAdaptation }, { x: 0, y: 0 }, new AbortController().signal, run.io);
        expect(run.calls).toEqual(["read-task", "restore-mask", "store"]);
        expect(result.attachments[0]).toMatchObject({ id: "agent-original-task-0", storageKey: "image:stored" });
    });
});

function panelFunction(name: string, bindings: Record<string, unknown>) {
    const source = readFileSync(new URL("../src/components/canvas/canvas-assistant-panel.tsx", import.meta.url), "utf8");
    const ast = ts.createSourceFile("panel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let initializer: ts.Expression | undefined;
    function visit(node: ts.Node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) initializer = node.initializer;
        ts.forEachChild(node, visit);
    }
    visit(ast);
    if (!initializer) throw new Error(`Missing panel handler ${name}`);
    const code = ts.transpileModule(`const handler = ${initializer.getText(ast)}; return handler;`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    return new Function(...Object.keys(bindings), code)(...Object.values(bindings));
}

function recoveryPanelFixture({ active = "other", revision = 1, recordedRevision = 1, legacyVideo = false } = {}) {
    const record: CanvasImageAgentRecord | undefined = legacyVideo ? undefined : { sourceNodeId: "original", baseImageId: "original", referenceIds: ["original"], focusRevision: recordedRevision, note: { summary: "蓝色", keep: [] } };
    const originalPending = { ...pending, ...(record ? { imageAgent: record } : {}), mode: legacyVideo ? "video" as const : "image" as const };
    const item = { id: "reply", role: "assistant" as const, text: "等待", detail: { pendingTask: originalPending } };
    const sessions = { current: [{ id: "source", title: "Source", createdAt: "", updatedAt: "", focusImageId: "old-focus", ...(legacyVideo ? {} : { focusRevision: revision }), messages: [item] }] as CanvasAssistantSession[] };
    const selected: Set<string>[] = [];
    const snap = { current: snapshot() };
    const onlineRequestsRef = { current: new Map<AbortSignal, AbortController>() };
    const turnIdsRef = { current: new WeakMap<AbortSignal, string>() };
    const binds = {
        pendingOnlineAgentTask, queryTaskIdsRef: { current: new Set<string>() }, user: { id: "owner" },
        onlineRequestsRef, turnIdsRef,
        snapshotRef: snap, localSessionsRef: sessions, localActiveSessionIdRef: { current: active },
        beginOnlineRequest: () => {
            const controller = new AbortController();
            onlineRequestsRef.current.set(controller.signal, controller);
            turnIdsRef.current.set(controller.signal, "recovery-turn");
            return controller.signal;
        }, resolveAgentGeneratedMediaPosition: () => ({ x: 0, y: 0 }),
        recoverOnlineAgentTask: async () => ({ attachments: [{ id: "result", name: "Result", mediaType: legacyVideo ? "video" : "image", url: "/api/assets/result/content", storageKey: "image:result" }], ops: [] }),
        canvasImageAgentResultOps, executeOps: (ops: CanvasAgentOp[]) => { snap.current = applyCanvasAgentOps(snap.current, ops); },
        upsertMessage: () => undefined,
        onSelectNodeIds: (ids: Set<string>) => { selected.push(ids); snap.current.selectedNodeIds = [...ids]; },
        updateSession: (id: string, update: (session: CanvasAssistantSession) => CanvasAssistantSession) => { sessions.current = sessions.current.map(session => session.id === id ? update(session) : session); },
        QueuedTaskFailedError, finishConversationTurn: async () => undefined,
    };
    return { query: panelFunction("queryOriginalAgentTask", binds) as (sessionId: string, message: typeof item) => Promise<void>, item, sessions, selected, snap };
}

test("a recovered A result may update A's focus but cannot clear B's canvas selection", async () => {
    const run = recoveryPanelFixture();
    await run.query("source", run.item);
    expect(run.selected).toEqual([]);
    expect(run.snap.current.selectedNodeIds).toEqual(["chosen"]);
    expect(run.sessions.current[0]?.focusImageId).toContain("result");
});

test("legacy video recovery without image-agent metadata never becomes an image focus", async () => {
    const run = recoveryPanelFixture({ active: "source", legacyVideo: true });
    await run.query("source", run.item);
    expect(run.selected).toEqual([]);
    expect(run.sessions.current[0]?.focusImageId).toBe("old-focus");
});

test("a newer explicit focus wins over the recovered original image", async () => {
    const run = recoveryPanelFixture({ active: "source", revision: 2, recordedRevision: 1 });
    await run.query("source", run.item);
    expect(run.selected).toEqual([]);
    expect(run.sessions.current[0]?.focusImageId).toBe("old-focus");
});

test("releasing or stopping one foreground request cannot abort detached image observers", () => {
    const onlineRequestRef = { current: null as AbortController | null };
    const onlineRequestsRef = { current: new Map<AbortSignal, AbortController>() };
    const running: boolean[] = [];
    const bindings = {
        onlineRequestRef, onlineRequestsRef, turnIdsRef: { current: new WeakMap() }, nanoid: () => "turn", setIsRunning: (value: boolean) => running.push(value),
        attachmentReadRef: { current: { token: {}, busy: false } }, setAttachmentsLoading() {},
        localActiveSessionIdRef: { current: "active" }, localSessionsRef: { current: [] },
        pendingToolContextRef: { current: new Map() }, setLocalSessions() {}, useCallback: (callback: unknown) => callback,
    };
    const begin = panelFunction("beginOnlineRequest", bindings) as (background?: boolean) => AbortSignal;
    const release = panelFunction("releaseOnlineComposer", bindings) as (signal: AbortSignal) => void;
    const stop = panelFunction("stopOnlineAgent", bindings) as () => void;
    const original = begin(); release(original);
    const next = begin(), recovery = begin(true);
    release(original);
    expect(onlineRequestRef.current?.signal).toBe(next);
    expect(running.at(-1)).toBe(true);
    stop();
    expect(next.aborted).toBe(true);
    expect(original.aborted).toBe(false);
    expect(recovery.aborted).toBe(false);
    expect([...onlineRequestsRef.current.keys()]).toEqual([original, recovery]);
});

test("same-owner expiry preserves drafts and observers; changing owner drains them before reuse", () => {
    const source = readFileSync(new URL("../src/components/canvas/canvas-assistant-panel.tsx", import.meta.url), "utf8");
    const ast = ts.createSourceFile("panel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let lifecycle: ts.CallExpression | undefined;
    function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[0]?.getText(ast).includes("onlineMountedRef.current = true")) lifecycle = node;
        ts.forEachChild(node, visit);
    }
    visit(ast);
    expect(lifecycle).toBeDefined();
    const code = ts.transpileModule(lifecycle!.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    const state = { prompt: "", uploads: [] as unknown[] };
    const requests = { current: new Map<AbortSignal, AbortController>() };
    const pending = { current: new Map<string, unknown>() };
    let previous: unknown[] | undefined, cleanup: (() => void) | undefined;
    const bindings = {
        onlineMountedRef: { current: false }, setIsRunning() {}, setReferenceOrder() {}, setAgentState() {}, setMaskDialog() {},
        setPrompt: (value: string) => { state.prompt = value; }, setUploadedReferences: (value: unknown[]) => { state.uploads = value; },
        attachmentReadRef: { current: { token: {}, busy: false } }, mentionFocusRef: { current: undefined }, onlineRequestsRef: requests, pendingToolContextRef: pending,
        useEffect(callback: () => () => void, deps: unknown[]) {
            if (previous && previous.every((value, index) => Object.is(value, deps[index]))) return;
            cleanup?.(); previous = deps; cleanup = callback();
        },
    };
    const render = (user: { id: string; status: string }) => new Function(...Object.keys(bindings), "user", "onlineProjectId", code)(...Object.values(bindings), user, "project");
    render({ id: "owner-a", status: "authenticated" });
    state.prompt = "未发送的改图要求"; state.uploads = ["image:unsent"];
    const first = new AbortController(), second = new AbortController();
    requests.current.set(first.signal, first); requests.current.set(second.signal, second); pending.current.set("confirmation", {});
    render({ id: "owner-a", status: "expired" });
    expect(state).toEqual({ prompt: "未发送的改图要求", uploads: ["image:unsent"] });
    expect(first.signal.aborted).toBe(false); expect(second.signal.aborted).toBe(false);
    render({ id: "owner-a", status: "authenticated" });
    expect(state.prompt).toBe("未发送的改图要求");
    render({ id: "owner-b", status: "authenticated" });
    expect(first.signal.aborted).toBe(true); expect(second.signal.aborted).toBe(true);
    expect(requests.current.size).toBe(0); expect(pending.current.size).toBe(0);
    expect(state).toEqual({ prompt: "", uploads: [] });
    cleanup?.();
});

test("generation preflight counts translated run operations including autorun structures", () => {
    const source = readFileSync(new URL("../src/components/canvas/canvas-assistant-panel.tsx", import.meta.url), "utf8");
    const ast = ts.createSourceFile("panel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "canvasOnlineGenerationCallCount");
    expect(declaration).toBeDefined();
    const code = ts.transpileModule(declaration!.getText(ast).replace(/^export /, "") + "\nreturn canvasOnlineGenerationCallCount;", { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    const translated: string[] = [];
    const count = new Function("ONLINE_READ_TOOLS", "onlineToolToOps", code)(new Set(["canvas_get_state", "look_at_images"]), (name: string, args: { autoRun?: boolean; ops?: CanvasAgentOp[] }) => {
        translated.push(name);
        return args.ops || (args.autoRun ? [{ type: "add_node" }, { type: "run_generation", nodeId: "generated-config" }] : [{ type: "add_node" }]);
    });
    const call = (name: string, args = {}) => ({ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } });
    expect(count([call("canvas_get_state"), call("look_at_images"), call("canvas_create_config_node")], snapshot(), {})).toBe(0);
    expect(translated).toEqual(["canvas_create_config_node"]);
    expect(count([call("edit_image"), call("canvas_create_generation_flow", { autoRun: true })], snapshot(), {})).toBe(2);
    expect(count([call("canvas_create_config_node", { autoRun: true }), call("canvas_create_generation_flow", { autoRun: true })], snapshot(), {})).toBe(2);
    expect(count([call("canvas_apply_ops", { ops: [{ type: "run_generation", nodeId: "a" }, { type: "run_generation", nodeId: "b" }] })], snapshot(), {})).toBe(2);
});
