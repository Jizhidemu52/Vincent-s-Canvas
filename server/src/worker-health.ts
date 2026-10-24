import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const workerHealthPath = join(tmpdir(), "canvas-worker-health.json");
export const WORKER_HEALTH_MAX_AGE_MS = 75_000;

export async function resetWorkerHealth(path = workerHealthPath) {
  await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; });
}

export async function readWorkerHealth(path = workerHealthPath, now = Date.now()) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (value.version !== 1 || !Number.isInteger(value.pid) || value.pid < 1 || !Number.isFinite(value.at)
      || value.at > now + 5000 || now - value.at > WORKER_HEALTH_MAX_AGE_MS) throw new Error("Worker heartbeat is missing or stale");
  return value as { version: 1; pid: number; at: number };
}

/** Independent of API health: publish only after this consumer and both of its
 * dependencies respond. A stuck probe cannot start overlapping probes. */
export function startWorkerHealth(dependencies: { probe(): Promise<unknown>; isRunning(): boolean }, options: { path?: string; intervalMs?: number } = {}) {
  const path = options.path ?? workerHealthPath;
  const temporary = `${path}.${process.pid}.tmp`;
  let stopped = false;
  let pending: Promise<void> | undefined;
  async function tick() {
    if (stopped || pending) return;
    pending = (async () => {
      await dependencies.probe();
      if (stopped || !dependencies.isRunning()) return;
      await writeFile(temporary, JSON.stringify({ version: 1, pid: process.pid, at: Date.now() }));
      if (stopped) { await unlink(temporary).catch(() => undefined); return; }
      await rename(temporary, path);
      if (stopped) await unlink(path).catch(() => undefined);
    })().catch(() => { /* Existing success expires; failures never refresh it. */ });
    try { await pending; } finally { pending = undefined; }
  }
  const timer = setInterval(() => { void tick(); }, options.intervalMs ?? 15_000);
  timer.unref();
  void tick();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      // Do not await a potentially hung dependency during worker shutdown.
      await Promise.all([unlink(path).catch(() => undefined), unlink(temporary).catch(() => undefined)]);
    },
  };
}
