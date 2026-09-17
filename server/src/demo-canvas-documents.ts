import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CanvasDocumentError, missingCanvasDocument, parseCanvasDocumentWrite, type CanvasDocumentEnvelope } from "./canvas-document";
import { DemoStorageError } from "./demo-state-store";

export type DemoCanvasDocumentEnvelope = CanvasDocumentEnvelope;

type DocumentRow = { external_id: string; revision: number; deleted: number; document_json: string | null; updated_at: string };
type WriteResult = { ok: boolean; document: DemoCanvasDocumentEnvelope };

/** Whole-document CAS in the same durable SQLite file as demo assets and OA identities. */
export class DemoCanvasDocumentStore {
  private readonly db: Database;

  constructor(path: string) {
    let database: Database | undefined;
    try {
      if (!path.trim()) throw new Error("必须指定本地数据库路径");
      if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
      database = new Database(path, { create: true, strict: true });
      const journal = database.query<{ journal_mode: string }, []>("PRAGMA journal_mode=WAL").get();
      if (path !== ":memory:" && journal?.journal_mode.toLowerCase() !== "wal") throw new Error("无法启用 SQLite WAL 日志");
      database.exec(`PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS demo_canvas_documents (
          owner_user_id TEXT NOT NULL,
          external_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          deleted INTEGER NOT NULL CHECK (deleted IN (0,1)),
          document_json TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(owner_user_id, external_id),
          CHECK ((deleted = 1 AND document_json IS NULL) OR (deleted = 0 AND document_json IS NOT NULL AND json_valid(document_json)))
        );`);
      this.db = database;
    } catch (error) {
      database?.close();
      throw new DemoStorageError("打开画布数据库", error);
    }
  }

  list(ownerId: string): DemoCanvasDocumentEnvelope[] {
    return this.access("读取云端画布", () => this.db.query<DocumentRow, [string]>(
      "SELECT external_id,revision,deleted,document_json,updated_at FROM demo_canvas_documents WHERE owner_user_id=? ORDER BY updated_at,external_id",
    ).all(ownerId).map(envelope));
  }

  put(ownerId: string, id: string, body: unknown, canReadAsset: (assetId: string) => boolean): WriteResult {
    const input = parseCanvasDocumentWrite(id, body);
    for (const assetId of input.assetIds) {
      if (!canReadAsset(assetId)) throw new CanvasDocumentError("CANVAS_ASSET_FORBIDDEN", "画布引用的素材不存在或无权访问", 403);
    }
    return this.access("保存云端画布", () => this.db.transaction((): WriteResult => {
      const row = this.db.query<DocumentRow, [string, string]>(
        "SELECT external_id,revision,deleted,document_json,updated_at FROM demo_canvas_documents WHERE owner_user_id=? AND external_id=?",
      ).get(ownerId, id);
      const current = row ? envelope(row) : missingCanvasDocument(id);
      if (current.revision !== input.baseRevision || (row?.deleted === 1 && input.document !== null)) return { ok: false, document: current };
      const next: DemoCanvasDocumentEnvelope = {
        id, revision: current.revision + 1, deleted: input.document === null,
        document: input.document, updatedAt: new Date().toISOString(),
      };
      this.db.query(`INSERT INTO demo_canvas_documents(owner_user_id,external_id,revision,deleted,document_json,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(owner_user_id,external_id) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted,document_json=excluded.document_json,updated_at=excluded.updated_at`)
        .run(ownerId, id, next.revision, next.deleted ? 1 : 0, next.document === null ? null : JSON.stringify(next.document), next.updatedAt);
      return { ok: true, document: next };
    }).immediate());
  }

  close() { this.access("关闭画布数据库", () => this.db.close(true)); }

  private access<T>(operation: string, run: () => T): T {
    try { return run(); }
    catch (error) { throw error instanceof DemoStorageError ? error : new DemoStorageError(operation, error); }
  }
}

function envelope(row: DocumentRow): DemoCanvasDocumentEnvelope {
  return { id: row.external_id, revision: row.revision, deleted: row.deleted === 1, document: row.document_json === null ? null : JSON.parse(row.document_json), updatedAt: row.updated_at };
}
