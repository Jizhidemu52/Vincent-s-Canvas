import { expect, test } from "bun:test";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTasksRouter } from "../src/routes/tasks";
import { DemoStateStore } from "../src/demo-state-store";
import { createIsolatedPostgres } from "./helpers/isolated-postgres";
import { verifyTaskHttpContract } from "./helpers/task-http-contract";
import type { Cache } from "../src/db";
import type { AuthenticatedRequest } from "../src/types";

const id = "63000000-0000-4000-8000-000000000001", owner = "00000000-0000-4000-8000-000000000003";
const requestId = "contract-fixture-completed";
const input = { requestId, projectId: "contract-canvas", operationType: "image_generation", modelConfigId: null, prompt: "contract fixture", sourceUrls: [] };

test("demo-server runs the shared task input and response contract over HTTP without a provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvas-contract-"));
  const statePath = join(directory, "state.sqlite");
  const state = new DemoStateStore(statePath);
  state.initialize({ assets: [], tasks: [{ id, requestId, status: "success", ownerUserId: owner, operationType: "image_generation", resultUrls: [], failureReason: null, credits: 0, createdAt: new Date().toISOString() } as any] }); state.close();
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }); const port = probe.port!; await probe.stop(true);
  const processHandle = Bun.spawn([process.execPath, "--no-env-file", "src/demo-server.ts"], { cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "pipe", env: { ...process.env, DEMO_HOST: "127.0.0.1", DEMO_PORT: String(port), DEMO_STATE_PATH: statePath, DEMO_RECOVERY_FILE: "", OA_LOGIN_ENABLED: "false", STANDALONE_WEB_DIR: "", OPENTOKEN_API_KEY: "", APIMART_API_KEY: "", GPT_IMAGE_2_API_KEY: "", MARK_IMAGE_API_KEY: "" } });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await fetch(`${base}/api/health`).then(r => r.ok).catch(() => false)) { ready = true; break; }
      if (processHandle.exitCode !== null) throw new Error(await new Response(processHandle.stderr).text());
      await Bun.sleep(50);
    }
    expect(ready).toBe(true); await verifyTaskHttpContract({ base, submission: input, expected: { id, requestId, status: "success" } });
  } finally { processHandle.kill(); await processHandle.exited; await rm(directory, { recursive: true, force: true }); }
}, 20_000);

(process.env.PGLITE_RUNTIME_PATH ? test : test.skip)("production task router mounted by index.ts runs the same HTTP contract", async () => {
  const fixture = await createIsolatedPostgres();
  await fixture.db.query("INSERT INTO users(id,username,display_name,role) VALUES($1,'contract-employee','Contract employee','designer')", [owner]);
  await fixture.db.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,prompt,status) VALUES($1,$2,$3,'contract-canvas','image_generation','contract fixture','success')", [id, requestId, owner]);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as AuthenticatedRequest).auth = { id: owner, role: "designer", departmentId: null } as AuthenticatedRequest["auth"]; next(); });
  app.use("/api/tasks", createTasksRouter(fixture.db, {} as Cache, false));
  app.use(((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.name === "ZodError" || error instanceof SyntaxError ? 400 : 500).json({ error: error.name })) as express.ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(done => server.once("listening", done));
  try { await verifyTaskHttpContract({ base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, submission: input, expected: { id, requestId, status: "success" } }); }
  finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await fixture.close(); }
}, 30_000);
