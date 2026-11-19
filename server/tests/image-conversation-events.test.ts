import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Response } from "express";
import type { Database } from "../src/db";
import { ImageConversationEvents, streamConversationEvents } from "../src/image-conversation-events";
import type { ConversationRow } from "../src/image-conversation-store";
import { expectedRejection } from "./helpers/expected-rejection";

class StreamResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  frames: string[] = [];
  rejectEvents = false;
  status() { return this; }
  set() { return this; }
  flushHeaders() {}
  write(frame: string) { this.frames.push(frame); return !(this.rejectEvents && frame.startsWith("id:")); }
  end() { this.writableEnded = true; this.emit("close"); }
  destroy() { this.destroyed = true; this.emit("close"); }
  sequences() { return this.frames.flatMap(frame => /^id: (\d+)/.test(frame) ? [Number(/^id: (\d+)/.exec(frame)![1])] : []); }
}

async function flush() { for (let step = 0; step < 200; step++) await Promise.resolve(); }

async function withTimers(run: (timers: { tick(ms: number): Promise<void>; active(ms?: number): number }) => Promise<void>) {
  type Timer = { fn: () => void; ms: number; active: boolean; unref(): void };
  const handles: Timer[] = [], original = { setInterval, setTimeout, clearInterval, clearTimeout };
  const schedule = ((fn: () => void, ms: number) => { const timer = { fn, ms, active: true, unref() {} }; handles.push(timer); return timer; }) as unknown as typeof setInterval;
  globalThis.setInterval = schedule;
  globalThis.setTimeout = schedule as unknown as typeof setTimeout;
  globalThis.clearInterval = ((timer: Timer) => { if (timer) timer.active = false; }) as unknown as typeof clearInterval;
  globalThis.clearTimeout = globalThis.clearInterval as unknown as typeof clearTimeout;
  try {
    await run({ tick: async ms => { for (const timer of [...handles]) if (timer.active && timer.ms === ms) timer.fn(); await flush(); },
      active: ms => handles.filter(timer => timer.active && (ms === undefined || timer.ms === ms)).length });
  } finally { Object.assign(globalThis, original); }
}

function database() {
  const now = "2026-11-19T00:00:00.000Z", conversation: ConversationRow = {
    id: randomUUID(), owner_user_id: randomUUID(), title: null, entrypoint: "standalone", project_uuid: null, canvas_external_id: null,
    active_version_id: null, state_revision: 0, last_message_seq: 0, last_event_seq: 0, last_image_no: 0,
    context_summary: { schemaVersion: 1, text: "", goals: [], unresolvedQuestions: [] }, context_summary_through_seq: 0,
    create_request_id: randomUUID(), create_request_hash: "a".repeat(64), created_at: now, updated_at: now,
  };
  const rows: { seq: string; turn_id: null; event_type: "active.changed"; payload: { stateRevision: number; activeVersionId: null; reason: "restore" }; created_at: string }[] = [];
  const statements: string[] = [];
  let connects = 0, releases = 0, pause: Promise<void> | null = null, failure: Error | null = null;
  const db = { connect: async () => { connects++; return {
    query: async (sql: string, values: unknown[] = []) => {
      statements.push(sql);
      if (["BEGIN", "COMMIT", "ROLLBACK", "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"].includes(sql)) return { rows: [] };
      if (sql.startsWith("SELECT * FROM image_conversations")) {
        if (failure) throw failure;
        return { rows: values[0] === conversation.id && values[1] === conversation.owner_user_id ? [{ ...conversation }] : [] };
      }
      if (sql.startsWith("SELECT seq,turn_id,event_type,payload,created_at FROM image_conversation_events")) {
        const selected = rows.filter(row => Number(row.seq) > Number(values[1])).slice(0, 100);
        const pending = pause; pause = null; if (pending) await pending;
        return { rows: selected };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }, release() { releases++; },
  }; } } as unknown as Database;
  const append = (count: number) => {
    for (let index = 0; index < count; index++) {
      const seq = Number(conversation.last_event_seq) + 1;
      conversation.last_event_seq = seq;
      rows.push({ seq: String(seq), turn_id: null, event_type: "active.changed", payload: { stateRevision: seq, activeVersionId: null, reason: "restore" }, created_at: now });
    }
  };
  return { db, conversation, rows, statements, append, pauseNextRead: (pending: Promise<void>) => { pause = pending; },
    failReads: (error: Error | null) => { failure = error; },
    connections: () => ({ connects, releases }) };
}

function open(fixture: ReturnType<typeof database>, events: ImageConversationEvents, afterSeq = 0, response = new StreamResponse(), ownerId = fixture.conversation.owner_user_id) {
  return { response, ready: streamConversationEvents({ db: fixture.db, events, ownerId, conversationId: fixture.conversation.id, afterSeq, response: response as unknown as Response }) };
}

describe("shared owner-scoped image conversation event streams", () => {
  test("one hundred same-conversation streams share repeated periodic SQL reads and local wakes", async () => withTimers(async timers => {
    const fixture = database(), events = new ImageConversationEvents();
    try {
      for (let index = 0; index < 100; index++) await open(fixture, events).ready;
      for (let round = 0; round < 3; round++) {
        const before = fixture.statements.length;
        await timers.tick(2_000);
        expect(fixture.statements.length - before).toBe(5);
      }
      const before = fixture.statements.length;
      events.wake(fixture.conversation.id); await flush();
      expect(fixture.statements.length - before).toBe(5);
      await timers.tick(15_000);
      expect(fixture.statements.length - before).toBe(5);
      expect(fixture.connections().connects).toBe(fixture.connections().releases);
    } finally { events.close(); }
    expect(timers.active()).toBe(0);
  }));

  test("different subscription cursors receive their own contiguous backlog and then one shared update", async () => withTimers(async timers => {
    const fixture = database(), events = new ImageConversationEvents(); fixture.append(205);
    try {
      const first = open(fixture, events, 0); await first.ready; await flush();
      const second = open(fixture, events, 100); await second.ready; await flush();
      const latest = open(fixture, events, 205); await latest.ready; await flush();
      expect(first.response.sequences()).toEqual(Array.from({ length: 205 }, (_, index) => index + 1));
      expect(second.response.sequences()).toEqual(Array.from({ length: 105 }, (_, index) => index + 101));
      expect(latest.response.sequences()).toEqual([]);
      fixture.append(1);
      const before = fixture.statements.length; await timers.tick(2_000);
      expect(fixture.statements.length - before).toBe(5);
      expect(first.response.sequences().at(-1)).toBe(206);
      expect(second.response.sequences().at(-1)).toBe(206);
      expect(latest.response.sequences()).toEqual([206]);
    } finally { events.close(); }
  }));

  test("foreign owners and invalid cursors cannot consume another subscriber's authorization or close it", async () => withTimers(async timers => {
    const fixture = database(), events = new ImageConversationEvents(); fixture.append(3);
    try {
      const current = open(fixture, events, 3); await current.ready;
      const stranger = open(fixture, events, 0, new StreamResponse(), randomUUID());
      expect(await expectedRejection(stranger.ready)).toMatchObject({ status: 404, code: "NOT_FOUND" });
      expect(stranger.response.frames).toEqual([]);
      expect(await expectedRejection(open(fixture, events, 4).ready)).toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
      fixture.rows.splice(1, 1);
      expect(await expectedRejection(open(fixture, events, 0).ready)).toMatchObject({ status: 410, code: "EVENT_CURSOR_EXPIRED" });
      expect(current.response.writableEnded).toBe(false);
      fixture.append(1); await timers.tick(2_000);
      expect(current.response.sequences()).toEqual([4]);
    } finally { events.close(); }
  }));

  test("the last subscriber releases timers and retained state while individual backpressure stays isolated", async () => withTimers(async timers => {
    const fixture = database(), events = new ImageConversationEvents();
    const blocked = open(fixture, events), healthy = open(fixture, events);
    await Promise.all([blocked.ready, healthy.ready]);
    try {
      blocked.response.rejectEvents = true; fixture.append(1); await timers.tick(2_000);
      expect(blocked.response.destroyed).toBe(true);
      expect(healthy.response.sequences()).toEqual([1]);
      expect(healthy.response.destroyed).toBe(false);
      healthy.response.end();
      expect(timers.active()).toBe(0);
      const before = fixture.statements.length;
      events.wake(fixture.conversation.id); await timers.tick(2_000);
      expect(fixture.statements.length).toBe(before);
      fixture.rows.length = 0;
      expect(await expectedRejection(open(fixture, events, 0).ready)).toMatchObject({ status: 410 });
      expect(timers.active()).toBe(0);
    } finally { events.close(); }
  }));

  test("a lower cursor joining during an in-flight read catches up without dropping its history", async () => withTimers(async () => {
    const fixture = database(), events = new ImageConversationEvents(); fixture.append(10);
    const reply = Promise.withResolvers<void>(); fixture.pauseNextRead(reply.promise);
    try {
      const latest = open(fixture, events, 10); await flush();
      const older = open(fixture, events, 0); await flush();
      reply.resolve(); await Promise.all([latest.ready, older.ready]); await flush();
      expect(latest.response.sequences()).toEqual([]);
      expect(older.response.sequences()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    } finally { reply.resolve(); events.close(); }
  }));

  test("database errors close the affected streams once instead of looping or retaining a polling reader", async () => withTimers(async timers => {
    const fixture = database(), events = new ImageConversationEvents();
    try {
      const first = open(fixture, events), second = open(fixture, events); await Promise.all([first.ready, second.ready]); await flush();
      fixture.failReads(new Error("Fixture database is unavailable"));
      const before = fixture.statements.length; await timers.tick(2_000);
      expect(fixture.statements.length - before).toBe(4);
      expect(first.response.writableEnded).toBe(true); expect(second.response.writableEnded).toBe(true);
      expect(timers.active()).toBe(0);
      events.wake(fixture.conversation.id); await timers.tick(2_000);
      expect(fixture.statements.length - before).toBe(4);
      expect(await expectedRejection(open(fixture, events).ready)).toMatchObject({ message: "Fixture database is unavailable" });
      expect(timers.active()).toBe(0);
      fixture.failReads(null);
      const recovered = open(fixture, events); await recovered.ready;
      expect(recovered.response.frames).toEqual([": connected\n\n"]);
    } finally { events.close(); }
  }));

  test("a subscriber joining a previous snapshot verifies its newer cursor against a fresh database read", async () => withTimers(async () => {
    const fixture = database(), events = new ImageConversationEvents(), reply = Promise.withResolvers<void>();
    fixture.pauseNextRead(reply.promise);
    try {
      const original = open(fixture, events); await flush();
      fixture.append(1);
      const newer = open(fixture, events, 1);
      const result = Promise.all([original.ready, newer.ready]);
      reply.resolve(); await result; await flush();
      expect(original.response.sequences()).toEqual([1]);
      expect(newer.response.sequences()).toEqual([]);
      expect(newer.response.writableEnded).toBe(false);
    } finally { reply.resolve(); events.close(); }
  }));

  test("disconnect during the first query releases the last subscriber without waiting for its database reply", async () => withTimers(async timers => {
    const fixture = database(), events = new ImageConversationEvents(), reply = Promise.withResolvers<void>();
    fixture.pauseNextRead(reply.promise);
    try {
      const pending = open(fixture, events); await flush();
      pending.response.end(); await pending.ready;
      expect(timers.active()).toBe(0);
      reply.resolve(); await flush();
      expect(pending.response.frames).toEqual([]);
      expect(fixture.connections()).toEqual({ connects: 1, releases: 1 });
      const before = fixture.statements.length;
      events.wake(fixture.conversation.id); await timers.tick(2_000);
      expect(fixture.statements.length).toBe(before);
    } finally { reply.resolve(); events.close(); }
  }));

  test("per-subscription lifetimes and application drain release all streams and prevent new polling", async () => withTimers(async timers => {
    const fixture = database(), events = new ImageConversationEvents();
    const first = open(fixture, events), second = open(fixture, events); await Promise.all([first.ready, second.ready]);
    await timers.tick(300_000);
    expect(first.response.writableEnded).toBe(true); expect(second.response.writableEnded).toBe(true);
    expect(timers.active()).toBe(0);
    const reopened = open(fixture, events); await reopened.ready;
    events.close();
    expect(reopened.response.writableEnded).toBe(true);
    const before = fixture.statements.length, refused = open(fixture, events); await refused.ready;
    expect(refused.response.writableEnded).toBe(true);
    expect(fixture.statements.length).toBe(before);
    expect(timers.active()).toBe(0);
  }));

  test("one subscription reaching its authentication lifetime does not end a later subscription", async () => withTimers(async timers => {
    const fixture = database(), events = new ImageConversationEvents(), early = new StreamResponse(), later = new StreamResponse();
    try {
      for (const [response, lifetimeMs] of [[early, 25], [later, 50]] as const) {
        await streamConversationEvents({ db: fixture.db, events, ownerId: fixture.conversation.owner_user_id,
          conversationId: fixture.conversation.id, afterSeq: 0, response: response as unknown as Response, lifetimeMs });
      }
      await timers.tick(25);
      expect(early.writableEnded).toBe(true);
      expect(later.writableEnded).toBe(false);
      fixture.append(1); await timers.tick(2_000);
      expect(early.sequences()).toEqual([]);
      expect(later.sequences()).toEqual([1]);
      await timers.tick(50);
      expect(later.writableEnded).toBe(true);
      expect(timers.active()).toBe(0);
    } finally { events.close(); }
  }));
});
