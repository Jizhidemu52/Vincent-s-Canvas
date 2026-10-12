import { Database as Sqlite } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { Database } from "../src/db";
import { DesignLibraryService, type DesignLibraryActor, type DesignLibraryMediaStore } from "../src/design-library";
import { PostgresDesignLibraryRepository } from "../src/design-library-postgres";

export const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
export const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=", "base64"));
export const jpeg = new Uint8Array(Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdAAf/2Q==", "base64"));
export const gif = new Uint8Array(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
export const webp = new Uint8Array(Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=", "base64"));
export const employee = (value: number, department = 1): DesignLibraryActor => ({
    id: uuid(value), name: `设计师${value}`, departmentId: uuid(100 + department), departmentName: `设计${department}部`, role: "designer", kind: "employee",
});
export const administrator = (value: number, department?: number): DesignLibraryActor => ({
    ...employee(value, department ?? 1), kind: "admin", role: department ? "department_admin" : "super_admin",
});

/** Execute production PG adapter SQL against SQLite, translating dialect syntax only.
 * No route results/owner predicates/aggregates are mocked. PostgreSQL's actual driver,
 * row locks and S3 transport are intentionally not claimed by this isolated fixture.
 */
export function libraryFixture() {
    const sqlite = new Sqlite(":memory:");
    sqlite.run("PRAGMA foreign_keys=ON");
    sqlite.exec(`CREATE TABLE departments(id TEXT PRIMARY KEY,name TEXT);
        CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,department_id TEXT);
        CREATE TABLE assets(id TEXT PRIMARY KEY,owner_user_id TEXT,department_id TEXT,object_key TEXT UNIQUE,filename TEXT,mime_type TEXT,byte_size INTEGER,kind TEXT,source TEXT,status TEXT,visibility_scope TEXT DEFAULT 'private',metadata TEXT DEFAULT '{}',deleted_at TEXT,created_at TEXT,updated_at TEXT);
        CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_role TEXT,action TEXT,target_type TEXT,target_id TEXT,department_id TEXT,result TEXT,detail TEXT);`);
    sqlite.exec(readFileSync(new URL("../src/migrations/025_design_library.sql", import.meta.url), "utf8").replace(/::jsonb/g, "").replace(/char_length\(/g, "length("));
    const queries: { sql: string; values: unknown[] }[] = [];
    let queue = Promise.resolve();
    const execute = async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values: [...values] });
        if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
        let translated = sql.replace(/\s+FOR (UPDATE|SHARE)\s*$/i, "").replace(/::(?:jsonb|text|int)\b/g, "");
        translated = translated.replace(/tags \? (\$\d+)/g, "EXISTS(SELECT 1 FROM json_each(tags) WHERE value=$1)");
        const ordered: unknown[] = [];
        translated = translated.replace(/\$(\d+)/g, (_match, index) => { ordered.push(values[Number(index) - 1]); return "?"; });
        const rows = sqlite.query(translated).all(...ordered as any[]) as Record<string, any>[];
        for (const row of rows) for (const key of ["tags", "metadata"]) {
            if (typeof row[key] === "string") row[key] = JSON.parse(row[key]);
        }
        return { rows, rowCount: rows.length };
    };
    const db = {
        query: async (sql: string, values: unknown[]) => { await queue; return execute(sql, values); },
        connect: async () => {
            const previous = queue;
            let release!: () => void;
            queue = new Promise<void>(resolve => { release = resolve; });
            await previous;
            return { query: execute, release };
        },
    } as unknown as Database;
    const objects = new Map<string, Uint8Array>();
    const reads: string[] = [];
    const writes: string[] = [];
    const removed: string[] = [];
    let failWrite = false;
    const media: DesignLibraryMediaStore = {
        read: async key => {
            reads.push(key);
            const bytes = objects.get(key);
            if (!bytes) throw new Error("Missing test object");
            return new Uint8Array(bytes);
        },
        write: async (key, bytes) => {
            writes.push(key);
            objects.set(key, new Uint8Array(bytes));
            if (failWrite) throw new Error("Simulated object write failure");
        },
        remove: async key => { removed.push(key); objects.delete(key); },
    };
    const repository = new PostgresDesignLibraryRepository(db);
    return {
        sqlite, db, repository, media, service: new DesignLibraryService(repository, media), objects, reads, writes, removed, queries,
        close: () => sqlite.close(),
        failWrites: (value: boolean) => { failWrite = value; },
        actor: (actor: DesignLibraryActor) => {
            if (actor.departmentId) sqlite.query("INSERT OR IGNORE INTO departments(id,name) VALUES(?,?)").run(actor.departmentId, actor.departmentName);
            sqlite.query("INSERT OR REPLACE INTO users(id,role,department_id) VALUES(?,?,?)").run(actor.id, actor.role, actor.departmentId);
            return actor;
        },
        source: (id: string, actor: DesignLibraryActor, bytes: Uint8Array = png, overrides: { mimeType?: string; kind?: string; status?: string; deleted?: boolean; byteSize?: number; filename?: string } = {}) => {
            const key = `private/${actor.id}/${id}`;
            objects.set(key, new Uint8Array(bytes));
            sqlite.query("INSERT INTO assets(id,owner_user_id,department_id,object_key,filename,mime_type,byte_size,kind,status,deleted_at,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
                id, actor.id, actor.departmentId, key, overrides.filename ?? "原始设计.png", overrides.mimeType ?? "image/png", overrides.byteSize ?? bytes.byteLength,
                overrides.kind ?? "image", overrides.status ?? "ready", overrides.deleted ? "2026-01-01" : null,
                JSON.stringify({ prompt: "私有生成提示词", privateCanvasId: "secret-canvas", chatSessions: ["private chat"] }),
            );
            return key;
        },
    };
}

export const publishInput = (assetIds: string[] = [], requestId = "publish-request-1") => ({
    title: "春季针织灵感", thought: "选用柔和配色，突出针织纹理", prompt: "soft knitwear editorial", tags: ["针织", "春季"], assetIds, requestId,
});
