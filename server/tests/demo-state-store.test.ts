import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemoStateStore, DemoStorageError, type DemoStoredAsset, type DemoStoredTask } from "../src/demo-state-store";

type Asset = DemoStoredAsset & { ownerUserId: string; mimeType: string; filename: string; metadata?: { name: string; tags: string[] }; clientReferenceId?: string; byteSize?: number };
type Task = DemoStoredTask & { ownerUserId: string; credits: number; resultUrls: string[]; upstreamTaskId?: string; submissionStartedAt?: string; parameters?: Record<string, unknown> };
const folders: string[] = [];
const stores: DemoStateStore<Asset, Task>[] = [];

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "canvas-demo-state-test-"));
  folders.push(directory);
  return join(directory, "nested", "state.sqlite");
}

function open(path = databasePath()) {
  const store = new DemoStateStore<Asset, Task>(path);
  stores.push(store);
  return store;
}

function asset(id = "asset-1"): Asset {
  return { id, ownerUserId: "owner", filename: "原图.png", mimeType: "image/png", bytes: new Uint8Array([0, 1, 127, 128, 255]), metadata: { name: "正面", tags: ["针织", "方案"] } };
}

function task(id = "task-1", requestId = "request-1"): Task {
  return { id, requestId, ownerUserId: "owner", status: "success", credits: 3, resultUrls: ["/api/assets/asset-1/content"], parameters: { size: "16:9", references: ["a", "b"] } };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  // Each path is a test-owned mkdtemp result, never a workspace or user directory.
  for (const directory of folders.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("creates parent directory, uses WAL/FULL and preserves raw bytes plus all fields on reopen", () => {
  const path = databasePath();
  const first = open(path);
  first.save({ assets: [asset()], tasks: [task()] });
  const connection = Reflect.get(first, "db") as Database;
  expect(connection.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  expect(connection.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
  first.close();
  const reopened = open(path);
  const state = reopened.load();
  expect(state).toEqual({ assets: [asset()], tasks: [task()] });
  state.assets[0]!.bytes[0] = 99;
  state.tasks[0]!.resultUrls.push("changed in memory");
  expect(reopened.load()).toEqual({ assets: [asset()], tasks: [task()] });
});

test("persists an empty upload reservation and later bytes/metadata updates without removing other assets", () => {
  const path = databasePath();
  const placeholder = { ...asset(), bytes: new Uint8Array(), byteSize: 5, clientReferenceId: "canvas-image:1" };
  const first = open(path);
  first.save({ assets: [placeholder, asset("unrelated")] });
  first.close();
  const reopened = open(path);
  expect(reopened.load().assets[0]).toEqual(placeholder);
  const completed = { ...placeholder, bytes: asset().bytes, metadata: { name: "修订正面", tags: ["已核对"] } };
  reopened.save({ assets: [completed] });
  reopened.close();
  expect(open(path).load().assets).toEqual([completed, asset("unrelated")]);
});

test("requestId uniqueness rolls back the entire asset/task update and retains earlier rows", () => {
  const store = open();
  store.save({ assets: [asset()], tasks: [task()] });
  const changed = { ...asset(), filename: "must roll back.png" };
  expect(() => store.save({ assets: [changed, asset("new")], tasks: [task("new-task", "new-request"), task("duplicate-id", "request-1")] })).toThrow(DemoStorageError);
  expect(store.load()).toEqual({ assets: [asset()], tasks: [task()] });
  store.save({ tasks: [{ ...task(), status: "failed", failureReason: "正常状态更新" }] });
  expect(store.load().tasks[0]).toMatchObject({ id: "task-1", requestId: "request-1", status: "failed" });
});

test("initialization imports only once across reopen and failed imports leave no flag or partial rows", () => {
  const path = databasePath();
  const first = open(path);
  expect(first.isInitialized()).toBe(false);
  expect(() => first.initialize({ assets: [asset()], tasks: [task(), task("duplicate")] })).toThrow(DemoStorageError);
  expect(first.isInitialized()).toBe(false);
  expect(first.load()).toEqual({ assets: [], tasks: [] });
  expect(first.initialize({ assets: [asset()], tasks: [task()] })).toBe(true);
  expect(first.isInitialized()).toBe(true);
  first.close();
  const reopened = open(path);
  expect(reopened.initialize({ assets: [asset("ignored")], tasks: [] })).toBe(false);
  expect(reopened.load()).toEqual({ assets: [asset()], tasks: [task()] });
});

test("empty initialization is durable and prevents a stale snapshot from being imported later", () => {
  const path = databasePath();
  const first = open(path);
  expect(first.initialize({ assets: [], tasks: [] })).toBe(true);
  first.close();
  const reopened = open(path);
  expect(reopened.isInitialized()).toBe(true);
  expect(reopened.initialize({ assets: [asset()], tasks: [task()] })).toBe(false);
  expect(reopened.load()).toEqual({ assets: [], tasks: [] });
});

test("startup recovery durably pauses only processing tasks without replaying or changing credits/IDs", () => {
  const path = databasePath();
  const running: Task = { ...task(), status: "processing", resultUrls: [], upstreamTaskId: "paid-upstream-id", submissionStartedAt: "2026-09-11T00:00:00.000Z" };
  const completed = task("finished", "finished-request");
  const failed: Task = { ...task("failed", "failed-request"), status: "failed", failureReason: "已失败" };
  const first = open(path);
  first.save({ tasks: [running, completed, failed] });
  first.close();
  const restarted = open(path);
  expect(restarted.load().tasks[0]!.status).toBe("processing");
  expect(restarted.recoverInterruptedTasks()).toBe(1);
  const recovered = restarted.load();
  expect(recovered.tasks[0]).toMatchObject({ ...running, status: "paused", errorCode: "LOCAL_PROCESS_INTERRUPTED" });
  expect(recovered.tasks[0]!.failureReason).toContain("不会自动重新生成或重复提交");
  expect(Number.isNaN(Date.parse(recovered.tasks[0]!.updatedAt!))).toBe(false);
  expect(recovered.tasks.slice(1)).toEqual([completed, failed]);
  expect(restarted.recoverInterruptedTasks()).toBe(0);
  expect(restarted.load()).toEqual(recovered);
  restarted.close();
  expect(open(path).load()).toEqual(recovered);
});

test("read-only SQLite failures are classified and do not change already saved state", () => {
  const store = open();
  store.save({ assets: [asset()] });
  // Fault injection on this connection avoids platform-dependent Windows file permission behavior.
  const connection = Reflect.get(store, "db") as Database;
  connection.exec("PRAGMA query_only = ON");
  let failure: unknown;
  try { store.save({ assets: [asset("blocked")] }); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(DemoStorageError);
  expect((failure as DemoStorageError).code).toBe("DEMO_STORAGE_ERROR");
  expect((failure as DemoStorageError).cause).toMatchObject({ code: "SQLITE_READONLY" });
  expect(store.load().assets).toEqual([asset()]);
});

test("bad databases are reported without being replaced or deleted", () => {
  const directory = mkdtempSync(join(tmpdir(), "canvas-demo-state-test-"));
  folders.push(directory);
  const path = join(directory, "broken.sqlite");
  const original = Buffer.from("not a sqlite database: preserve me");
  writeFileSync(path, original);
  expect(() => new DemoStateStore(path)).toThrow(DemoStorageError);
  expect(readFileSync(path)).toEqual(original);
});

test("in-memory databases need no parent path and serialization failures roll back writes", () => {
  const store = open(":memory:");
  const cyclic = task();
  cyclic.parameters = { self: cyclic };
  expect(() => store.save({ assets: [asset()], tasks: [cyclic] })).toThrow(DemoStorageError);
  expect(store.load()).toEqual({ assets: [], tasks: [] });
});
