/** Age is durable submission time, not a process-local poll count or a renewed deadline. */
export function apiMartPollIntervalMs(submissionStartedAt: string | Date | null | undefined, minimumMs: number, nowMs = Date.now()) {
  const startedMs = typeof submissionStartedAt === "string" ? Date.parse(submissionStartedAt) : submissionStartedAt?.getTime();
  if (startedMs === undefined || !Number.isFinite(startedMs) || !Number.isFinite(nowMs)) return minimumMs;
  const ageMs = Math.max(0, nowMs - startedMs);
  const intervalMs = ageMs < 30_000 ? 2_000 : ageMs < 120_000 ? 5_000 : ageMs < 300_000 ? 10_000 : 30_000;
  return Math.max(minimumMs, intervalMs);
}
