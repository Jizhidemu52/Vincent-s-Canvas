import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import type { ConversationEvent } from "../../shared/image-conversation-contracts";
import { conversationEventSchema } from "../../shared/image-conversation-schemas";
import type { Database } from "./db";
import { withTransaction } from "./db-transaction";
import { ImageConversationError, isoTimestamp, readConversation, safeCounter } from "./image-conversation-store";
import { toPublicImageConversationData } from "./image-conversation-public";

export class ImageConversationEvents {
  private readonly emitter = new EventEmitter();
  private readonly closures = new Set<() => void>();
  private closed = false;
  constructor() { this.emitter.setMaxListeners(0); }
  wake(conversationId: string) { this.emitter.emit(conversationId); }
  subscribe(conversationId: string, wake: () => void, close: () => void) {
    if (this.closed) { close(); return () => {}; }
    this.emitter.on(conversationId, wake);
    this.closures.add(close);
    return () => { this.emitter.off(conversationId, wake); this.closures.delete(close); };
  }
  close() {
    this.closed = true;
    for (const close of [...this.closures]) close();
    this.closures.clear();
    this.emitter.removeAllListeners();
  }
}
export function parseConversationEventCursor(request: Pick<Request, "headers" | "query">) {
  const value = request.headers["last-event-id"] ?? request.query.afterSeq ?? "0";
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new ImageConversationError(400, "VALIDATION_ERROR", "事件序号必须是非负整数");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 9_000_000_000_000_000) throw new ImageConversationError(400, "VALIDATION_ERROR", "事件序号超出范围");
  return parsed;
}
export async function readConversationEvents(db: Database, ownerId: string, conversationId: string, afterSeq: number) {
  return withTransaction(db, async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const conversation = await readConversation(client, ownerId, conversationId);
    const latest = safeCounter(conversation.last_event_seq);
    if (afterSeq > latest) throw new ImageConversationError(400, "VALIDATION_ERROR", "事件序号不能超过当前会话");
    const result = await client.query<{ seq: string; turn_id: string | null; event_type: ConversationEvent["type"]; payload: unknown; created_at: Date | string }>(
      "SELECT seq,turn_id,event_type,payload,created_at FROM image_conversation_events WHERE conversation_id=$1 AND seq>$2 ORDER BY seq LIMIT 100", [conversationId, afterSeq]);
    let expected = afterSeq + 1;
    const expired = () => new ImageConversationError(410, "EVENT_CURSOR_EXPIRED", "事件记录已过期，请重新读取会话和消息", {
      latestEventSeq: latest, earliestAvailableEventSeq: result.rows[0] ? safeCounter(result.rows[0].seq) : latest + 1,
      snapshotUrl: `/api/image-conversations/${conversationId}`,
    });
    if (!result.rows.length && afterSeq < latest) throw expired();
    const events = result.rows.map(row => {
      if (safeCounter(row.seq) !== expected++) throw expired();
      return conversationEventSchema.parse({ conversationId, seq: safeCounter(row.seq), turnId: row.turn_id, type: row.event_type,
        createdAt: isoTimestamp(row.created_at), payload: row.payload }) as ConversationEvent;
    });
    return { events, latestEventSeq: latest };
  });
}
export async function streamConversationEvents(input: {
  db: Database; events: ImageConversationEvents; ownerId: string; conversationId: string;
  afterSeq: number; response: Response; pollMs?: number; lifetimeMs?: number;
}) {
  const { response } = input;
  let cursor = input.afterSeq;
  let ended = false;
  let opened = false;
  let dirty = false;
  let reading = false;
  let unsubscribe = () => {};
  let poll: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (ended) return;
    ended = true;
    clearInterval(poll); clearInterval(heartbeat); clearTimeout(deadline);
    unsubscribe();
    response.off("close", cleanup); response.off("error", cleanup);
  };
  const close = () => { cleanup(); if (!response.writableEnded) response.end(); };
  const write = (frame: string) => {
    if (ended || response.destroyed) { cleanup(); return false; }
    if (!response.write(frame)) { cleanup(); response.destroy(); return false; }
    return true;
  };
  const read = async () => {
    if (ended) return;
    if (reading) { dirty = true; return; }
    reading = true;
    try {
      do {
        dirty = false;
        const batch = await readConversationEvents(input.db, input.ownerId, input.conversationId, cursor);
        if (ended) return;
        if (!opened) {
          response.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "private, no-store", "X-Accel-Buffering": "no" });
          response.flushHeaders(); opened = true;
          write(": connected\n\n");
        }
        for (const event of batch.events) {
          if (!write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(toPublicImageConversationData(event))}\n\n`)) return;
          cursor = event.seq;
        }
        if (cursor < batch.latestEventSeq) dirty = true;
      } while (dirty && !ended);
    } finally { reading = false; }
  };
  const wake = () => { dirty = true; if (opened) void read().catch(close); };
  response.once("close", cleanup); response.once("error", cleanup);
  unsubscribe = input.events.subscribe(input.conversationId, wake, close);
  if (ended) { unsubscribe(); return; }
  try { await read(); }
  catch (error) { cleanup(); throw error; }
  if (ended) return;
  poll = setInterval(wake, input.pollMs ?? 2_000);
  heartbeat = setInterval(() => write(": heartbeat\n\n"), 15_000);
  deadline = setTimeout(close, input.lifetimeMs ?? 5 * 60_000);
  poll.unref(); heartbeat.unref(); deadline.unref();
}
