import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CanvasDocumentError, canvasDocumentMetadata, missingCanvasDocument, parseCanvasDocumentWrite, type CanvasDocumentEnvelope, type CanvasDocumentSummary } from "./canvas-document";
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
      // Persist the summary once, rather than walking every graph on each listing.
      const fields = new Set(database.query<{ name: string }, []>("PRAGMA table_info(demo_canvas_documents)").all().map(column => column.name));
      if (!fields.has("node_count")) database.transaction(() => {
        database!.exec(`ALTER TABLE demo_canvas_documents ADD COLUMN title TEXT NOT NULL DEFAULT '';
          ALTER TABLE demo_canvas_documents ADD COLUMN document_created_at TEXT;
          ALTER TABLE demo_canvas_documents ADD COLUMN document_updated_at TEXT;
          ALTER TABLE demo_canvas_documents ADD COLUMN node_count INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE demo_canvas_documents ADD COLUMN connection_count INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE demo_canvas_documents ADD COLUMN cover_url TEXT;
          UPDATE demo_canvas_documents SET title=coalesce(json_extract(document_json,'$.title'),''),
            document_created_at=json_extract(document_json,'$.createdAt'),document_updated_at=json_extract(document_json,'$.updatedAt'),
            node_count=coalesce(json_array_length(document_json,'$.nodes'),0),connection_count=coalesce(json_array_length(document_json,'$.connections'),0),
            cover_url=(SELECT json_extract(value,'$.metadata.content') FROM json_each(document_json,'$.nodes')
              WHERE json_extract(value,'$.type')='image' AND coalesce(json_extract(value,'$.metadata.content'),'')<>'' LIMIT 1);`);
      }).immediate();
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

  summaries(ownerId: string): CanvasDocumentSummary[] {
    return this.access("读取画布列表", () => this.db.query<{
      external_id: string; revision: number; deleted: number; updated_at: string; title: string;
      created: string; updated: string; node_count: number; connection_count: number; cover: string | null;
    }, [string]>(`SELECT external_id,revision,deleted,updated_at,
      title,document_created_at AS created,document_updated_at AS updated,node_count,connection_count,cover_url AS cover
      FROM demo_canvas_documents WHERE owner_user_id=? ORDER BY updated_at DESC,external_id`).all(ownerId).map(row => ({
        id: row.external_id, revision: row.revision, deleted: Boolean(row.deleted), updatedAt: row.updated_at,
        summary: row.deleted ? null : { id: row.external_id, title: row.title, createdAt: row.created, updatedAt: row.updated,
          nodeCount: row.node_count, connectionCount: row.connection_count, cover: row.cover ? { content: row.cover } : null },
      })));
  }

  get(ownerId: string, id: string): DemoCanvasDocumentEnvelope {
    return this.access("读取画布内容", () => {
      const row = this.db.query<DocumentRow, [string, string]>(
        "SELECT external_id,revision,deleted,document_json,updated_at FROM demo_canvas_documents WHERE owner_user_id=? AND external_id=?",
      ).get(ownerId, id);
      return row ? envelope(row) : missingCanvasDocument(id);
    });
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
      const summary = canvasDocumentMetadata(next.document);
      this.db.query(`INSERT INTO demo_canvas_documents(owner_user_id,external_id,revision,deleted,document_json,updated_at,title,document_created_at,document_updated_at,node_count,connection_count,cover_url) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(owner_user_id,external_id) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted,document_json=excluded.document_json,updated_at=excluded.updated_at,
          title=excluded.title,document_created_at=excluded.document_created_at,document_updated_at=excluded.document_updated_at,node_count=excluded.node_count,connection_count=excluded.connection_count,cover_url=excluded.cover_url`)
        .run(ownerId, id, next.revision, next.deleted ? 1 : 0, next.document === null ? null : JSON.stringify(next.document), next.updatedAt,
          summary.title, summary.createdAt, summary.updatedAt, summary.nodeCount, summary.connectionCount, summary.coverUrl);
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
