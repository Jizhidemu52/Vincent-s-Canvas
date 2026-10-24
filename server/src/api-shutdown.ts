import type { Server } from "node:http";

export const API_SHUTDOWN_GRACE_MS = 30_000;

type ShutdownOptions = {
  server: Pick<Server, "close" | "closeIdleConnections" | "closeAllConnections">;
  drainSubscriptions: () => void;
  closeBackground?: () => Promise<unknown>;
  closeEvents: () => Promise<unknown>;
  closeDatabase: () => Promise<unknown>;
  closeCache: () => Promise<unknown>;
  timeoutMs?: number;
  exit?: (code: number) => void;
  log?: (event: string, detail: Record<string, unknown>) => void;
};

/** Stop admission, drain HTTP while its dependencies remain usable, then close
 * shared resources. One deadline covers both requests and resource shutdown. */
export function createApiShutdown(options: ShutdownOptions) {
  const exit = options.exit ?? (code => process.exit(code));
  const log = options.log ?? ((event, detail) => console.log(JSON.stringify({ event, ...detail })));
  let completion: Promise<void> | undefined;
  return (signal: string) => {
    if (completion) return completion;
    completion = new Promise<void>(resolve => {
      let finished = false;
      let stage = "http_drain";
      const finish = (code: number) => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        log(code ? "api.shutdown_failed" : "api.shutdown_complete", { signal, stage });
        resolve();
        exit(code);
      };
      const deadline = setTimeout(() => {
        if (finished) return;
        log("api.shutdown_timeout", { signal, stage });
        // A timed-out handler may still be using the database. Exit instead of
        // closing its pool underneath it or pretending that draining succeeded.
        try { options.server.closeAllConnections(); } catch { /* Exit remains bounded. */ }
        finish(1);
      }, options.timeoutMs ?? API_SHUTDOWN_GRACE_MS);
      log("api.shutdown_started", { signal, timeoutMs: options.timeoutMs ?? API_SHUTDOWN_GRACE_MS });
      void (async () => {
        const drained = new Promise<void>((done, reject) => {
          options.server.close(error => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : done());
          options.server.closeIdleConnections();
        });
        // Notification-only SSE connections have no unfinished business work.
        // End them after closing admission, without releasing LISTEN or its pool.
        options.drainSubscriptions();
        await drained;
        if (finished) return;
        let failed = false;
        stage = "background_shutdown";
        try { await options.closeBackground?.(); } catch { failed = true; }
        if (finished) return;
        stage = "event_shutdown";
        try { await options.closeEvents(); } catch { failed = true; }
        if (finished) return;
        stage = "dependency_shutdown";
        const results = await Promise.allSettled([
          Promise.resolve().then(options.closeDatabase),
          Promise.resolve().then(options.closeCache),
        ]);
        if (finished) return;
        finish(failed || results.some(result => result.status === "rejected") ? 1 : 0);
      })().catch(() => finish(1));
    });
    return completion;
  };
}
