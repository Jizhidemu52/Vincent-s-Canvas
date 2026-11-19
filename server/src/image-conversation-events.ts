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
  private readonly readers = new WeakMap<Database, Map<string, ConversationEventReader>>();
  private closed = false;
  constructor() { this.emitter.setMaxListeners(0); }
  wake(conversationId: string) { this.emitter.emit(conversationId); }
  subscribe(conversationId: string, wake: () => void, close: () => void) {
    if (this.closed) { close(); return () => {}; }
    this.emitter.on(conversationId, wake);
    this.closures.add(close);
    return () => { this.emitter.off(conversationId, wake); this.closures.delete(close); };
  }
  subscribeStream(db: Database, ownerId: string, conversationId: string, pollMs: number, subscriber: EventSubscriber) {
    if (this.closed) { subscriber.close(); return () => {}; }
    let readers = this.readers.get(db);
    if (!readers) { readers = new Map(); this.readers.set(db, readers); }
    const key = JSON.stringify([ownerId, conversationId, pollMs]);
    let reader = readers.get(key);
    if (!reader) {
      const registry = readers;
      reader = new ConversationEventReader(db, ownerId, conversationId, pollMs, this, () => registry.delete(key));
      readers.set(key, reader);
    }
    return reader.subscribe(subscriber);
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
type EventBatch = Awaited<ReturnType<typeof readConversationEvents>>;
type EventSubscriber = { cursor: number; receive(batch: EventBatch): void; fail(error: unknown): void; close(): void };

class ConversationEventReader {
  private readonly subscribers = new Set<EventSubscriber>();
  private readonly unsubscribe: () => void;
  private poll: ReturnType<typeof setInterval> | undefined;
  private reading = false;
  private dirty = false;
  private closed = false;
  constructor(private readonly db: Database, private readonly ownerId: string, private readonly conversationId: string,
    private readonly pollMs: number, events: ImageConversationEvents, private readonly onEmpty: () => void) {
    this.unsubscribe = events.subscribe(conversationId, () => this.wake(), () => this.close());
  }
  subscribe(subscriber: EventSubscriber) {
    this.subscribers.add(subscriber);
    this.wake();
    return () => { this.subscribers.delete(subscriber); if (!this.subscribers.size) this.close(); };
  }
  private wake() {
    if (this.closed) return;
    this.dirty = true;
    if (!this.reading) void this.read();
  }
  private close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.poll);
    this.unsubscribe();
    this.onEmpty();
    for (const subscriber of [...this.subscribers]) subscriber.close();
    this.subscribers.clear();
  }
  private async read() {
    this.reading = true;
    try {
      do {
        this.dirty = false;
        const subscribers = [...this.subscribers];
        let cursor = Infinity;
        for (const subscriber of subscribers) cursor = Math.min(cursor, subscriber.cursor);
        let batch: EventBatch;
        try { batch = await readConversationEvents(this.db, this.ownerId, this.conversationId, cursor); }
        catch (error) {
          if (this.closed) return;
          if (error instanceof ImageConversationError && (error.status === 400 || error.status === 410)) {
            for (const subscriber of subscribers) if (this.subscribers.has(subscriber) && subscriber.cursor === cursor) subscriber.fail(error);
            this.dirty = this.subscribers.size > 0;
            continue;
          }
          throw error;
        }
        if (this.closed) return;
        for (const subscriber of subscribers) {
          if (!this.subscribers.has(subscriber)) continue;
          if (subscriber.cursor > batch.latestEventSeq) {
            subscriber.fail(new ImageConversationError(400, "VALIDATION_ERROR", "事件序号不能超过当前会话"));
            continue;
          }
          try { subscriber.receive(batch); } catch (error) { subscriber.fail(error); }
        }
        if (this.closed) return;
        if (!this.poll) { this.poll = setInterval(() => this.wake(), this.pollMs); this.poll.unref(); }
        if ([...this.subscribers].some(subscriber => subscriber.cursor < batch.latestEventSeq)) this.dirty = true;
      } while (this.dirty && !this.closed);
    } catch (error) {
      for (const subscriber of [...this.subscribers]) subscriber.fail(error);
    } finally { this.reading = false; }
  }
}
export async function streamConversationEvents(input: {
  db: Database; events: ImageConversationEvents; ownerId: string; conversationId: string;
  afterSeq: number; response: Response; pollMs?: number; lifetimeMs?: number;
}) {
  const { response } = input;
  let ended = false;
  let opened = false;
  const initial = Promise.withResolvers<void>();
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat); clearTimeout(deadline);
    unsubscribe();
    response.off("close", cleanup); response.off("error", cleanup);
    initial.resolve();
  };
  const close = () => { cleanup(); if (!response.writableEnded) response.end(); };
  const write = (frame: string) => {
    if (ended || response.destroyed) { cleanup(); return false; }
    if (!response.write(frame)) { cleanup(); response.destroy(); return false; }
    return true;
  };
  const subscriber: EventSubscriber = {
    cursor: input.afterSeq,
    receive(batch) {
      if (ended) return;
      if (!opened) {
        response.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "private, no-store", "X-Accel-Buffering": "no" });
        response.flushHeaders(); opened = true;
        if (!write(": connected\n\n")) return;
      }
      for (const event of batch.events) {
        if (event.seq <= subscriber.cursor) continue;
        if (!write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(toPublicImageConversationData(event))}\n\n`)) return;
        subscriber.cursor = event.seq;
      }
      initial.resolve();
    },
    fail(error) { if (opened) close(); else { initial.reject(error); cleanup(); } },
    close,
  };
  response.once("close", cleanup); response.once("error", cleanup);
  unsubscribe = input.events.subscribeStream(input.db, input.ownerId, input.conversationId, input.pollMs ?? 2_000, subscriber);
  if (ended) { unsubscribe(); return; }
  try { await initial.promise; }
  catch (error) { cleanup(); throw error; }
  if (ended) return;
  heartbeat = setInterval(() => write(": heartbeat\n\n"), 15_000);
  deadline = setTimeout(close, input.lifetimeMs ?? 5 * 60_000);
  heartbeat.unref(); deadline.unref();
}
