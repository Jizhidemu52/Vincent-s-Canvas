import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { DesignExecutionHistoryRecord } from "../../shared/design-conversation-history";
import { restoreServerDesignExecution } from "../src/components/canvas/design-discussion/server-execution-history";
import { createDesignConversationController } from "../src/services/api/design-discussion-conversations";
import type { DesignConversationTask } from "../src/components/canvas/design-discussion/conversation-execution";
import { conversationIds as ids, conversationTime, conversationTurn, conversationVersion } from "./fixtures/image-conversation";

const canvas = "server-history-canvas";
function record(index = 0, state: "completed" | "generating" | "unsubmitted" = "completed"): DesignExecutionHistoryRecord {
    const id = `design-image-${index.toString(16).padStart(64, "0")}`;
    return { id, conversationId: ids.conversation, canvasExternalId: canvas, title: `已保存方案 ${index}`, createdAt: conversationTime, initialAssetId: ids.asset,
        turnRequest: state === "unsubmitted" ? null : { clientRequestId: `${id}:turn`, expectedStateRevision: 1, text: "保留七颗纽扣，改为灰蓝色。", attachments: [] },
        turn: state === "unsubmitted" ? null : conversationTurn(state, `${id}:turn`), outputVersion: state === "completed" ? conversationVersion(true) : null };
}
function fixture() {
    let items = [record()], fail: Error | null = null, owner = ids.owner, visible: DesignConversationTask[] = [];
    const calls: string[] = [], local = new Map<string, unknown>();
    const rejectWrite = () => { throw new Error("Paid or upload write is forbidden in server history tests"); };
    const api = {
        create: rejectWrite, submit: rejectWrite, createByRequest: rejectWrite, byRequest: rejectWrite, snapshot: rejectWrite,
        async designExecutions(project: string, cursor?: string) {
            calls.push(`history:${cursor || "head"}`); expect(project).toBe(canvas);
            if (fail) throw fail;
            const start = Number(cursor || 0), end = start + 2;
            return { items: structuredClone(items.slice(start, end)), nextCursor: end < items.length ? String(end) : null };
        },
        async turn(conversationId: string, turnId: string) { calls.push("turn"); expect(conversationId).toBe(ids.conversation); expect(turnId).toBe(ids.turn); return { turn: items[0]!.turn!, stateRevision: 2 }; },
        async versions() { calls.push("versions"); return { items: items[0]!.outputVersion ? [items[0]!.outputVersion!] : [], nextCursor: null }; },
    };
    const controller = createDesignConversationController({ api, ownerId: ids.owner, canvasExternalId: canvas,
        storage: { getItem: async id => local.get(id) ?? null, setItem: async (id, value) => { calls.push("local-write"); local.set(id, value); },
            iterate: async visit => { for (const value of local.values()) visit(value); } },
        uploadReference: rejectWrite, assertOwner: async () => { if (owner !== ids.owner) throw Object.assign(new Error("员工已变化"), { code: "SESSION_CHANGED" }); },
        onChange: tasks => { visible = tasks; },
    });
    return { controller, calls, local, tasks: () => visible, items: (value: typeof items) => { items = value; }, fail: (value: Error | null) => { fail = value; }, owner: (value: string) => { owner = value; } };
}

describe("server-discovered design execution history", () => {
    test("empty browser discovers stored input, original refs and exact result with one page read and no writes", async () => {
        const current = fixture(); await current.controller.load();
        expect(current.tasks()).toHaveLength(1);
        expect(current.tasks()[0]).toMatchObject({ id: record().id, ownerId: ids.owner, projectId: canvas, serverHistory: true, generationAllowed: false,
            status: "success", prompt: record().turnRequest!.text, resultUrls: [`/api/assets/${ids.resultAsset}/content`], references: [{ assetId: ids.asset, role: "base" }] });
        expect(current.calls).toEqual(["history:head"]); expect(current.local.size).toBe(0);
        await current.controller.refreshAll(); expect(current.calls).toEqual(["history:head"]);
    });
    test("server-only records never submit missing work and active original turns reconcile read-only", async () => {
        const current = fixture(); current.items([record(0, "unsubmitted")]); await current.controller.load();
        expect(current.controller.needsRefresh()).toBe(false);
        await current.controller.action(record().id, "continue");
        expect(current.calls.every(call => call === "history:head")).toBe(true);
        current.items([record(0, "generating")]); await current.controller.refreshHistory();
        expect(current.controller.needsRefresh()).toBe(true);
        current.items([record()]); await current.controller.refreshAll();
        expect(current.tasks()[0]!.status).toBe("success"); expect(current.local.size).toBe(0);
        expect(current.calls.slice(-2)).toEqual(["turn", "versions"]);
    });
    test("explicit pagination exposes every record without duplicate IDs or per-result detail reads", async () => {
        const current = fixture(); current.items(Array.from({ length: 5 }, (_, index) => record(index)));
        await current.controller.load(); expect(current.tasks()).toHaveLength(2); expect(current.controller.hasMoreHistory()).toBe(true);
        await current.controller.loadMoreHistory(); await current.controller.loadMoreHistory();
        expect(current.tasks()).toHaveLength(5); expect(current.controller.hasMoreHistory()).toBe(false);
        expect(current.calls).toEqual(["history:head", "history:2", "history:4"]);
        await current.controller.refreshHistory(); expect(new Set(current.tasks().map(task => task.id)).size).toBe(5);
    });
    test("history errors remain explicit, retry reads only, and changed owner rejects without publishing foreign data", async () => {
        const current = fixture(); current.fail(new Error("暂时离线")); await current.controller.load();
        expect(current.controller.historyError()).toContain("暂时离线"); expect(current.tasks()).toEqual([]);
        current.fail(null); await current.controller.refreshHistory(); expect(current.controller.historyError()).toBe("");
        current.owner(randomUUID()); await expect(current.controller.refreshHistory()).rejects.toThrow("员工已变化");
        expect(current.calls).toEqual(["history:head", "history:head"]);
    });
    test("foreign canvas and mismatched turn/version/request identities are rejected before projection", () => {
        const value = record();
        expect(() => restoreServerDesignExecution(value, ids.owner, "other-canvas")).toThrow("当前画布");
        for (const changed of [
            { ...value, id: "not-a-design-execution" }, { ...value, turn: { ...value.turn!, conversationId: randomUUID() } },
            { ...value, turnRequest: { ...value.turnRequest!, clientRequestId: "foreign-request" } },
            { ...value, outputVersion: { ...value.outputVersion!, assetId: randomUUID(), turnId: randomUUID() } },
            { ...value, turn: null, turnRequest: null },
        ]) expect(() => restoreServerDesignExecution(changed, ids.owner, canvas)).toThrow();
    });
});
