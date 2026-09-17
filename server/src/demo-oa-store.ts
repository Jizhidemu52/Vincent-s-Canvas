import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DemoAccount } from "./demo-accounts";
import { OA_SESSION_TTL_SECONDS, type OaIdentity } from "./oa";

type IdentityRow = { id: string; subject: string; display_name: string };
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Same durable SQLite file as tasks. No upstream bearer tokens are stored. */
export class DemoOaStore {
  private readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS demo_oa_users (
        id TEXT PRIMARY KEY NOT NULL, subject TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS demo_oa_sessions (
        token_hash TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES demo_oa_users(id), expires_at INTEGER NOT NULL
      );`);
  }
  login(identity: OaIdentity, now = Date.now()) {
    return this.db.transaction(() => {
      this.db.query("INSERT INTO demo_oa_users(id,subject,display_name) VALUES(?,?,?) ON CONFLICT(subject) DO UPDATE SET display_name=excluded.display_name")
        .run(randomUUID(), identity.id, identity.name);
      const row = this.db.query<IdentityRow, [string]>("SELECT * FROM demo_oa_users WHERE subject=?").get(identity.id)!;
      const token = randomBytes(32).toString("base64url");
      this.db.query("DELETE FROM demo_oa_sessions WHERE expires_at<=?").run(now);
      this.db.query("INSERT INTO demo_oa_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)").run(hash(token), row.id, now + OA_SESSION_TTL_SECONDS * 1000);
      return { user: mapUser(row), token };
    }).immediate();
  }
  session(token: string | undefined, now = Date.now()): DemoAccount["user"] | null {
    if (!token) return null;
    const row = this.db.query<IdentityRow, [string, number]>(`SELECT u.* FROM demo_oa_users u JOIN demo_oa_sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?`).get(hash(token), now);
    return row ? mapUser(row) : null;
  }
  revoke(token: string | undefined) { if (token) this.db.query("DELETE FROM demo_oa_sessions WHERE token_hash=?").run(hash(token)); }
  user(id: string) {
    const row = this.db.query<IdentityRow, [string]>("SELECT * FROM demo_oa_users WHERE id=?").get(id);
    return row ? mapUser(row) : null;
  }
  close() { this.db.close(); }
}

function mapUser(row: IdentityRow): DemoAccount["user"] {
  return {
    id: row.id, username: `oa-${row.id}`, displayName: row.display_name, employeeNo: row.subject,
    email: null, role: "designer", status: "active", departmentId: null, departmentName: null,
    groupId: null, groupName: null, groupRole: null, mustChangePassword: false, mfaEnabled: false,
    creditBalance: 0, creditLimit: 0, monthlyCreditLimit: 0, temporaryCreditAdjustment: 0,
    creditPeriodStart: new Date(0).toISOString(), creditResetAt: new Date(0).toISOString(),
  };
}
