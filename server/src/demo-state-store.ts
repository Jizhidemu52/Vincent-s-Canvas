import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type DemoStoredAsset = { id: string; bytes: Uint8Array };
export type DemoStoredTask = {
  id: string;
  requestId: string;
  status: "processing" | "success" | "failed" | "paused";
  errorCode?: string | null;
  failureReason?: string | null;
  updatedAt?: string;
};
export type DemoStateUpdate<A extends DemoStoredAsset, T extends DemoStoredTask> = {
  assets?: readonly A[];
  tasks?: readonly T[];
};

type AssetRow = { id: string; fields_json: string; bytes: Uint8Array };
type TaskRow = { id: string; request_id: string; fields_json: string };

export class DemoStorageError extends Error {
  readonly code = "DEMO_STORAGE_ERROR";

  constructor(readonly operation: string, cause: unknown) {
    super(`本地数据存储失败（${operation}）：${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "DemoStorageError";
  }
}

/** Synchronous durable storage only: loading/recovery never submits work or changes credits. */
export class DemoStateStore<A extends DemoStoredAsset = DemoStoredAsset, T extends DemoStoredTask = DemoStoredTask> {
  private readonly db: Database;

  constructor(path: string) {
    let database: Database | undefined;
    try {
      if (!path.trim()) throw new Error("必须指定本地数据库路径");
      if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
      database = new Database(path, { create: true, strict: true });
      const journal = database.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get();
      if (path !== ":memory:" && journal?.journal_mode.toLowerCase() !== "wal") throw new Error("无法启用 SQLite WAL 日志");
      database.exec("PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
      database.exec(`
        CREATE TABLE IF NOT EXISTS demo_assets (
          id TEXT PRIMARY KEY NOT NULL,
          fields_json TEXT NOT NULL CHECK (json_valid(fields_json)),
          bytes BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS demo_tasks (
          id TEXT PRIMARY KEY NOT NULL,
          request_id TEXT NOT NULL UNIQUE,
          fields_json TEXT NOT NULL CHECK (json_valid(fields_json))
        );
        CREATE TABLE IF NOT EXISTS demo_state_metadata (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
      `);
      this.db = database;
    } catch (error) {
      if (database) {
        try { database.close(true); }
        catch (closeError) { throw new DemoStorageError("打开数据库", new AggregateError([error, closeError], "打开数据库及释放连接失败")); }
      }
      throw new DemoStorageError("打开数据库", error);
    }
  }

  /** Returns detached values. Call recoverInterruptedTasks separately, once at startup. */
  load(): { assets: A[]; tasks: T[] } {
    return this.access("读取状态", () => this.db.transaction(() => ({
      assets: this.db.query<AssetRow, []>("SELECT id, fields_json, bytes FROM demo_assets ORDER BY rowid").all().map((row) => {
        const fields = readFields(row.fields_json);
        if (fields.id !== row.id || !(row.bytes instanceof Uint8Array)) throw new Error("数据库中的素材记录无效");
        return { ...fields, bytes: Uint8Array.from(row.bytes) } as A;
      }),
      tasks: this.readTasks(),
    }))());
  }

  /** Upserts all supplied assets and tasks in one transaction; unrelated records are retained. */
  save(update: DemoStateUpdate<A, T>): void {
    this.access("保存状态", () => this.db.transaction(() => this.writeRows(update)).immediate());
  }

  isInitialized(): boolean {
    return this.access("读取初始化状态", () => this.initialized());
  }

  /** Atomically imports only the first snapshot, including an intentionally empty snapshot. */
  initialize(snapshot: { assets: readonly A[]; tasks: readonly T[] }): boolean {
    return this.access("初始化状态", () => this.db.transaction(() => {
      if (this.initialized()) return false;
      this.writeRows(snapshot);
      this.db.query("INSERT INTO demo_state_metadata (key, value) VALUES ('initialized', '1')").run();
      return true;
    }).immediate());
  }

  /** Explicit startup-only operation. Interrupted paid work must not be submitted/refunded again. */
  recoverInterruptedTasks(): number {
    return this.access("恢复中断任务", () => this.db.transaction(() => {
      const updatedAt = new Date().toISOString();
      const tasks = this.readTasks().filter((task) => task.status === "processing").map((task) => ({
        ...task,
        status: "paused" as const,
        errorCode: "LOCAL_PROCESS_INTERRUPTED",
        failureReason: "本地服务已重启，任务执行已中断；不会自动重新生成或重复提交。已有上游任务可恢复查询原任务。",
        updatedAt,
      }));
      this.writeRows({ tasks });
      return tasks.length;
    }).immediate());
  }

  close(): void {
    this.access("关闭数据库", () => this.db.close(true));
  }

  private initialized(): boolean {
    return this.db.query<{ value: string }, []>("SELECT value FROM demo_state_metadata WHERE key = 'initialized'").get()?.value === "1";
  }

  private readTasks(): T[] {
    return this.db.query<TaskRow, []>("SELECT id, request_id, fields_json FROM demo_tasks ORDER BY rowid").all().map((row) => {
      const fields = readFields(row.fields_json);
      if (fields.id !== row.id || fields.requestId !== row.request_id || !isTaskStatus(fields.status)) throw new Error("数据库中的任务记录无效");
      return fields as T;
    });
  }

  private writeRows(update: DemoStateUpdate<A, T>): void {
    for (const asset of update.assets || []) {
      if (!asset.id || !(asset.bytes instanceof Uint8Array)) throw new Error("待保存的素材记录无效");
      const { bytes, ...fields } = asset;
      this.db.query(`INSERT INTO demo_assets (id, fields_json, bytes) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET fields_json = excluded.fields_json, bytes = excluded.bytes`)
        .run(asset.id, JSON.stringify(fields), bytes);
    }
    for (const task of update.tasks || []) {
      if (!task.id || !task.requestId || !isTaskStatus(task.status)) throw new Error("待保存的任务记录无效");
      this.db.query(`INSERT INTO demo_tasks (id, request_id, fields_json) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET request_id = excluded.request_id, fields_json = excluded.fields_json`)
        .run(task.id, task.requestId, JSON.stringify(task));
    }
  }

  private access<R>(operation: string, run: () => R): R {
    try { return run(); }
    catch (error) { throw error instanceof DemoStorageError ? error : new DemoStorageError(operation, error); }
  }
}

function readFields(json: string): Record<string, unknown> {
  const fields: unknown = JSON.parse(json);
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("数据库记录格式无效");
  return fields as Record<string, unknown>;
}

function isTaskStatus(status: unknown): status is DemoStoredTask["status"] {
  return status === "processing" || status === "success" || status === "failed" || status === "paused";
}
