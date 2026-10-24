import { Router } from "express";
import type { Notification, PoolClient } from "pg";
import { z } from "zod";
import type { Database } from "./db";
import type { AuthenticatedRequest } from "./types";

export const TASK_EVENTS_CHANNEL = "canvas_task_changes";
export const TASK_EVENTS_HEARTBEAT_MS = 15_000;
export const TASK_EVENTS_MAX_CONNECTION_MS = 5 * 60_000;

const changeSchema = z.object({ id: z.string().uuid(), userId: z.string().uuid() });
const subscriptionSchema = z.object({
  ids: z.string().max(3_699).transform(value => value.split(",")).pipe(z.array(z.string().uuid()).min(1).max(100)),
  ownerId: z.string().uuid(),
});

type Subscription = { ids: Set<string>; changed: (ids: string[]) => void; close: () => void };
type Connection = { client: PoolClient; notification: (message: Notification) => void; disconnected: () => void };

/** One checked-out LISTEN connection per API process, never per browser. The
 * event is only a hint to reread the existing owner-scoped task snapshot API. */
export class TaskEventsService {
  private readonly subscriptions = new Map<string, Set<Subscription>>();
  private connection?: Connection;
  private connecting?: Promise<void>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private draining = false;
  private retryDelay: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(private readonly db: Pick<Database, "connect">, options: { retryBaseMs?: number; retryMaxMs?: number } = {}) {
    this.retryBaseMs = options.retryBaseMs ?? 1_000;
    this.retryMaxMs = options.retryMaxMs ?? 30_000;
    this.retryDelay = this.retryBaseMs;
  }

  start(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.stopped || this.connection || this.reconnectTimer) return Promise.resolve();
    this.connecting = this.connect().finally(() => {
      this.connecting = undefined;
      if (!this.connection) this.reconnect();
    });
    return this.connecting;
  }

  subscribe(ownerId: string, ids: readonly string[], changed: (ids: string[]) => void, close: () => void) {
    if (this.stopped || this.draining) { close(); return () => {}; }
    const owner = ownerId.toLowerCase();
    const subscription = { ids: new Set(ids.map(id => id.toLowerCase())), changed, close };
    const bucket = this.subscriptions.get(owner) ?? new Set<Subscription>();
    bucket.add(subscription);
    this.subscriptions.set(owner, bucket);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      bucket.delete(subscription);
      if (!bucket.size && this.subscriptions.get(owner) === bucket) this.subscriptions.delete(owner);
    };
  }

  drain() {
    this.draining = true;
    const subscriptions = [...this.subscriptions.values()].flatMap(bucket => [...bucket]);
    this.subscriptions.clear();
    for (const subscription of subscriptions) {
      try { subscription.close(); } catch { /* One closed browser cannot prevent shutdown. */ }
    }
  }

  async close() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.connection) this.release(this.connection);
    this.drain();
    // A pool checkout already in progress releases itself when it resolves.
    // Do not leave shutdown waiting on a pool connection that is unavailable.
  }

  private async connect() {
    let connection: Connection | undefined;
    try {
      const client = await this.db.connect();
      if (this.stopped) { client.release(true); return; }
      connection = {
        client,
        notification: message => this.notification(message),
        disconnected: () => {
          if (this.connection !== connection) return;
          this.release(connection!);
          this.reconnect();
        },
      };
      this.connection = connection;
      client.on("notification", connection.notification);
      client.on("error", connection.disconnected);
      client.on("end", connection.disconnected);
      await client.query(`LISTEN ${TASK_EVENTS_CHANNEL}`);
      if (this.stopped || this.connection !== connection) return;
      this.retryDelay = this.retryBaseMs;
      // A disconnected listener can miss commits. Invalidate every subscriber
      // after LISTEN is active again, including the initial asynchronous start.
      for (const bucket of this.subscriptions.values()) for (const subscription of [...bucket]) {
        this.emit(subscription, [...subscription.ids]);
      }
    } catch {
      if (connection && this.connection === connection) this.release(connection);
      if (!this.stopped) console.warn("Task event listener unavailable; reconnecting with backoff");
    }
  }

  private reconnect() {
    if (this.stopped || this.connection || this.connecting || this.reconnectTimer) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, this.retryMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.start();
    }, delay);
    this.reconnectTimer.unref();
  }

  private release(connection: Connection) {
    connection.client.off("notification", connection.notification);
    connection.client.off("error", connection.disconnected);
    connection.client.off("end", connection.disconnected);
    if (this.connection === connection) this.connection = undefined;
    // Destroy the dedicated connection instead of returning a LISTEN session
    // to the shared query pool. This also removes the PostgreSQL subscription.
    connection.client.release(true);
  }

  private notification(message: Notification) {
    if (message.channel !== TASK_EVENTS_CHANNEL || !message.payload || message.payload.length > 1_024) return;
    let decoded: unknown;
    try { decoded = JSON.parse(message.payload); } catch { return; }
    const change = changeSchema.safeParse(decoded);
    if (!change.success) return;
    const bucket = this.subscriptions.get(change.data.userId.toLowerCase());
    if (!bucket) return;
    const id = change.data.id.toLowerCase();
    for (const subscription of [...bucket]) if (subscription.ids.has(id)) this.emit(subscription, [id]);
  }

  private emit(subscription: Subscription, ids: string[]) {
    try { subscription.changed(ids); }
    catch {
      for (const [owner, bucket] of this.subscriptions) {
        bucket.delete(subscription);
        if (!bucket.size) this.subscriptions.delete(owner);
      }
      try { subscription.close(); } catch { /* Continue delivering to other browsers. */ }
    }
  }
}

export function createTasksEventsRouter(events: Pick<TaskEventsService, "subscribe">,
  options: { heartbeatMs?: number; maxConnectionMs?: number } = {}) {
  const router = Router();
  router.get("/", (request, response, next) => {
    try {
      const actor = (request as AuthenticatedRequest).auth;
      if (!actor) { response.status(401).json({ error: "UNAUTHENTICATED", message: "请先登录" }); return; }
      const input = subscriptionSchema.parse(request.query);
      if (input.ownerId.toLowerCase() !== actor.id.toLowerCase()) {
        response.status(403).json({ error: "CANVAS_OWNER_MISMATCH", message: "当前员工身份已变化，请重新打开画布后再试。" });
        return;
      }
      if (response.destroyed) return;
      const ids = [...new Set(input.ids.map(id => id.toLowerCase()))];
      response.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "private, no-store", "X-Accel-Buffering": "no" });
      response.flushHeaders();
      let ended = false;
      let unsubscribe = () => {};
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (ended) return;
        ended = true;
        clearInterval(heartbeat); clearTimeout(deadline);
        unsubscribe();
        response.off("close", cleanup); response.off("error", cleanup);
      };
      const end = () => { cleanup(); if (!response.writableEnded) response.end(); };
      const write = (frame: string) => {
        if (ended || response.destroyed) { cleanup(); return; }
        // A slow browser should reconnect and reread its snapshot, not build an
        // unbounded notification buffer in the API process.
        if (!response.write(frame)) { cleanup(); response.destroy(); }
      };
      response.once("close", cleanup); response.once("error", cleanup);
      unsubscribe = events.subscribe(actor.id, ids, changed => write(`event: tasks-changed\ndata: ${JSON.stringify({ ids: changed })}\n\n`), end);
      if (ended) { unsubscribe(); return; }
      write(`event: tasks-changed\ndata: ${JSON.stringify({ ids })}\n\n`);
      if (ended) return;
      heartbeat = setInterval(() => write(": heartbeat\n\n"), options.heartbeatMs ?? TASK_EVENTS_HEARTBEAT_MS);
      deadline = setTimeout(end, options.maxConnectionMs ?? TASK_EVENTS_MAX_CONNECTION_MS);
      heartbeat.unref(); deadline.unref();
    } catch (error) { next(error); }
  });
  return router;
}
