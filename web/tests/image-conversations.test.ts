import { afterEach, expect, test } from "bun:test";
import { createImageConversationApi, ImageConversationApiError, allConversationPages, readImageConversationEvents } from "@/services/api/image-conversations";
import { applyConversationEvent, conversationTurnStatus } from "@/components/image-conversation-state";
import { deploymentFeatures } from "@/lib/deployment-features";
import { useUserStore, type LocalUser } from "@/stores/use-user-store";
import type { PublicConversationEvent as ConversationEvent } from "../../shared/image-conversation-public";
import { conversationIds as ids, conversationTime as now, conversationSnapshot, conversationTurn, conversationVersion, conversationMessage } from "./fixtures/image-conversation";

const originalUser = useUserStore.getState(), originalFeatures = { ...deploymentFeatures };
afterEach(() => { useUserStore.setState(originalUser); Object.assign(deploymentFeatures, originalFeatures); });
function client(handler: (path: string, init: RequestInit) => Promise<Response>) {
    deploymentFeatures.authenticationEnabled = true;
    useUserStore.setState({ user: { id: ids.owner, role: "designer" } as LocalUser, status: "authenticated" });
    return createImageConversationApi(ids.owner, ((path, init) => handler(String(path), init || {})) as typeof fetch);
}
const ok = (data: unknown, status = 200) => Response.json({ code: "OK", data, msg: "" }, { status });
const event = (seq: number): ConversationEvent => ({ conversationId: ids.conversation, seq, turnId: ids.turn, type: "version.created", createdAt: now, payload: { stateRevision: 3, version: conversationVersion(true) } });
const frame = (value: ConversationEvent) => `id: ${value.seq}\nevent: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;

test("new conversation API sends only validated intent and distinguishes persisted acceptance", async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const api = client(async (path, init) => { calls.push({ path, init }); return ok({ turnId: ids.turn, stateRevision: 2, state: "accepted", assistant: conversationTurn().assistant }, 202); });
    const input = { clientRequestId: "大小写 /request A", expectedStateRevision: 1, text: "改蓝色", attachments: [{ assetId: ids.asset }], outputPreferences: { mode: "auto" as const } };
    expect(await api.submit(ids.conversation, input)).toMatchObject({ state: "accepted" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(`/api/image-conversations/${ids.conversation}/turns`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(input);
    expect(calls[0]!.init.headers).toMatchObject({ "X-Canvas-Owner-Id": ids.owner });
    expect(() => api.submit(ids.conversation, { ...input, model: "fake" } as typeof input)).toThrow();
    expect(calls).toHaveLength(1);
});

test("unknown submission is never automatically retried and request lookup preserves exact case and encoding", async () => {
    const paths: string[] = [], key = "大小写 A/a?1";
    const api = client(async (path, init) => { paths.push(path); if (init.method === "POST") throw new Error("lost response"); return ok({ turn: conversationTurn("uncertain", key), stateRevision: 2 }); });
    await expect(api.submit(ids.conversation, { clientRequestId: key, expectedStateRevision: 1, text: "修改" })).rejects.toThrow("lost response");
    expect(paths).toHaveLength(1);
    expect((await api.byRequest(ids.conversation, key)).turn.state).toBe("uncertain");
    expect(paths[1]).toEndWith(`/by-request/${encodeURIComponent(key)}`);
});

test("creation recovery only reads the original case-sensitive request key", async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [], key = "创建 A/a?1";
    const api = client(async (path, init) => { calls.push({ path, init }); return ok(conversationSnapshot()); });
    expect((await api.createByRequest(key)).id).toBe(ids.conversation);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(`/api/image-conversations/by-request/${encodeURIComponent(key)}`);
    expect(calls[0]!.init.method).toBeUndefined();
    expect(calls[0]!.init.body).toBeUndefined();
});

test("envelope, owner and receipt identity failures cannot be mistaken for success", async () => {
    const bare = client(async () => Response.json(conversationSnapshot()));
    await expect(bare.snapshot(ids.conversation)).rejects.toBeInstanceOf(ImageConversationApiError);
    const wrong = client(async () => ok({ turn: conversationTurn(), stateRevision: 2 }));
    await expect(wrong.byRequest(ids.conversation, "different-key")).rejects.toThrow("编号不一致");
    let calls = 0;
    const guarded = client(async () => { calls++; return ok(conversationSnapshot()); });
    useUserStore.setState({ user: { id: "other", role: "designer" } as LocalUser });
    await expect(guarded.snapshot(ids.conversation)).rejects.toThrow("员工会话");
    expect(calls).toBe(0);
});

test("event stream validates envelope identity and deduplicates replayed sequence numbers across chunks", async () => {
    const text = ": heartbeat\n\n" + frame(event(2)) + frame(event(2)) + frame(event(3));
    const bytes = new TextEncoder().encode(text), seen: number[] = [];
    const response = new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 17) controller.enqueue(bytes.slice(i, i + 17)); controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
    expect(await readImageConversationEvents(response, ids.conversation, 1, value => { seen.push(value.seq); }, new AbortController().signal)).toBe(3);
    expect(seen).toEqual([2, 3]);
    const wrong = new Response(frame(event(4)).replace("id: 4", "id: 5"), { headers: { "Content-Type": "text/event-stream" } });
    await expect(readImageConversationEvents(wrong, ids.conversation, 3, () => {}, new AbortController().signal)).rejects.toThrow("身份不一致");
    const mixed = event(4);
    if (mixed.type === "version.created") mixed.payload.version.conversationId = "82000000-0000-4000-8000-000000000001";
    const crossed = new Response(frame(mixed), { headers: { "Content-Type": "text/event-stream" } });
    await expect(readImageConversationEvents(crossed, ids.conversation, 3, () => {}, new AbortController().signal)).rejects.toThrow("身份不一致");
});

test("410 event recovery remains a typed read-only error with the original cursor", async () => {
    const calls: RequestInit[] = [];
    const api = client(async (_path, init) => { calls.push(init); return Response.json({ code: "EVENT_CURSOR_EXPIRED", msg: "expired", data: { latestEventSeq: 8 } }, { status: 410 }); });
    await expect(api.events(ids.conversation, 3, () => {}, new AbortController().signal)).rejects.toMatchObject({ status: 410, code: "EVENT_CURSOR_EXPIRED" });
    expect(calls[0]!.method).toBeUndefined();
    expect(calls[0]!.headers).toMatchObject({ "Last-Event-ID": "3" });
});

test("server events never turn acceptance into image success or adopt a detached result", () => {
    const snapshot = conversationSnapshot(), turn = conversationTurn();
    let view = { snapshot, messages: [], versions: [conversationVersion()], turns: [] };
    const accepted: ConversationEvent = { conversationId: ids.conversation, seq: 2, turnId: ids.turn, type: "turn.accepted", createdAt: now, payload: { stateRevision: 2, turn } };
    view = applyConversationEvent(view, accepted) as typeof view;
    expect(view.snapshot.pendingTurn?.state).toBe("accepted");
    expect(conversationTurnStatus(turn)).toContain("尚未出图");
    expect(view.versions).toHaveLength(1);
    view = applyConversationEvent(view, { ...accepted, seq: 3, type: "turn.detached", payload: { stateRevision: 3, turn: conversationTurn("detached") } }) as typeof view;
    view = applyConversationEvent(view, event(4)) as typeof view;
    expect(view.snapshot.pendingTurn).toBeNull();
    expect(view.snapshot.activeVersionId).toBe(ids.root);
    expect(view.versions).toHaveLength(2);
    expect(applyConversationEvent(view, event(4))).toBe(view);
    const message: ConversationEvent = { conversationId: ids.conversation, seq: 5, turnId: ids.turn, type: "message.created", createdAt: now, payload: { stateRevision: 3, message: conversationMessage(true) } };
    expect(applyConversationEvent(applyConversationEvent(view, message), message).messages).toHaveLength(1);
});

test("paged server history reads opaque cursors and rejects loops instead of silently truncating", async () => {
    const cursors: Array<string | undefined> = [];
    expect(await allConversationPages(async cursor => { cursors.push(cursor); return { items: cursor ? [2] : [1], nextCursor: cursor ? null : "opaque/cursor" }; })).toEqual([1, 2]);
    expect(cursors).toEqual([undefined, "opaque/cursor"]);
    await expect(allConversationPages(async () => ({ items: [], nextCursor: "same" }))).rejects.toThrow("游标重复");
});
