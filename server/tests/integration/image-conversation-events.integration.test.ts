import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Response } from "express";
import type { PoolClient } from "pg";
import { withTransaction } from "../../src/db-transaction";
import { ImageConversationEvents, streamConversationEvents } from "../../src/image-conversation-events";
import { createImageConversation } from "../../src/image-conversation-service";
import { appendConversationEvent, readConversation } from "../../src/image-conversation-store";
import { conversationDatabaseMode, createConversationPostgres } from "../helpers/conversation-postgres";
import { expectedRejection } from "../helpers/expected-rejection";

class StreamResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  frames: string[] = [];
  status() { return this; }
  set() { return this; }
  flushHeaders() {}
  write(frame: string) { this.frames.push(frame); return true; }
  end() { this.writableEnded = true; this.emit("close"); }
  destroy() { this.destroyed = true; this.emit("close"); }
  sequences() { return this.frames.flatMap(frame => /^id: (\d+)/.test(frame) ? [Number(/^id: (\d+)/.exec(frame)![1])] : []); }
}

async function until(ready: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the real PostgreSQL event read");
    await Bun.sleep(5);
  }
}

const integration = conversationDatabaseMode() === "postgres" ? describe : describe.skip;
integration("shared conversation SSE readers on PostgreSQL 17", () => {
  let fixture: Awaited<ReturnType<typeof createConversationPostgres>>;
  beforeAll(async () => { fixture = await createConversationPostgres(); }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  async function conversation() {
    const ownerId = randomUUID();
    await fixture.db.query("INSERT INTO users(id,username,display_name) VALUES($1,$2,'Event reader fixture')", [ownerId, `events-${ownerId}`]);
    const { snapshot } = await createImageConversation(fixture.db, ownerId, { clientRequestId: randomUUID(), entrypoint: "standalone" });
    return { ownerId, conversationId: snapshot.id, afterSeq: snapshot.latestEventSeq };
  }
  const append = (ownerId: string, conversationId: string) => withTransaction(fixture.db, async client => {
    const row = await readConversation(client, ownerId, conversationId, true);
    await appendConversationEvent(client, row, null, "active.changed", { stateRevision: 0, activeVersionId: null, reason: "restore" });
  });

  test("100 live subscriptions share three real two-second polls with five SQL commands per poll", async () => {
    const identity = await conversation(), events = new ImageConversationEvents(), responses: StreamResponse[] = [];
    const open = async (afterSeq = identity.afterSeq, ownerId = identity.ownerId) => {
      const response = new StreamResponse(); responses.push(response);
      await streamConversationEvents({ db: fixture.db, events, ...identity, afterSeq, ownerId, response: response as unknown as Response });
      return response;
    };
    try {
      for (let index = 0; index < 100; index++) await open();
      const commandsPerPoll: number[] = [], selectsPerPoll: number[] = [];
      for (let round = 0; round < 3; round++) {
        const before = fixture.statements.length, transactions = fixture.transactions.length;
        await until(() => fixture.transactions.length > transactions && fixture.transactions.at(-1)?.at(-1) === "COMMIT");
        const statements = fixture.statements.slice(before);
        commandsPerPoll.push(statements.length);
        selectsPerPoll.push(statements.filter(sql => sql.startsWith("SELECT")).length);
        expect(statements).toHaveLength(5);
        expect(fixture.transactions.length - transactions).toBe(1);
        expect(selectsPerPoll.at(-1)).toBe(2);
      }
      expect(await expectedRejection(open(identity.afterSeq, randomUUID()))).toMatchObject({ status: 404, code: "NOT_FOUND" });
      expect(await expectedRejection(open(identity.afterSeq + 1))).toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
      await append(identity.ownerId, identity.conversationId);
      const before = fixture.statements.length;
      events.wake(identity.conversationId);
      await until(() => responses.slice(0, 100).every(response => response.sequences().at(-1) === 2));
      expect(fixture.statements.length - before).toBe(5);
      expect(responses.slice(0, 100).every(response => !response.writableEnded)).toBe(true);
      await fixture.db.query("DELETE FROM image_conversation_events WHERE conversation_id=$1 AND seq=1", [identity.conversationId]);
      const beforeExpired = fixture.transactions.length;
      expect(await expectedRejection(open(0))).toMatchObject({ status: 410, code: "EVENT_CURSOR_EXPIRED" });
      await until(() => fixture.transactions.length >= beforeExpired + 2 && fixture.transactions.at(-1)?.at(-1) === "COMMIT");
      expect(responses.slice(0, 100).every(response => !response.writableEnded)).toBe(true);
      console.info(JSON.stringify({ probe: "conversation-sse-shared-polls", backend: fixture.backend, streams: 100, commandsPerPoll, selectsPerPoll, wakeCommands: 5 }));
    } finally { for (const response of responses) response.end(); events.close(); }
    const stopped = fixture.statements.length;
    events.wake(identity.conversationId); await Bun.sleep(2_100);
    expect(fixture.statements.length).toBe(stopped);
    expect((await fixture.db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1 AND state='idle in transaction'", [fixture.schema])).rows[0].n).toBe(0);
  }, 15_000);

  test("a newly joined newer cursor is checked against a new repeatable-read snapshot", async () => {
    const identity = await conversation(), events = new ImageConversationEvents();
    const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let pause = true;
    const db = new Proxy(fixture.db, { get(target, key) {
      if (key === "connect") return async () => {
        const client = await target.connect();
        return new Proxy(client, { get(connection, property) {
          if (property === "query") return async (...args: unknown[]) => {
            const result = await Reflect.apply(connection.query, connection, args);
            if (pause && typeof args[0] === "string" && args[0].startsWith("SELECT seq,turn_id,event_type,payload,created_at")) {
              pause = false; reached.resolve(); await release.promise;
            }
            return result;
          };
          const value = Reflect.get(connection, property);
          return typeof value === "function" ? value.bind(connection) : value;
        } }) as PoolClient;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const original = new StreamResponse(), newer = new StreamResponse();
    try {
      const first = streamConversationEvents({ db, events, ...identity, response: original as unknown as Response });
      await reached.promise;
      await append(identity.ownerId, identity.conversationId);
      const second = streamConversationEvents({ db, events, ...identity, afterSeq: 2, response: newer as unknown as Response });
      const ready = Promise.all([first, second]); release.resolve(); await ready;
      await until(() => original.sequences().at(-1) === 2);
      expect(original.sequences()).toEqual([2]);
      expect(newer.sequences()).toEqual([]);
      expect(newer.writableEnded).toBe(false);
    } finally { release.resolve(); events.close(); }
  });
});
