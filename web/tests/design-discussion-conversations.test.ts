import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CreateConversationRequest, SubmitTurnRequest } from "../../shared/image-conversation-contracts";
import type { PublicConversationSnapshot, PublicImageTurn, PublicImageVersion } from "../../shared/image-conversation-public";
import { createTaskController } from "../src/services/api/design-discussion.mjs";
import { createDesignConversationController } from "../src/services/api/design-discussion-conversations";
import { buildDesignConversationText, designConversationExecutionId, type DesignConversationInput, type DesignConversationTask } from "../src/components/canvas/design-discussion/conversation-execution";
import { generationSlots } from "../src/components/canvas/design-discussion/generation-batch.mjs";
import { conversationIds, conversationSnapshot, conversationTurn, conversationVersion } from "./fixtures/image-conversation";

const ownerId = conversationIds.owner, canvasExternalId = "design-canvas-fixture";
const reference = { id: "source-a", title: "针织原图", image: `/api/assets/${conversationIds.asset}/content`, role: "base" };
const input = (index = 0): DesignConversationInput => ({ generationAllowed: true, mediaKind: "image", prompt: "完整保留七颗纽扣，将衣身改为蓝灰色。", userText: "保留全部七颗纽扣。",
    references: [reference], discussionSessionId: "discussion-a", discussionMessageId: "reply-a",
    proposal: { id: `blue:output:${index}`, batchId: "batch-a", title: "蓝灰色针织衫", features: ["蓝灰配色", "保留纽扣"], requirementEvidence: [{ originalText: "  先讨论，保留七颗纽扣。\n  ", effectiveText: "保留七颗纽扣。" }] } });
const missing = () => Object.assign(new Error("尚未查到原请求"), { status: 404, code: "NOT_FOUND" });
type Call = { method: string; path: string; input?: unknown };

function memoryStorage() {
    const records = new Map<string, DesignConversationTask>();
    const writes: DesignConversationTask[] = [];
    const access = { reads: [] as string[], scans: 0 };
    let rejectWrite: (task: DesignConversationTask) => boolean = () => false;
    return { records, writes, access, reject: (reject: typeof rejectWrite) => { rejectWrite = reject; },
        async getItem(key: string) { access.reads.push(key); return structuredClone(records.get(key) ?? null); },
        async setItem(key: string, value: unknown) {
            const task = value as DesignConversationTask;
            if (rejectWrite(task)) throw new Error("fixture storage unavailable");
            writes.push(structuredClone(task)); records.set(key, structuredClone(task));
        },
        async iterate(visitor: (value: unknown) => void) { access.scans++; for (const value of records.values()) visitor(structuredClone(value)); },
    };
}

test("active conversation polling reads only its own receipt key and stopped tasks cause no reads", async () => {
    const run = fixture();
    await run.controller.load();
    const task = await run.controller.start(input());
    run.storage.access.reads.length = 0; run.storage.access.scans = 0;
    await run.controller.refreshAll();
    expect(run.storage.access).toEqual({ reads: [task.id], scans: 0 });
    await run.controller.action(task.id, "stop");
    run.storage.access.reads.length = 0;
    const requests = run.calls.length;
    expect(run.controller.needsRefresh()).toBe(false);
    await run.controller.refreshAll();
    expect(run.storage.access).toEqual({ reads: [], scans: 0 });
    expect(run.calls).toHaveLength(requests);
    run.controller.dispose();
});

function fixture(options: { loseCreate?: boolean; loseTurn?: boolean; queryMissing?: boolean; storage?: ReturnType<typeof memoryStorage>; enabled?: boolean } = {}) {
    const storage = options.storage || memoryStorage(), calls: Call[] = [];
    const snapshots = new Map<string, PublicConversationSnapshot>(), creates = new Map<string, string>(), turns = new Map<string, PublicImageTurn>();
    const outputs = new Map<string, PublicImageVersion[]>();
    let owner = ownerId, writable = true, visible: DesignConversationTask[] = [];
    const assertWritable = () => { if (!writable) throw new Error("当前画布不可写"); };
    const api = {
        async designExecutions() { return { items: [], nextCursor: null }; },
        async create(request: CreateConversationRequest) {
            calls.push({ method: "POST", path: "/api/image-conversations", input: request });
            const stored = [...storage.records.values()].find(value => value.conversationExecution.createRequest?.clientRequestId === request.clientRequestId)!;
            expect(stored.conversationExecution.createDispatchStartedAt).toBeString();
            expect(stored.conversationExecution.createRequest).toEqual(request);
            const id = randomUUID(), root = request.initialAssetId ? { ...conversationVersion(), id: randomUUID(), conversationId: id, assetId: request.initialAssetId } : null;
            if (root) root.rootVersionId = root.id;
            const snapshot: PublicConversationSnapshot = { ...conversationSnapshot(), id, title: request.title || null, entrypoint: "canvas", canvasExternalId, activeVersionId: root?.id || null, activeVersion: root };
            snapshots.set(id, snapshot); creates.set(request.clientRequestId, id); outputs.set(id, root ? [root] : []);
            if (options.loseCreate) throw new TypeError("fixture create response lost");
            return structuredClone(snapshot);
        },
        async createByRequest(key: string) {
            calls.push({ method: "GET", path: `/api/image-conversations/by-request/${key}` });
            const id = creates.get(key);
            if (options.queryMissing || !id) throw missing();
            return structuredClone(snapshots.get(id)!);
        },
        async snapshot(id: string) {
            calls.push({ method: "GET", path: `/api/image-conversations/${id}` });
            if (!snapshots.has(id)) throw missing();
            return structuredClone(snapshots.get(id)!);
        },
        async submit(id: string, request: SubmitTurnRequest) {
            calls.push({ method: "POST", path: `/api/image-conversations/${id}/turns`, input: request });
            const stored = [...storage.records.values()].find(value => value.conversationExecution.conversationId === id)!;
            expect(stored.conversationExecution.turnDispatchStartedAt).toBeString();
            expect(stored.conversationExecution.turnRequest).toEqual(request);
            const snapshot = snapshots.get(id)!;
            const turn: PublicImageTurn = { ...conversationTurn("generating", request.clientRequestId), id: randomUUID(), conversationId: id,
                taskId: randomUUID(), inputActiveVersionId: snapshot.activeVersionId, baseVersionId: snapshot.activeVersionId };
            turns.set(id, turn); snapshot.stateRevision = request.expectedStateRevision + 1; snapshot.pendingTurn = turn;
            if (options.loseTurn) throw new TypeError("fixture turn response lost");
            return { turnId: turn.id, stateRevision: snapshot.stateRevision, state: turn.state, assistant: turn.assistant };
        },
        async byRequest(id: string, key: string) {
            calls.push({ method: "GET", path: `/api/image-conversations/${id}/turns/by-request/${key}` });
            const turn = turns.get(id);
            if (options.queryMissing || !turn || turn.clientRequestId !== key) throw missing();
            return { turn: structuredClone(turn), stateRevision: snapshots.get(id)!.stateRevision };
        },
        async turn(id: string, turnId: string) {
            calls.push({ method: "GET", path: `/api/image-conversations/${id}/turns/${turnId}` });
            const turn = turns.get(id);
            if (options.queryMissing || !turn || turn.id !== turnId) throw missing();
            return { turn: structuredClone(turn), stateRevision: snapshots.get(id)!.stateRevision };
        },
        async versions(id: string) {
            calls.push({ method: "GET", path: `/api/image-conversations/${id}/versions` });
            return { items: structuredClone(outputs.get(id) || []), nextCursor: null };
        },
    };
    const legacy = {
        session: async () => ({ user: { id: owner, status: "active" } }),
        catalog: async () => ({ models: [{ id: "video-model", modelId: "video-public", parameterModelId: "seedance-2-5-flash", name: "视频", capabilities: ["video"] }], tools: [{ toolKey: "canvas-video", enabled: true, modelConfigId: "video-model" }] }),
        upload: async (source: typeof reference) => source,
        submit: async (task: Record<string, unknown>) => {
            calls.push({ method: "POST", path: "/api/tasks", input: task });
            return { id: randomUUID(), requestId: task.requestId, projectId: canvasExternalId, userId: ownerId, status: "processing", resultUrls: [] };
        },
        query: async () => null,
    };
    const controller = createTaskController({ api: legacy, storage, ownerId, projectId: canvasExternalId, assertWritable, imageConversationsEnabled: options.enabled !== false, conversationApi: api,
        onChange: (tasks: DesignConversationTask[]) => { visible = tasks; } });
    const reload = () => createDesignConversationController({ api, storage, ownerId, canvasExternalId, assertWritable, uploadReference: async source => source,
        assertOwner: async () => { if (owner !== ownerId) throw new Error("员工身份已变化"); }, onChange: tasks => { visible = tasks; } });
    const complete = (id: string) => {
        const turn = turns.get(id)!, current = snapshots.get(id)!;
        const version: PublicImageVersion = { ...conversationVersion(true), id: randomUUID(), conversationId: id, rootVersionId: current.activeVersion!.id, parentVersionId: current.activeVersion!.id, turnId: turn.id };
        outputs.set(id, [...outputs.get(id)!, version]); turn.state = "completed"; turn.outputVersionId = version.id;
        current.pendingTurn = null; current.activeVersion = version; current.activeVersionId = version.id;
        return version;
    };
    return { controller, api, legacy, storage, calls, snapshots, turns, outputs, complete, reload, tasks: () => visible, setOwner: (value: string) => { owner = value; }, setWritable: (value: boolean) => { writable = value; },
        posts: () => calls.filter(call => call.method === "POST") };
}

describe("right-side conversation-backed image execution", () => {
    test("N selected outputs create N independent conversations and turns with server-auto parameters", async () => {
        const current = fixture();
        const slots = generationSlots([{ id: "blue" }], ["blue"], 3);
        const tasks = [];
        for (const slot of slots) tasks.push(await current.controller.start(input(slot.index)));
        expect(current.posts()).toHaveLength(6);
        expect(current.calls.some(call => call.path === "/api/tasks")).toBe(false);
        expect(new Set(tasks.map(task => task.conversationExecution.conversationId)).size).toBe(3);
        for (const call of current.posts().filter(call => call.path.endsWith("/turns"))) {
            expect(call.input).toMatchObject({ outputPreferences: { mode: "auto" }, attachments: [] });
            expect(call.input).not.toHaveProperty("modelConfigId"); expect(call.input).not.toHaveProperty("parameters");
        }
        for (let index = 0; index < 3; index++) expect((await current.controller.start(input(index))).id).toBe(tasks[index].id);
        expect(current.posts()).toHaveLength(6);
    });

    test("concurrent clicks and a missing proposal/node receipt still reuse the durable slot", async () => {
        const current = fixture();
        const [first, second] = await Promise.all([current.controller.start(input()), current.controller.start(input())]);
        expect(first.id).toBe(second.id); expect(current.posts()).toHaveLength(2);
        const reloaded = current.reload();
        const existing = await reloaded.start({ ...input(), requestId: randomUUID() });
        expect(existing.id).toBe(first.id); expect(current.posts()).toHaveLength(2);
        await reloaded.load(); await reloaded.refreshAll();
        expect(current.posts()).toHaveLength(2);
    });

    test("separate controllers serialize the same durable slot before the first network request", async () => {
        const current = fixture();
        const other = current.reload();
        const [first, second] = await Promise.all([current.controller.start(input()), other.start(input())]);
        expect(first.id).toBe(second.id);
        expect(first.conversationExecution.conversationId).toBe(second.conversationExecution.conversationId);
        expect(current.posts()).toHaveLength(2);
    });

    test("a readonly canvas cannot start or continue a previously created conversation", async () => {
        const current = fixture({ loseCreate: true });
        current.setWritable(false);
        await expect(current.controller.start(input())).rejects.toThrow("不可写");
        expect(current.posts()).toHaveLength(0);
        current.setWritable(true);
        const task = await current.controller.start(input());
        current.setWritable(false);
        await expect(current.controller.action(task.id, "continue")).rejects.toThrow("不可写");
        await current.controller.action(task.id, "refresh");
        expect(current.posts()).toHaveLength(1);
    });

    test("a lost create receipt only queries its key and does not submit a turn until an explicit continue", async () => {
        const current = fixture({ loseCreate: true });
        const first = await current.controller.start(input());
        expect(first.status).toBe("paused"); expect(first.conversationExecution.phase).toBe("ready_to_submit");
        expect(current.posts()).toHaveLength(1);
        const reloaded = current.reload(); await reloaded.load(); await reloaded.refreshAll();
        await reloaded.start(input()); await reloaded.action(first.id, "refresh");
        expect(current.posts()).toHaveLength(1);
        await reloaded.action(first.id, "continue");
        expect(current.posts()).toHaveLength(2);
        expect(current.posts().filter(call => call.path === "/api/image-conversations")).toHaveLength(1);
        expect(current.calls.some(call => call.path.includes(`/by-request/${first.conversationExecution.createRequest!.clientRequestId}`))).toBe(true);
    });

    test.each([false, true])("lost turn receipts never re-POST, including a missing lookup=%s", async queryMissing => {
        const current = fixture({ loseTurn: true, queryMissing });
        const first = await current.controller.start(input());
        expect(first.status).toBe(queryMissing ? "uncertain" : "processing");
        const reloaded = current.reload(); await reloaded.load(); await reloaded.refreshAll();
        await reloaded.action(first.id, "refresh"); await reloaded.start(input());
        expect(current.posts()).toHaveLength(2);
        expect(current.calls.filter(call => call.path.includes("/turns/by-request/")).every(call => call.method === "GET")).toBe(true);
    });

    test("a missing create lookup is unresolved, not permission to create again", async () => {
        const current = fixture({ loseCreate: true, queryMissing: true });
        const first = await current.controller.start(input());
        expect(first.status).toBe("uncertain");
        const reloaded = current.reload(); await reloaded.load(); await reloaded.refreshAll(); await reloaded.action(first.id, "continue");
        expect(current.posts()).toHaveLength(1); expect(current.tasks()[0].conversationExecution.conversationId).toBeNull();
    });

    test.each(["preparing", "creating", "submitting"])("receipt storage failure at %s prevents its next dispatch", async phase => {
        const current = fixture();
        current.storage.reject(task => task.conversationExecution.phase === phase);
        try { await current.controller.start(input()); } catch {}
        expect(current.posts()).toHaveLength(phase === "submitting" ? 1 : 0);
    });

    test("a turn accepted before local persistence failed is recovered without duplicate generation", async () => {
        const current = fixture();
        let failed = false;
        current.storage.reject(task => {
            if (!failed && task.conversationExecution.phase === "accepted") { failed = true; return true; }
            return false;
        });
        const first = await current.controller.start(input());
        expect(first.status).toBe("processing"); expect(current.posts()).toHaveLength(2);
        const reloaded = current.reload(); await reloaded.load(); await reloaded.refreshAll(); await reloaded.start(input());
        expect(current.posts()).toHaveLength(2);
    });

    test("the full original evidence remains in the accepted text and over-budget input is rejected before requests", async () => {
        const current = fixture();
        await current.controller.start(input());
        const posted = current.posts().find(call => call.path.endsWith("/turns"))!.input as SubmitTurnRequest;
        expect(posted.text).toContain(input().prompt);
        expect(posted.text).toContain(JSON.stringify(input().proposal.requirementEvidence));
        const oversized = fixture();
        await expect(oversized.controller.start({ ...input(), prompt: "原文".repeat(5001) })).rejects.toThrow("10000");
        expect(oversized.calls).toEqual([]);
        expect(() => buildDesignConversationText({ ...input(), prompt: "完整设计".repeat(3000) }, [])).toThrow("未截断");
    });

    test("only an explicit base becomes initial active; other asset roles remain turn references", async () => {
        const current = fixture();
        const color = { ...reference, id: "color-a", image: `/api/assets/${conversationIds.resultAsset}/content`, role: "color" };
        await current.controller.start({ ...input(), references: [reference, color] });
        expect(current.posts()[0].input).toMatchObject({ initialAssetId: conversationIds.asset });
        expect(current.posts()[1].input).toMatchObject({ attachments: [{ assetId: conversationIds.resultAsset, purpose: "reference" }] });
        const noBase = fixture();
        await noBase.controller.start({ ...input(), references: [{ ...reference, role: "auto" }, color] });
        expect(noBase.posts()[0].input).not.toHaveProperty("initialAssetId");
        expect(noBase.posts()[1].input).toMatchObject({ attachments: [{ assetId: conversationIds.asset, purpose: "auto" }, { assetId: conversationIds.resultAsset, purpose: "reference" }] });
    });

    test("uploaded V1 is not a result, a generated version is mapped by original turn, and clarify is not success", async () => {
        const current = fixture();
        const task = await current.controller.start(input());
        expect(task.resultUrls).toEqual([]);
        const version = current.complete(task.conversationExecution.conversationId!);
        await current.controller.refreshAll();
        expect(current.tasks()[0]).toMatchObject({ status: "success", resultVersions: [version], resultUrls: [`/api/assets/${version.assetId}/content`] });
        const clarify = fixture(); const pending = await clarify.controller.start(input());
        const turn = clarify.turns.get(pending.conversationExecution.conversationId!)!;
        Object.assign(turn, { state: "completed", intent: "clarify", taskId: null, assistant: { kind: "question", text: "请明确配色参考。", canCancel: false } });
        await clarify.controller.refreshAll();
        expect(clarify.tasks()[0]).toMatchObject({ status: "needs_input", failureReason: "请明确配色参考。", resultUrls: [] });
    });

    test("a completed detached result remains archived instead of being installed automatically", async () => {
        const current = fixture();
        const task = await current.controller.start(input());
        const id = task.conversationExecution.conversationId!;
        const version = current.complete(id);
        current.turns.get(id)!.autoActivate = false;
        await current.controller.refreshAll();
        expect(current.tasks()[0]).toMatchObject({ status: "detached", resultVersions: [version], conversationExecution: { phase: "detached" } });
        expect(current.posts()).toHaveLength(2);
    });

    test("another employee cannot dispatch and a video still uses the existing task pipeline", async () => {
        const blocked = fixture(); blocked.setOwner(randomUUID());
        await expect(blocked.controller.start(input())).rejects.toThrow("身份已变化"); expect(blocked.posts()).toEqual([]);
        const current = fixture();
        await current.controller.start({ ...input(), references: [], mediaKind: "video", modelId: "video-model", videoSeconds: 6 });
        expect(current.posts()).toHaveLength(1); expect(current.posts()[0].path).toBe("/api/tasks");
        expect(current.posts()[0].input).toMatchObject({ mediaKind: "video", modelId: "video-model" });
    });

    test("the deterministic execution key is scoped to employee, canvas, discussion, batch and slot", () => {
        const original = designConversationExecutionId(ownerId, canvasExternalId, input());
        expect(designConversationExecutionId(ownerId, canvasExternalId, { ...input(), requestId: randomUUID() })).toBe(original);
        expect(designConversationExecutionId(randomUUID(), canvasExternalId, input())).not.toBe(original);
        expect(designConversationExecutionId(ownerId, "another-canvas", input())).not.toBe(original);
        expect(designConversationExecutionId(ownerId, canvasExternalId, input(1))).not.toBe(original);
    });

    test.each(["create", "turn"])("a changed persisted %s request key is rejected without querying or writing a new request", async phase => {
        const current = fixture();
        const task = await current.controller.start(input());
        const stored = current.storage.records.get(task.id)!;
        const request = phase === "create" ? stored.conversationExecution.createRequest! : stored.conversationExecution.turnRequest!;
        request.clientRequestId = "another-request";
        current.calls.splice(0);
        await expect(current.reload().load()).rejects.toThrow("身份不一致");
        expect(current.calls).toEqual([]);
    });
});
