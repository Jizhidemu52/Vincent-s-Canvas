import { describe, expect, test } from "bun:test";
import express, { type ErrorRequestHandler } from "express";
import type { Server } from "node:http";
import { ZodError } from "zod";

import type { Database } from "../src/db";
import { createProjectsRouter } from "../src/routes/projects";
import type { AuthenticatedRequest, SessionUser } from "../src/types";

type QueryResult = { rows: Array<Record<string, unknown>> };
type ProjectRow = { id: string; owner_user_id: string; department_id: string | null };
type SnapshotRow = { snapshot: Record<string, unknown>; revision: number; updatedAt: string };
type AssetReferenceRow = { ownerUserId: string; departmentId: string | null; visibilityScope: "private" | "company" };

class FakeProjectsDb {
  projects = new Map<string, ProjectRow>();
  members = new Set<string>();
  snapshots = new Map<string, SnapshotRow>();
  assetReferences = new Map<string, AssetReferenceRow>();
  audits: Array<{ action: string; detail: Record<string, unknown> }> = [];
  writes = 0;

  async query(sql: string, values: unknown[] = []): Promise<QueryResult> {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };

    if (sql.includes("FROM projects p") && sql.includes("project_members")) {
      const project = this.projects.get(String(values[0]));
      const actorId = String(values[1]);
      if (!project || (project.owner_user_id !== actorId && !this.members.has(`${project.id}:${actorId}`))) return { rows: [] };
      return { rows: [{ id: project.id, ownerUserId: project.owner_user_id, departmentId: project.department_id }] };
    }

    if (sql.includes("FROM project_canvas_snapshots") && sql.includes("WHERE project_id=$1")) {
      const snapshot = this.snapshots.get(String(values[0]));
      return { rows: snapshot ? [snapshot] : [] };
    }

    if (sql.includes("FROM assets a") && sql.includes("count(*)::int AS count")) {
      const keys = values[0] as string[];
      const actorId = String(values[1]);
      const departmentId = values[2] === null ? null : String(values[2]);
      const superAdminCanReadAnyAsset = sql.includes("TRUE");
      const count = keys.filter((key) => {
        const asset = this.assetReferences.get(key);
        if (!asset) return false;
        return superAdminCanReadAnyAsset || asset.ownerUserId === actorId || asset.visibilityScope === "company" || (asset.departmentId !== null && asset.departmentId === departmentId);
      }).length;
      return { rows: [{ count }] };
    }

    if (sql.includes("INSERT INTO project_canvas_snapshots")) {
      const projectId = String(values[0]);
      const requestedRevision = Number(values[3]);
      if (requestedRevision !== 0 || this.snapshots.has(projectId)) return { rows: [] };
      const row = { snapshot: JSON.parse(String(values[2])), revision: 1, updatedAt: "2026-07-31T10:00:00.000Z" };
      this.snapshots.set(projectId, row);
      this.writes += 1;
      return { rows: [row] };
    }

    if (sql.includes("UPDATE project_canvas_snapshots")) {
      const projectId = String(values[0]);
      const requestedRevision = Number(values[1]);
      const current = this.snapshots.get(projectId);
      if (!current || current.revision !== requestedRevision) return { rows: [] };
      const row = { snapshot: JSON.parse(String(values[2])), revision: current.revision + 1, updatedAt: "2026-07-31T10:01:00.000Z" };
      this.snapshots.set(projectId, row);
      this.writes += 1;
      return { rows: [row] };
    }

    if (sql.includes("INSERT INTO audit_logs")) {
      this.audits.push({ action: String(values[2]), detail: values[7] as Record<string, unknown> });
      return { rows: [] };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }

  async connect() {
    return {
      query: (sql: string, values?: unknown[]) => this.query(sql, values),
      release: () => undefined,
    };
  }
}

const actor = (id: string): SessionUser => ({
  id,
  username: id,
  displayName: id,
  email: null,
  employeeNo: null,
  role: "designer",
  status: "active",
  departmentId: "department-a",
  departmentName: "Department A",
  groupId: null,
  groupName: null,
  groupRole: null,
  mustChangePassword: false,
  mfaEnabled: false,
  creditBalance: 0,
  creditLimit: 0,
  monthlyCreditLimit: 0,
  temporaryCreditAdjustment: 0,
  creditPeriodStart: "2026-07-01",
  creditResetAt: "2026-08-01",
});

const superAdmin = (id: string): SessionUser => ({ ...actor(id), role: "super_admin", departmentId: null, departmentName: null });

function canvasSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "canvas-1",
    name: "Canvas One",
    nodes: [{ id: "node-1", metadata: { content: "image:allowed" } }],
    connections: [],
    chatSessions: [{ id: "chat-1", messages: [{ role: "user", content: "private chat text" }] }],
    activeChatId: "chat-1",
    backgroundMode: "dots",
    showImageInfo: true,
    viewport: { x: 10, y: 20, scale: 1 },
    createdAt: "2026-07-31T09:00:00.000Z",
    updatedAt: "2026-07-31T09:30:00.000Z",
    ...overrides,
  };
}

async function request(db: FakeProjectsDb, sessionUser: SessionUser, path: string, options: RequestInit = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as AuthenticatedRequest).auth = sessionUser;
    next();
  });
  app.use("/api/projects", createProjectsRouter(db as unknown as Database));
  app.use((_req, res) => {
    res.status(404).json({ error: "NOT_FOUND" });
  });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ZodError) {
      res.status(400).json({ error: "VALIDATION_ERROR", issues: error.issues });
      return;
    }
    res.status(500).json({ error: "INTERNAL_ERROR", detail: error instanceof Error ? error.message : String(error) });
  };
  app.use(errors);

  const server: Server = app.listen(0);
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const headers = new Headers(options.headers);
    if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...options, headers });
    return {
      response,
      body: await response.json(),
    };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function seededDb() {
  const db = new FakeProjectsDb();
  db.projects.set("project-1", { id: "project-1", owner_user_id: "owner-1", department_id: "department-a" });
  db.members.add("project-1:member-1");
  db.members.add("project-1:admin-1");
  db.assetReferences.set("image:allowed", { ownerUserId: "owner-1", departmentId: "department-a", visibilityScope: "private" });
  return db;
}

describe("project canvas snapshot routes", () => {
  test("returns null for a visible project before the first snapshot", async () => {
    const db = seededDb();

    const result = await request(db, actor("owner-1"), "/api/projects/project-1/canvas");

    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ canvas: null });
  });

  test("allows a project member to create the first revision and writes a narrow audit event", async () => {
    const db = seededDb();

    const result = await request(db, actor("member-1"), "/api/projects/project-1/canvas", {
      method: "PUT",
      body: JSON.stringify({ revision: 0, snapshot: canvasSnapshot() }),
    });

    expect(result.response.status).toBe(200);
    expect(result.body.canvas).toMatchObject({ revision: 1, updatedAt: "2026-07-31T10:00:00.000Z" });
    expect(result.body.canvas.snapshot.nodes).toHaveLength(1);
    expect(db.audits).toEqual([{ action: "project.canvas_saved", detail: { revision: 1, nodeCount: 1 } }]);
    expect(JSON.stringify(db.audits)).not.toContain("private chat text");
  });

  test("returns project-not-found behavior for non-members and does not write", async () => {
    const db = seededDb();

    const result = await request(db, actor("stranger-1"), "/api/projects/project-1/canvas", {
      method: "PUT",
      body: JSON.stringify({ revision: 0, snapshot: canvasSnapshot() }),
    });

    expect(result.response.status).toBe(404);
    expect(result.body.error).toBe("NOT_FOUND");
    expect(db.writes).toBe(0);
    expect(db.audits).toEqual([]);
  });

  test("increments matching revisions and returns the stored snapshot on GET", async () => {
    const db = seededDb();
    await request(db, actor("owner-1"), "/api/projects/project-1/canvas", {
      method: "PUT",
      body: JSON.stringify({ revision: 0, snapshot: canvasSnapshot() }),
    });
    const nextSnapshot = canvasSnapshot({ nodes: [{ id: "node-2" }] });

    const updated = await request(db, actor("member-1"), "/api/projects/project-1/canvas", {
      method: "PUT",
      body: JSON.stringify({ revision: 1, snapshot: nextSnapshot }),
    });
    const fetched = await request(db, actor("owner-1"), "/api/projects/project-1/canvas");

    expect(updated.response.status).toBe(200);
    expect(updated.body.canvas).toMatchObject({ revision: 2 });
    expect(fetched.body.canvas).toMatchObject({ revision: 2, snapshot: nextSnapshot });
  });

  test("returns conflict for a stale revision without overwriting the current snapshot", async () => {
    const db = seededDb();
    await request(db, actor("owner-1"), "/api/projects/project-1/canvas", {
      method: "PUT",
      body: JSON.stringify({ revision: 0, snapshot: canvasSnapshot({ nodes: [{ id: "original" }] }) }),
    });
    await request(db, actor("owner-1"), "/api/projects/project-1/canvas", {
      method: "PUT",
      body: JSON.stringify({ revision: 1, snapshot: canvasSnapshot({ nodes: [{ id: "current" }] }) }),
    });

    const conflict = await request(db, actor("owner-1"), "/api/projects/project-1/canvas", {
      method: "PUT",
      body: JSON.stringify({ revision: 1, snapshot: canvasSnapshot({ nodes: [{ id: "stale-overwrite" }] }) }),
    });

    expect(conflict.response.status).toBe(409);
    expect(conflict.body.error).toBe("CANVAS_CONFLICT");
    expect(conflict.body.canvas).toMatchObject({ revision: 2, snapshot: canvasSnapshot({ nodes: [{ id: "current" }] }) });
    expect(db.snapshots.get("project-1")?.snapshot).toMatchObject(canvasSnapshot({ nodes: [{ id: "current" }] }));
  });

  test("rejects inaccessible prefixed storage references before writing", async () => {
    const db = seededDb();

    const result = await request(db, actor("owner-1"), "/api/projects/project-1/canvas", {
      method: "PUT",
      body: JSON.stringify({ revision: 0, snapshot: canvasSnapshot({ nodes: [{ id: "node-1", metadata: { storageKey: "image:missing" } }] }) }),
    });

    expect(result.response.status).toBe(403);
    expect(result.body.error).toBe("CANVAS_REFERENCE_FORBIDDEN");
    expect(db.writes).toBe(0);
    expect(db.audits).toEqual([]);
  });

  test("rejects embedded data image payloads before writing", async () => {
    const db = seededDb();

    const result = await request(db, actor("owner-1"), "/api/projects/project-1/canvas", {
      method: "PUT",
      body: JSON.stringify({ revision: 0, snapshot: canvasSnapshot({ nodes: [{ id: "node-1", metadata: { content: "data:image/png;base64,AAAA" } }] }) }),
    });

    expect(result.response.status).toBe(400);
    expect(result.body.error).toBe("CANVAS_EMBEDDED_MEDIA");
    expect(db.writes).toBe(0);
    expect(db.audits).toEqual([]);
  });

  test("rejects embedded data video payloads before writing", async () => {
    const db = seededDb();

    const result = await request(db, actor("owner-1"), "/api/projects/project-1/canvas", {
      method: "PUT",
      body: JSON.stringify({ revision: 0, snapshot: canvasSnapshot({ nodes: [{ id: "node-1", metadata: { preview: "data:video/mp4;base64,AAAA" } }] }) }),
    });

    expect(result.response.status).toBe(400);
    expect(result.body.error).toBe("CANVAS_EMBEDDED_MEDIA");
    expect(db.writes).toBe(0);
    expect(db.audits).toEqual([]);
  });

  test("allows a super administrator project member to reference any ready asset", async () => {
    const db = seededDb();
    db.assetReferences.set("image:admin-visible", { ownerUserId: "other-user", departmentId: "other-department", visibilityScope: "private" });

    const result = await request(db, superAdmin("admin-1"), "/api/projects/project-1/canvas", {
      method: "PUT",
      body: JSON.stringify({ revision: 0, snapshot: canvasSnapshot({ nodes: [{ id: "node-1", metadata: { storageKey: "image:admin-visible" } }] }) }),
    });

    expect(result.response.status).toBe(200);
    expect(result.body.canvas).toMatchObject({ revision: 1 });
    expect(db.writes).toBe(1);
  });
});
