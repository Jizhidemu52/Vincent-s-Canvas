import { readWorkerHealth } from "./worker-health";

try {
  const health = await readWorkerHealth();
  process.kill(health.pid, 0);
} catch {
  console.error("Worker consumer heartbeat is unavailable");
  process.exitCode = 1;
}
