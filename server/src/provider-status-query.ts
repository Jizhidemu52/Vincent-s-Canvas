type QueryRuntime = {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<unknown>;
};

/** Only idempotent GETs are retried. A failed query says nothing about billing. */
export async function queryProviderTaskStatus(url: string, headers: HeadersInit, runtime: QueryRuntime = {}) {
  const request = runtime.fetch ?? fetch;
  const sleep = runtime.sleep ?? Bun.sleep;
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await request(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      if (attempt >= 2) throw error;
      await sleep(1_000 * 2 ** attempt);
      continue;
    }
    if (attempt >= 2 || !(response.status === 408 || response.status === 429 || response.status >= 500)) return response;
    await response.body?.cancel().catch(() => undefined);
    await sleep(1_000 * 2 ** attempt);
  }
}
