import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  DesignLibraryError, DesignLibraryService, designLibraryFailure, designLibraryMediaCacheControl, designLibraryMediaVary,
  type DesignLibraryActor, type DesignLibraryMediaStore, type DesignLibraryRepository, type DesignLibraryStatus,
  type LibraryDelivery, type LibraryListFilter, type LibraryMetricRow, type LibraryPrivateAsset,
  type LibraryPublication, type LibraryReceipt, type LibrarySourceAsset,
} from "./design-library";
import { DemoStorageError } from "./demo-state-store";

export type DemoLibraryAsset = {
  id: string; ownerUserId: string; filename: string; mimeType: string; bytes: Uint8Array;
  byteSize: number; createdAt: string; metadata: Record<string, unknown>;
};
type JsonRow = { fields_json: string };
const sourceKeyPrefix = "demo-assets/";

/** SQLite owns snapshots, receipts and the receiver's actual private asset in the same commit.
 * Only the post-commit callback may update the demo server's in-memory asset cache.
 */
export class DemoDesignLibraryStore implements DesignLibraryRepository, DesignLibraryMediaStore {
  private readonly db: Database;
  private transactions: Promise<void> = Promise.resolve();
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private pendingAssets: DemoLibraryAsset[] | null = null;

  constructor(path: string, private readonly onCommittedAsset: (asset: DemoLibraryAsset) => void = () => {}) {
    if (!path.trim()) throw new DemoStorageError("打开灵感库", new Error("必须指定本地数据库路径"));
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    try {
      const journal = this.db.query<{ journal_mode: string }, []>("PRAGMA journal_mode=WAL").get();
      if (path !== ":memory:" && journal?.journal_mode.toLowerCase() !== "wal") throw new Error("无法启用 SQLite WAL 日志");
      this.db.exec(`PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS demo_assets (
          id TEXT PRIMARY KEY NOT NULL, fields_json TEXT NOT NULL CHECK(json_valid(fields_json)), bytes BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS demo_library_publications (
          id TEXT PRIMARY KEY NOT NULL, author_id TEXT NOT NULL, department_id TEXT,
          request_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('published','withdrawn','taken_down')),
          created_at TEXT NOT NULL, fields_json TEXT NOT NULL CHECK(json_valid(fields_json)), UNIQUE(author_id,request_id)
        );
        CREATE INDEX IF NOT EXISTS demo_library_publications_company_idx ON demo_library_publications(status,created_at DESC,id);
        CREATE INDEX IF NOT EXISTS demo_library_publications_author_idx ON demo_library_publications(author_id,created_at DESC,id);
        CREATE INDEX IF NOT EXISTS demo_library_publications_department_idx ON demo_library_publications(department_id,status,created_at DESC);
        CREATE TABLE IF NOT EXISTS demo_library_media (
          object_key TEXT PRIMARY KEY NOT NULL, mime_type TEXT NOT NULL, bytes BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS demo_library_deliveries (
          operation_key TEXT PRIMARY KEY NOT NULL, fields_json TEXT NOT NULL CHECK(json_valid(fields_json))
        );
        CREATE TABLE IF NOT EXISTS demo_library_receipts (
          id TEXT PRIMARY KEY NOT NULL, operation_key TEXT NOT NULL UNIQUE, entry_id TEXT NOT NULL, image_id TEXT,
          action TEXT NOT NULL CHECK(action IN ('view','download','reuse','prompt_copy')), actor_id TEXT NOT NULL,
          created_at TEXT NOT NULL, fields_json TEXT NOT NULL CHECK(json_valid(fields_json))
        );
        CREATE INDEX IF NOT EXISTS demo_library_receipts_stats_idx ON demo_library_receipts(entry_id,action,image_id,actor_id);
        CREATE INDEX IF NOT EXISTS demo_library_receipts_activity_idx ON demo_library_receipts(entry_id,created_at DESC,id);
      `);
    } catch (error) {
      this.db.close(true);
      throw new DemoStorageError("打开灵感库", error);
    }
  }

  async transaction<T>(work: (repository: DesignLibraryRepository) => Promise<T>): Promise<T> {
    return this.serialized(() => this.transactionContext.run(true, async () => {
      let started = false;
      try {
        this.db.exec("BEGIN IMMEDIATE");
        started = true;
        this.pendingAssets = [];
        const result = await work(this);
        this.db.exec("COMMIT");
        started = false;
        const committed = this.pendingAssets;
        this.pendingAssets = null;
        for (const asset of committed) this.onCommittedAsset(asset);
        return result;
      } catch (error) {
        if (started) this.db.exec("ROLLBACK");
        this.pendingAssets = null;
        if (error instanceof DesignLibraryError || error instanceof DemoStorageError) throw error;
        throw new DemoStorageError("保存灵感库", error);
      }
    }));
  }

  private async serialized<T>(work: () => T | Promise<T>): Promise<T> {
    const previous = this.transactions;
    let release!: () => void;
    this.transactions = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }

  /** A request outside the writer callback must not observe its uncommitted rows. */
  private committedRead<T>(read: () => T): Promise<T> {
    return this.transactionContext.getStore() ? Promise.resolve(read()) : this.serialized(read);
  }

  async lock(_key: string): Promise<void> { this.requireTransaction(); }
  async findPublication(authorId: string, requestId: string): Promise<LibraryPublication | null> {
    return this.committedRead(() => this.publication(this.db.query<JsonRow, [string, string]>("SELECT fields_json FROM demo_library_publications WHERE author_id=? AND request_id=?").get(authorId, requestId)));
  }
  async getPublication(id: string, lock = false): Promise<LibraryPublication | null> {
    if (lock) this.requireTransaction();
    return this.committedRead(() => this.publication(this.db.query<JsonRow, [string]>("SELECT fields_json FROM demo_library_publications WHERE id=?").get(id)));
  }
  async listPublications(filter: LibraryListFilter): Promise<{ items: LibraryPublication[]; total: number }> {
    return this.committedRead(() => {
    const conditions: string[] = [];
    const parameters: (string | number)[] = [];
    if (filter.authorId !== undefined) { conditions.push("author_id=?"); parameters.push(filter.authorId); }
    if (filter.departmentId !== undefined) { conditions.push("department_id=?"); parameters.push(filter.departmentId); }
    if (filter.statuses) {
      if (!filter.statuses.length) return { items: [], total: 0 };
      conditions.push(`status IN (${filter.statuses.map(() => "?").join(",")})`);
      parameters.push(...filter.statuses);
    }
    if (filter.query) {
      conditions.push("instr(lower(json_extract(fields_json,'$.title') || ' ' || json_extract(fields_json,'$.thought') || ' ' || json_extract(fields_json,'$.prompt')),lower(?))>0");
      parameters.push(filter.query);
    }
    if (filter.tag) { conditions.push("EXISTS (SELECT 1 FROM json_each(fields_json,'$.tags') tag WHERE tag.value=?)"); parameters.push(filter.tag); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = this.db.query<{ total: number }, (string | number)[]>(`SELECT COUNT(*) AS total FROM demo_library_publications ${where}`).get(...parameters)!.total;
    // List only a page of metadata, never originals. Detail retains the complete explicitly published text.
    const items = this.db.query<JsonRow, (string | number)[]>(`SELECT json_set(fields_json,'$.thought','','$.prompt','') AS fields_json FROM demo_library_publications ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`)
      .all(...parameters, filter.pageSize, (filter.page - 1) * filter.pageSize).map(row => JSON.parse(row.fields_json) as LibraryPublication);
    return { items, total };
    });
  }
  async insertPublication(publication: LibraryPublication): Promise<void> {
    this.requireTransaction();
    this.db.query("INSERT INTO demo_library_publications(id,author_id,department_id,request_id,status,created_at,fields_json) VALUES(?,?,?,?,?,?,?)")
      .run(publication.id, publication.author.id, publication.author.departmentId, publication.requestId, publication.status, publication.createdAt, JSON.stringify(publication));
  }
  async setPublicationStatus(id: string, status: DesignLibraryStatus, updatedAt: string, reason: string | null, moderatorId: string | null): Promise<void> {
    this.requireTransaction();
    this.db.query("UPDATE demo_library_publications SET status=?,fields_json=json_set(fields_json,'$.status',?,'$.updatedAt',?,'$.moderationReason',?,'$.moderatedBy',?) WHERE id=?")
      .run(status, status, updatedAt, reason, moderatorId, id);
  }
  async getSourceAsset(id: string, ownerId: string): Promise<LibrarySourceAsset | null> {
    return this.committedRead(() => {
    const row = this.db.query<JsonRow & { byte_size: number }, [string, string]>("SELECT fields_json,length(bytes) AS byte_size FROM demo_assets WHERE id=? AND json_extract(fields_json,'$.ownerUserId')=?").get(id, ownerId);
    if (!row) return null;
    const fields = JSON.parse(row.fields_json) as Record<string, unknown>;
    return {
      id, ownerId, objectKey: sourceKeyPrefix + id, filename: String(fields.filename || "image"), mimeType: String(fields.mimeType || ""),
      byteSize: row.byte_size, kind: String(fields.mimeType || "").startsWith("image/") ? "image" : "other",
      status: row.byte_size > 0 && (fields.byteSize === undefined || fields.byteSize === row.byte_size) ? "ready" : "pending",
      deleted: fields.deleted === true || Boolean(fields.deletedAt),
    };
    });
  }
  async insertPrivateAsset(asset: LibraryPrivateAsset): Promise<void> {
    this.requireTransaction();
    const bytes = await this.read(asset.objectKey);
    const demoAsset: DemoLibraryAsset = {
      id: asset.id, ownerUserId: asset.ownerId, filename: asset.filename, mimeType: asset.mimeType,
      byteSize: bytes.byteLength, createdAt: asset.createdAt, metadata: asset.metadata, bytes: Uint8Array.from(bytes),
    };
    const { bytes: original, ...fields } = demoAsset;
    this.db.query("INSERT INTO demo_assets(id,fields_json,bytes) VALUES(?,?,?)").run(asset.id, JSON.stringify(fields), original);
    // Reuse staging bytes move into demo_assets atomically; no extra permanent copy is needed.
    this.db.query("DELETE FROM demo_library_media WHERE object_key=?").run(asset.objectKey);
    this.pendingAssets!.push(demoAsset);
  }
  async getDelivery(key: string): Promise<LibraryDelivery | null> {
    return this.committedRead(() => {
    const row = this.db.query<JsonRow, [string]>("SELECT fields_json FROM demo_library_deliveries WHERE operation_key=?").get(key);
    return row ? JSON.parse(row.fields_json) as LibraryDelivery : null;
    });
  }
  async insertDelivery(delivery: LibraryDelivery): Promise<void> {
    this.requireTransaction();
    this.db.query("INSERT INTO demo_library_deliveries(operation_key,fields_json) VALUES(?,?)").run(delivery.key, JSON.stringify(delivery));
  }
  async hasReceipt(key: string): Promise<boolean> {
    return this.committedRead(() => Boolean(this.db.query<{ found: number }, [string]>("SELECT 1 AS found FROM demo_library_receipts WHERE operation_key=?").get(key)));
  }
  async insertReceipt(receipt: LibraryReceipt): Promise<void> {
    this.requireTransaction();
    this.db.query("INSERT INTO demo_library_receipts(id,operation_key,entry_id,image_id,action,actor_id,created_at,fields_json) VALUES(?,?,?,?,?,?,?,?)")
      .run(receipt.id, receipt.key, receipt.entryId, receipt.imageId, receipt.action, receipt.actorId, receipt.createdAt, JSON.stringify(receipt));
  }
  async getMetricRows(entryId: string): Promise<LibraryMetricRow[]> {
    return this.committedRead(() => this.db.query<LibraryMetricRow, [string, string]>(`
      SELECT 'entry' AS level,NULL AS imageId,action,COUNT(*) AS count,COUNT(DISTINCT actor_id) AS people
      FROM demo_library_receipts WHERE entry_id=? AND (action<>'view' OR image_id IS NULL) GROUP BY action
      UNION ALL
      SELECT 'image' AS level,image_id AS imageId,action,COUNT(*) AS count,COUNT(DISTINCT actor_id) AS people
      FROM demo_library_receipts WHERE entry_id=? AND image_id IS NOT NULL GROUP BY image_id,action
    `).all(entryId, entryId));
  }
  async listActivity(entryId: string, page: number, pageSize: number): Promise<{ items: LibraryReceipt[]; total: number }> {
    return this.committedRead(() => {
    const total = this.db.query<{ total: number }, [string]>("SELECT COUNT(*) AS total FROM demo_library_receipts WHERE entry_id=? AND action IN ('download','reuse')").get(entryId)!.total;
    const items = this.db.query<JsonRow, [string, number, number]>("SELECT fields_json FROM demo_library_receipts WHERE entry_id=? AND action IN ('download','reuse') ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?")
      .all(entryId, pageSize, (page - 1) * pageSize).map(row => JSON.parse(row.fields_json) as LibraryReceipt);
    return { items, total };
    });
  }
  async read(key: string): Promise<Uint8Array> {
    return this.committedRead(() => {
    const row = key.startsWith(sourceKeyPrefix)
      ? this.db.query<{ bytes: Uint8Array }, [string]>("SELECT bytes FROM demo_assets WHERE id=?").get(key.slice(sourceKeyPrefix.length))
      : this.db.query<{ bytes: Uint8Array }, [string]>("SELECT bytes FROM demo_library_media WHERE object_key=?").get(key);
    if (!row) throw new DesignLibraryError("DESIGN_LIBRARY_MEDIA_MISSING", "图片原件不存在", 404);
    return Uint8Array.from(row.bytes);
    });
  }
  async stat(key: string) {
    return this.committedRead(() => {
      const row = key.startsWith(sourceKeyPrefix)
        ? this.db.query<{ byteSize: number; mimeType: string }, [string]>("SELECT length(bytes) AS byteSize,json_extract(fields_json,'$.mimeType') AS mimeType FROM demo_assets WHERE id=?").get(key.slice(sourceKeyPrefix.length))
        : this.db.query<{ byteSize: number; mimeType: string }, [string]>("SELECT length(bytes) AS byteSize,mime_type AS mimeType FROM demo_library_media WHERE object_key=?").get(key);
      // Library snapshot and versioned derivative keys are immutable INSERT-only BLOBs.
      return row ? { ...row, etag: `"${createHash("sha256").update(`${key}:${row.byteSize}`).digest("hex")}"` } : null;
    });
  }
  async write(key: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    this.requireTransaction();
    this.db.query("INSERT INTO demo_library_media(object_key,mime_type,bytes) VALUES(?,?,?)").run(key, mimeType, bytes);
  }
  async remove(key: string): Promise<void> {
    const remove = () => { this.db.query("DELETE FROM demo_library_media WHERE object_key=?").run(key); };
    if (this.transactionContext.getStore()) remove();
    else await this.serialized(remove);
  }
  close(): void { this.db.close(true); }

  private requireTransaction(): void { if (!this.transactionContext.getStore() || !this.pendingAssets) throw new Error("Library writes require a transaction"); }
  private publication(row: JsonRow | null): LibraryPublication | null { return row ? JSON.parse(row.fields_json) as LibraryPublication : null; }
}

const responseHeaders = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
const libraryJson = (data: unknown, status = 200) => Response.json({ code: 0, data, msg: "" }, { status, headers: responseHeaders });
const decodeSegment = (value: string) => {
  try { return decodeURIComponent(value); } catch { throw new DesignLibraryError("VALIDATION_ERROR", "灵感库路径无效"); }
};
async function readJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length") || 0) > 200000) throw new DesignLibraryError("VALIDATION_ERROR", "灵感库请求过大", 413);
  const text = await request.text();
  if (text.length > 200000) throw new DesignLibraryError("VALIDATION_ERROR", "灵感库请求过大", 413);
  try { return text ? JSON.parse(text) : {}; } catch { throw new DesignLibraryError("VALIDATION_ERROR", "灵感库请求格式不正确"); }
}

/** OA-off trial is deliberately unavailable. Demo never creates an administrator identity. */
export async function handleDemoDesignLibrary(request: Request, service: DesignLibraryService | null, actor: DesignLibraryActor | null): Promise<Response | null> {
  const url = new URL(request.url);
  if (!/^\/api\/design-library(?:\/|$)/.test(url.pathname)) return null;
  try {
    if (!service) throw new DesignLibraryError("DESIGN_LIBRARY_DISABLED", "公司设计灵感库仅在 OA 员工登录模式开放", 403);
    if (!actor) throw new DesignLibraryError("UNAUTHORIZED", "请先通过公司 OA 登录", 401);
    const owner = request.headers.get("x-canvas-owner-id");
    if ((owner !== null && owner !== actor.id) || (!["GET", "HEAD", "OPTIONS"].includes(request.method) && owner !== actor.id)) {
      throw new DesignLibraryError("CANVAS_OWNER_MISMATCH", "当前员工身份已变化，请重新打开后再试", 403);
    }
    const parts = url.pathname.replace(/\/$/, "").split("/").slice(3).map(decodeSegment);
    const query = Object.fromEntries(url.searchParams);
    if (!parts.length && request.method === "GET") return libraryJson(await service.list(actor, query));
    if (!parts.length && request.method === "POST") return libraryJson({ entry: await service.publish(actor, await readJson(request)) }, 201);
    const [id, action, imageId, operation] = parts;
    if (parts.length === 1 && request.method === "GET") return libraryJson({ entry: await service.detail(actor, id!) });
    if (parts.length === 2) {
      if (action === "stats" && request.method === "GET") return libraryJson(await service.stats(actor, id!, query));
      if (request.method === "POST") {
        if (action === "withdraw") return libraryJson({ entry: await service.withdraw(actor, id!) });
        if (action === "moderate") throw new DesignLibraryError("FORBIDDEN", "本地演示服务不提供维护接口", 403);
        if (action === "events") return libraryJson(await service.receipt(actor, id!, await readJson(request)));
      }
    }
    if (parts.length === 4 && action === "images") {
      if (operation === "reuse" && request.method === "POST") return libraryJson(await service.reuse(actor, id!, imageId!, await readJson(request)));
      if ((operation === "content" || operation === "thumbnail") && ["GET", "HEAD"].includes(request.method)) {
        const result = await service.imageResponse(actor, id!, imageId!, { thumbnail: operation === "thumbnail", ifNoneMatch: request.headers.get("if-none-match") ?? undefined, head: request.method === "HEAD" });
        const headers = { ...responseHeaders, "cache-control": designLibraryMediaCacheControl, vary: designLibraryMediaVary, etag: result.etag };
        if (result.status === 304) return new Response(null, { status: 304, headers });
        return new Response(result.bytes ? new Uint8Array(result.bytes) : null, { headers: {
          ...headers, "content-type": result.image.mimeType, "content-length": String(result.image.byteSize),
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(result.image.filename)}`,
          "content-security-policy": "default-src 'none'; sandbox",
        } });
      }
      if (operation === "download" && request.method === "POST") {
        const result = await service.download(actor, id!, imageId!, await readJson(request));
        return new Response(new Uint8Array(result.bytes), { headers: {
          ...responseHeaders, "content-type": result.image.mimeType, "content-length": String(result.bytes.byteLength),
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.image.filename)}`,
        } });
      }
    }
    throw new DesignLibraryError("NOT_FOUND", "灵感库接口不存在", 404);
  } catch (error) {
    const failure = error instanceof DemoStorageError
      ? { status: 503, body: { code: 503, error: "LOCAL_STORAGE_UNAVAILABLE", msg: "本地数据未能保存，请检查磁盘空间与写入权限后重试" } }
      : designLibraryFailure(error);
    return Response.json(failure.body, { status: failure.status, headers: responseHeaders });
  }
}
