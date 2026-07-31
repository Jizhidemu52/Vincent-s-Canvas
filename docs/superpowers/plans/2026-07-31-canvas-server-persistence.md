# Canvas Server Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist authenticated users' canvas projects to the production API so they recover across devices while local storage remains an offline cache.

**Architecture:** Add a one-to-one `project_canvas_snapshots` PostgreSQL record protected by project membership and optimistic revisions. The web client hydrates its local Zustand cache immediately, fetches the remote snapshot for authenticated projects, then performs debounced revision-aware writes; a conflict is surfaced instead of overwriting unseen remote work.

**Tech Stack:** TypeScript, Express, Zod, PostgreSQL JSONB, Bun tests, React, Zustand, localForage.

## Global Constraints

- Keep WebDAV import/export unchanged; it remains an explicit backup path.
- Persist only structured canvas JSON and asset references; never embed media binary data in a snapshot.
- Protect every canvas endpoint with the existing session and project-member permission model.
- Use optimistic `revision` writes; do not implement real-time collaboration or automatic node merging.
- Preserve localForage as the unauthenticated and offline cache.
- Keep new user-visible Chinese source text UTF-8 encoded and add it through ordinary source files, not image assets.

---

## File Structure

- `server/src/migrations/018_project_canvas_snapshots.sql`: creates the durable snapshot table and indexes.
- `server/src/routes/projects.ts`: owns authenticated project lookup plus canvas GET/PUT endpoints.
- `server/tests/projects.test.ts`: exercises route behavior with the existing database test helper pattern.
- `web/src/services/canvas-project-sync.ts`: isolates remote snapshot transport, debounce, retries and conflict state from the Zustand store.
- `web/src/stores/canvas/use-canvas-store.ts`: exposes revision and synchronization state without removing localForage persistence.
- `web/src/pages/canvas/project.tsx`: starts sync after the project opens and renders the non-blocking save/conflict status.
- `web/tests/canvas-project-sync.test.ts`: verifies transport decisions, debounce, retry and conflict behavior with mocked `fetch`.
- `server/src/config.ts`, `server/tests/production-readiness.test.ts`, `web/src/stores/canvas/use-canvas-store.ts`, `web/src/services/app-sync.ts`: correct touched mojibake literals to UTF-8 Chinese strings.

### Task 1: Add the durable snapshot schema

**Files:**
- Create: `server/src/migrations/018_project_canvas_snapshots.sql`
- Test: `server/tests/projects.test.ts`

**Interfaces:**
- Produces a `project_canvas_snapshots` row keyed by `project_id` with `revision integer`, `snapshot jsonb`, `owner_user_id`, and timestamps.
- Later route tasks rely on `project_id` uniqueness and atomic revision updates.

- [ ] **Step 1: Write a migration fixture test that expects a snapshot table to be available after migrations**

```ts
test("creates one revisioned canvas snapshot per project", async () => {
  const row = await db.query(
    "INSERT INTO project_canvas_snapshots(project_id, owner_user_id, revision, snapshot) VALUES($1,$2,1,$3) RETURNING revision",
    [projectId, ownerId, { nodes: [], connections: [] }],
  );
  expect(row.rows[0].revision).toBe(1);
});
```

- [ ] **Step 2: Run the focused test to verify it fails before the migration exists**

Run: `cd server; bun test tests/projects.test.ts`

Expected: the insert reports that `project_canvas_snapshots` does not exist.

- [ ] **Step 3: Create the migration with identity, ownership and revision constraints**

```sql
CREATE TABLE IF NOT EXISTS project_canvas_snapshots (
    project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
    snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_canvas_snapshots_owner_updated_idx
    ON project_canvas_snapshots(owner_user_id, updated_at DESC);
```

- [ ] **Step 4: Run the focused test and migration command used by the repository**

Run: `cd server; bun test tests/projects.test.ts && bun run migrate`

Expected: snapshot insert succeeds and the migration runner reports version `018` applied.

- [ ] **Step 5: Commit the schema task**

```bash
git add server/src/migrations/018_project_canvas_snapshots.sql server/tests/projects.test.ts
git commit -m "feat: add canvas snapshot schema"
```

### Task 2: Implement revisioned canvas snapshot API

**Files:**
- Modify: `server/src/routes/projects.ts`
- Modify: `server/src/index.ts` only if the router is not already mounted at `/api/projects`
- Modify: `server/tests/projects.test.ts`

**Interfaces:**
- Consumes: `GET /api/projects/:id/canvas` and `PUT /api/projects/:id/canvas` request identity from the existing session middleware.
- Produces `CanvasSnapshotResponse = { snapshot: CanvasSnapshot; revision: number; updatedAt: string }` and `409 { error: "CANVAS_CONFLICT", canvas: CanvasSnapshotResponse }`.

- [ ] **Step 1: Write failing API tests for owner access, member access, forbidden access, creation, revision update and conflict**

```ts
test("rejects an outdated canvas revision without overwriting the latest snapshot", async () => {
  await putCanvas(ownerSession, projectId, 0, { nodes: [{ id: "a" }] });
  const conflict = await putCanvas(ownerSession, projectId, 0, { nodes: [{ id: "b" }] });
  expect(conflict.status).toBe(409);
  expect(conflict.body.error).toBe("CANVAS_CONFLICT");
  expect(conflict.body.canvas.snapshot.nodes).toEqual([{ id: "a" }]);
});
```

- [ ] **Step 2: Run the focused API tests to verify they fail**

Run: `cd server; bun test tests/projects.test.ts`

Expected: missing canvas endpoint or incorrect response status.

- [ ] **Step 3: Define Zod request validation and a project visibility helper in `projects.ts`**

```ts
const canvasSnapshotSchema = z.object({
  revision: z.number().int().min(0),
  snapshot: z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(200),
    nodes: z.array(z.unknown()),
    connections: z.array(z.unknown()),
    chatSessions: z.array(z.unknown()),
    activeChatId: z.string().nullable(),
    backgroundMode: z.enum(["dots", "lines", "blank"]),
    showImageInfo: z.boolean(),
    viewport: z.object({ x: z.number(), y: z.number(), scale: z.number().positive() }),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
});

async function loadVisibleProject(db: Database, userId: string, projectId: string) {
  return db.query(
    `SELECT p.id,p.owner_user_id FROM projects p LEFT JOIN project_members pm ON pm.project_id=p.id
     WHERE p.id=$1 AND (p.owner_user_id=$2 OR pm.user_id=$2) LIMIT 1`,
    [projectId, userId],
  );
}
```

- [ ] **Step 4: Add GET and atomic PUT handlers**

```ts
router.put("/:id/canvas", async (request, response, next) => {
  const actor = (request as unknown as AuthenticatedRequest).auth;
  const input = canvasSnapshotSchema.parse(request.body);
  const project = await loadVisibleProject(db, actor.id, request.params.id);
  if (!project.rows[0]) return response.status(404).json({ error: "NOT_FOUND", message: "项目不存在" });

  const result = await db.query(
    `INSERT INTO project_canvas_snapshots(project_id,owner_user_id,revision,snapshot)
     VALUES($1,$2,1,$3)
     ON CONFLICT(project_id) DO UPDATE SET snapshot=EXCLUDED.snapshot,revision=project_canvas_snapshots.revision+1,updated_at=now()
     WHERE project_canvas_snapshots.revision=$4
     RETURNING snapshot,revision,updated_at AS "updatedAt"`,
    [request.params.id, project.rows[0].owner_user_id, input.snapshot, input.revision],
  );
  if (!result.rows[0]) return sendCanvasConflict(db, response, request.params.id);
  return response.json({ canvas: result.rows[0] });
});
```

Implement `sendCanvasConflict` by reading the latest row and returning its snapshot and revision under `canvas`.

- [ ] **Step 5: Validate asset references before writing and audit the success**

```ts
const storageKeys = collectCanvasStorageKeys(input.snapshot);
await assertActorCanReferenceStorageKeys(db, actor, storageKeys);
await writeAudit(db, {
  actor,
  action: "project.canvas_saved",
  targetType: "project",
  targetId: request.params.id,
  departmentId: actor.departmentId,
  result: "success",
  detail: { revision: result.rows[0].revision, nodeCount: input.snapshot.nodes.length },
  ip: request.ip,
});
```

`collectCanvasStorageKeys` recursively finds strings that begin with the same media key prefixes used by `app-sync.ts`; `assertActorCanReferenceStorageKeys` maps those keys to accessible assets and rejects inaccessible identifiers before any write.

- [ ] **Step 6: Run server tests and TypeScript compilation**

Run: `cd server; bun test tests/projects.test.ts && bun run build`

Expected: project API tests pass, including conflict and authorization cases; `tsc --noEmit` succeeds.

- [ ] **Step 7: Commit the API task**

```bash
git add server/src/routes/projects.ts server/src/index.ts server/tests/projects.test.ts
git commit -m "feat: persist revisioned canvas snapshots"
```

### Task 3: Add a client-side canvas sync coordinator

**Files:**
- Create: `web/src/services/canvas-project-sync.ts`
- Modify: `web/src/stores/canvas/use-canvas-store.ts`
- Test: `web/tests/canvas-project-sync.test.ts`

**Interfaces:**
- Produces `CanvasSyncCoordinator` with `open(projectId)`, `scheduleSave(project)`, `flush(project)`, `retryPending()`, and `resolveConflict(action)`.
- Store exposes `remoteRevision`, `syncStatus: "idle" | "saving" | "saved" | "offline" | "conflict" | "error"`, and optional `canvasConflict` per project.

- [ ] **Step 1: Write failing coordinator tests with mocked fetch and fake timers**

```ts
test("coalesces rapid edits into one revision-aware PUT", async () => {
  coordinator.scheduleSave(project("first"));
  coordinator.scheduleSave(project("second"));
  await advanceTimersByTimeAsync(1500);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).snapshot.name).toBe("second");
});

test("keeps the local draft and exposes a conflict on 409", async () => {
  fetch.mockResolvedValueOnce(jsonResponse(409, { error: "CANVAS_CONFLICT", canvas: remoteCanvas }));
  await coordinator.flush(project("local"));
  expect(store.getState().syncStatusByProject[projectId]).toBe("conflict");
  expect(store.getState().canvasConflictByProject[projectId].local.name).toBe("local");
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `cd web; bun test tests/canvas-project-sync.test.ts`

Expected: module `canvas-project-sync` cannot be resolved.

- [ ] **Step 3: Add remote snapshot types and transport methods**

```ts
export type RemoteCanvas = { snapshot: CanvasProject; revision: number; updatedAt: string };

export async function getRemoteCanvas(projectId: string): Promise<RemoteCanvas | null> {
  const response = await fetch(`/api/projects/${projectId}/canvas`, { credentials: "include" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`加载画布失败：${response.status}`);
  return (await response.json() as { canvas: RemoteCanvas }).canvas;
}

export async function putRemoteCanvas(projectId: string, revision: number, snapshot: CanvasProject) {
  return fetch(`/api/projects/${projectId}/canvas`, {
    method: "PUT", credentials: "include", headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision, snapshot }),
  });
}
```

- [ ] **Step 4: Implement the coordinator with a 1500 ms debounce and retry-on-online behavior**

```ts
const SAVE_DEBOUNCE_MS = 1500;
window.addEventListener("online", () => coordinator.retryPending());

scheduleSave(project: CanvasProject) {
  clearTimeout(this.pendingTimers.get(project.id));
  this.pendingProjects.set(project.id, project);
  this.store.getState().setProjectSyncStatus(project.id, "saving");
  this.pendingTimers.set(project.id, window.setTimeout(() => void this.flush(project), SAVE_DEBOUNCE_MS));
}
```

On `TypeError` or `navigator.onLine === false`, set status to `offline` and retain the project in `pendingProjects`. On non-conflict HTTP failure, set `error` without clearing the draft. On successful response, update the store revision and status `saved`.

- [ ] **Step 5: Extend the canvas store without changing its localForage persistence contract**

```ts
type ProjectSyncStatus = "idle" | "saving" | "saved" | "offline" | "conflict" | "error";
type CanvasConflict = { local: CanvasProject; remote: RemoteCanvas };

syncStatusByProject: Record<string, ProjectSyncStatus>;
remoteRevisionByProject: Record<string, number>;
canvasConflictByProject: Record<string, CanvasConflict | undefined>;
setProjectSyncStatus: (projectId: string, status: ProjectSyncStatus) => void;
setRemoteCanvas: (project: CanvasProject, revision: number) => void;
setCanvasConflict: (projectId: string, conflict: CanvasConflict | undefined) => void;
```

Persist only `projects` through the existing `partialize`; sync presentation state is recreated at runtime.

- [ ] **Step 6: Run focused client tests**

Run: `cd web; bun test tests/canvas-project-sync.test.ts`

Expected: debounce, successful save, offline retention, conflict storage and retry tests pass.

- [ ] **Step 7: Commit the coordinator task**

```bash
git add web/src/services/canvas-project-sync.ts web/src/stores/canvas/use-canvas-store.ts web/tests/canvas-project-sync.test.ts
git commit -m "feat: add client canvas snapshot sync"
```

### Task 4: Connect sync to the canvas workspace and conflict UI

**Files:**
- Modify: `web/src/pages/canvas/project.tsx`
- Modify: `web/src/components/layout/client-root-init.tsx`
- Modify: `web/tests/canvas-project-sync.test.ts`

**Interfaces:**
- Consumes `CanvasSyncCoordinator` and store synchronization fields from Task 3.
- Produces non-blocking UI status and explicit conflict choices: load remote version or keep local version and save it using the remote revision.

- [ ] **Step 1: Write a failing UI-level test for opening, status display and conflict action dispatch**

```ts
test("shows a conflict action instead of silently replacing the local canvas", async () => {
  render(<CanvasProjectPage />);
  await screen.findByText("另一设备有更新");
  await userEvent.click(screen.getByRole("button", { name: "使用服务器版本" }));
  expect(coordinator.resolveConflict).toHaveBeenCalledWith(projectId, "use-remote");
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `cd web; bun test tests/canvas-project-sync.test.ts`

Expected: conflict controls are absent.

- [ ] **Step 3: Start remote hydration only for authenticated users and preserve local-first rendering**

```ts
useEffect(() => {
  if (authStatus !== "authenticated" || !projectId) return;
  void canvasSyncCoordinator.open(projectId);
  return () => { void canvasSyncCoordinator.flushCurrent(projectId); };
}, [authStatus, projectId]);
```

Subscribe to the current project's changes after hydration and call `scheduleSave` only for user-originated project updates. Do not make `client-root-init.tsx` poll all local projects every ten seconds; it should only create/sync project metadata when a project is created or renamed.

- [ ] **Step 4: Render a concise synchronization status and conflict controls**

```tsx
{syncStatus === "offline" && <Text type="secondary">已保存在此设备，等待同步</Text>}
{syncStatus === "saving" && <Text type="secondary">正在保存...</Text>}
{syncStatus === "saved" && <Text type="secondary">已保存</Text>}
{syncStatus === "conflict" && (
  <Alert
    type="warning"
    message="另一设备有更新"
    action={<Space><Button onClick={useRemote}>使用服务器版本</Button><Button type="primary" onClick={keepLocal}>保留此设备版本</Button></Space>}
  />
)}
```

The keep-local action must perform a new save using the conflict response's revision. The use-remote action must replace the local project and clear the queued local save.

- [ ] **Step 5: Run client tests and production build**

Run: `cd web; bun test && bun run build`

Expected: all web tests pass and Vite completes without TypeScript errors.

- [ ] **Step 6: Commit the workspace integration**

```bash
git add web/src/pages/canvas/project.tsx web/src/components/layout/client-root-init.tsx web/tests/canvas-project-sync.test.ts
git commit -m "feat: sync canvas projects across devices"
```

### Task 5: Correct mojibake and verify the production path

**Files:**
- Modify: `server/src/config.ts`
- Modify: `server/tests/production-readiness.test.ts`
- Modify: `web/src/stores/canvas/use-canvas-store.ts`
- Modify: `web/src/services/app-sync.ts`
- Test: affected server and web test files

**Interfaces:**
- Produces normal UTF-8 Chinese defaults and UI labels without changing configuration keys or persisted storage keys.

- [ ] **Step 1: Write focused assertions for affected visible copy**

```ts
test("uses the UTF-8 bootstrap administrator display name", () => {
  expect(defaultConfig.bootstrapAdminDisplayName).toBe("超级管理员");
});

test("creates a UTF-8 untitled canvas project", () => {
  expect(useCanvasStore.getState().createProject().name).toBe("未命名画布");
});
```

- [ ] **Step 2: Run the focused tests to verify current literals fail**

Run: `cd server; bun test tests/production-readiness.test.ts; cd ../web; bun test tests/canvas-project-sync.test.ts`

Expected: assertions expose the corrupted values before the source is corrected.

- [ ] **Step 3: Replace corrupted literals with exact UTF-8 source text**

Replace only visible literals and test fixtures, including `超级管理员`, `未命名画布`, and the WebDAV progress labels. Do not change encoding through bulk conversion; edit the known literals in UTF-8 files.

- [ ] **Step 4: Run full automated verification**

Run: `cd server; bun test && bun run build; cd ../web; bun test && bun run build`

Expected: all existing and new tests pass; both TypeScript builds succeed.

- [ ] **Step 5: Run the two-browser manual acceptance script**

1. Start the production-like compose environment and log in with the same account in two isolated browser profiles.
2. On profile A, create a canvas with two nodes, one connection, a chat message and a non-default viewport; wait for `已保存`.
3. On profile B, open the same project and verify all five fields restore.
4. Disconnect profile A, edit a node, verify `已保存在此设备，等待同步`, reconnect, and verify profile B receives the update after reopening.
5. Edit different names on both profiles, save A then B, and verify B sees the conflict alert with both choices.
6. Verify referenced generated media still opens from each profile.

- [ ] **Step 6: Commit final verification and UTF-8 fixes**

```bash
git add server/src/config.ts server/tests/production-readiness.test.ts web/src/stores/canvas/use-canvas-store.ts web/src/services/app-sync.ts
git commit -m "fix: preserve UTF-8 canvas copy"
```

## Plan Self-Review

- Spec coverage: Tasks 1-2 deliver the durable, permission-checked revisioned API; Tasks 3-4 deliver local-first hydration, debounce, offline retry and explicit conflict controls; Task 5 addresses UTF-8 and full validation. WebDAV remains outside all changes.
- Placeholder scan: all tasks name concrete files, commands, routes, data fields and expected outcomes.
- Type consistency: `RemoteCanvas`, revision maps and conflict payloads are defined in Task 3 and consumed with identical names in Task 4; endpoint paths match Task 2.
