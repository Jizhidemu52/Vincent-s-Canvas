import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkerHealth, resetWorkerHealth, startWorkerHealth, WORKER_HEALTH_MAX_AGE_MS } from "../src/worker-health";

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 1000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Worker heartbeat fixture timed out");
    await Bun.sleep(5);
  }
}
test("worker health is written only after dependencies respond, expires, and is removed on shutdown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-worker-health-test-")), path = join(dir, "health.json");
  let probes = 0;
  const reporter = startWorkerHealth({ probe: async () => { if (++probes > 1) throw new Error("offline"); }, isRunning: () => true }, { path, intervalMs: 10 });
  try {
    await until(async () => Boolean(await readWorkerHealth(path).catch(() => null)));
    const first = await readWorkerHealth(path);
    expect(first.pid).toBe(process.pid);
    await Bun.sleep(30);
    const current = await readWorkerHealth(path);
    expect(probes).toBeGreaterThan(1);
    expect(current.at).toBe(first.at);
    await expect(readWorkerHealth(path, current.at + WORKER_HEALTH_MAX_AGE_MS + 1)).rejects.toThrow("stale");
    await reporter.stop();
    await expect(readFile(path)).rejects.toThrow();
  } finally { await reporter.stop(); await rm(dir, { recursive: true, force: true }); }
});
test("a stalled dependency cannot overlap probes or republish after stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-worker-health-test-")), path = join(dir, "health.json");
  let calls = 0, release!: () => void;
  const reporter = startWorkerHealth({ probe: () => { calls++; return new Promise<void>(resolve => { release = resolve; }); }, isRunning: () => true }, { path, intervalMs: 5 });
  try {
    await Bun.sleep(25); expect(calls).toBe(1);
    await reporter.stop(); release(); await Bun.sleep(15);
    expect(calls).toBe(1);
    await expect(readFile(path)).rejects.toThrow();
  } finally { await reporter.stop(); await rm(dir, { recursive: true, force: true }); }
});
test("malformed and future heartbeat files do not pass health checks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-worker-health-test-")), path = join(dir, "health.json");
  try {
    for (const value of [{}, { version: 1, pid: 0, at: Date.now() }, { version: 1, pid: 1, at: Date.now() + 60_000 }]) {
      await writeFile(path, JSON.stringify(value));
      await expect(readWorkerHealth(path)).rejects.toThrow();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("startup discards a previous container process heartbeat even when the PID is reused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-worker-health-test-")), path = join(dir, "health.json");
  try {
    await writeFile(path, JSON.stringify({ version: 1, pid: process.pid, at: Date.now() }));
    await resetWorkerHealth(path);
    await expect(readWorkerHealth(path)).rejects.toThrow();
    await resetWorkerHealth(path);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
