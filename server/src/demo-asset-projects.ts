import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";

type Project = { id: string; externalId: string; name: string; status: string; createdAt: string; updatedAt: string };
const syncSchema = z.object({ externalId: z.string().trim().min(1).max(200), name: z.string().trim().min(1).max(255) });

/** Demo project IDs are durable UUIDs; external canvas IDs are scoped per owner. */
export class DemoAssetProjectStore {
  private db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`CREATE TABLE IF NOT EXISTS demo_asset_projects (
      id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,external_id TEXT NOT NULL,name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(owner_user_id,external_id));`);
  }
  sync(ownerId: string, input: unknown): Project {
    if (!ownerId) throw new Error("Project owner is required");
    const { externalId, name } = syncSchema.parse(input);
    const now = new Date().toISOString();
    this.db.query(`INSERT INTO demo_asset_projects(id,owner_user_id,external_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(owner_user_id,external_id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at`).run(randomUUID(), ownerId, externalId, name, now, now);
    return this.db.query<Project, [string, string]>(`SELECT id,external_id AS externalId,name,status,created_at AS createdAt,updated_at AS updatedAt FROM demo_asset_projects WHERE owner_user_id=? AND external_id=?`).get(ownerId, externalId)!;
  }
  list(ownerId: string): Project[] {
    return this.db.query<Project, [string]>(`SELECT id,external_id AS externalId,name,status,created_at AS createdAt,updated_at AS updatedAt FROM demo_asset_projects WHERE owner_user_id=? AND status='active' ORDER BY updated_at DESC,id DESC`).all(ownerId);
  }
  owns(ownerId: string, id: string) {
    return Boolean(this.db.query("SELECT id FROM demo_asset_projects WHERE id=? AND owner_user_id=? AND status='active'").get(id, ownerId));
  }
  close() { this.db.close(); }
}
