import { expect, test } from "bun:test";
import { createServer, get } from "node:http";
import { createApiShutdown } from "../src/api-shutdown";
import { createIsolatedPostgres } from "./helpers/isolated-postgres";

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve };
}

test("shutdown waits for a real HTTP handler before closing events/database/cache and coalesces signals", async () => {
  const started = deferred(), release = deferred(), events: string[] = [], exits: number[] = [];
  const server = createServer(async (_request, response) => {
    started.resolve(); await release.promise;
    events.push("handler-completed"); response.end("saved");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const response = fetch(`http://127.0.0.1:${address.port}`).then(value => value.text());
  await started.promise;
  const shutdown = createApiShutdown({ server, drainSubscriptions: () => { events.push("drain-sse"); },
    closeBackground: async () => { events.push("background"); },
    closeEvents: async () => { events.push("events"); }, closeDatabase: async () => { events.push("database"); },
    closeCache: async () => { events.push("cache"); }, exit: code => { exits.push(code); }, log() {}, timeoutMs: 2_000 });
  const done = shutdown("SIGTERM");
  expect(shutdown("SIGINT")).toBe(done);
  expect(events).toEqual(["drain-sse"]);
  expect(exits).toEqual([]);
  release.resolve();
  expect(await response).toBe("saved");
  await done;
  expect(events).toEqual(["drain-sse", "handler-completed", "background", "events", "database", "cache"]);
  expect(exits).toEqual([0]);
});

test("a stuck HTTP handler is disconnected at the bound without closing its database underneath it", async () => {
  const started = deferred(), events: string[] = [], exits: number[] = [];
  const server = createServer((_request, response) => { response.write("partial"); started.resolve(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const request = get(`http://127.0.0.1:${address.port}`, response => { response.resume(); response.on("error", () => {}); });
  request.on("error", () => {});
  await started.promise;
  const shutdown = createApiShutdown({ server, drainSubscriptions() {},
    closeEvents: async () => { events.push("events"); }, closeDatabase: async () => { events.push("database"); },
    closeCache: async () => { events.push("cache"); }, exit: code => { exits.push(code); }, log() {}, timeoutMs: 20 });
  await shutdown("SIGTERM");
  expect(exits).toEqual([1]); expect(events).toEqual([]);
  request.destroy(); server.closeAllConnections();
});

test.each(["reject", "hang"])("dependency %s cannot prevent bounded nonzero shutdown or the other resource cleanup", async mode => {
  const server = createServer();
  const events: string[] = [], exits: number[] = [];
  const shutdown = createApiShutdown({ server, drainSubscriptions() {}, closeEvents: async () => {},
    closeDatabase: async () => { events.push("database"); if (mode === "reject") throw new Error("fixture"); await new Promise(() => {}); },
    closeCache: async () => { events.push("cache"); }, exit: code => { exits.push(code); }, log() {}, timeoutMs: 20 });
  await shutdown("SIGINT");
  expect(events).toEqual(["database", "cache"]); expect(exits).toEqual([1]);
});

test("background work drains before its database closes and remains covered by the same deadline", async () => {
  for (const hang of [false, true]) {
    const started = deferred(), release = deferred(), events: string[] = [], exits: number[] = [];
    const shutdown = createApiShutdown({ server: createServer(), drainSubscriptions() {},
      closeBackground: async () => { events.push("background"); started.resolve(); await release.promise; },
      closeEvents: async () => { events.push("events"); }, closeDatabase: async () => { events.push("database"); },
      closeCache: async () => { events.push("cache"); }, exit: code => { exits.push(code); }, log() {}, timeoutMs: 30 });
    const done = shutdown("SIGTERM"); await started.promise;
    expect(events).toEqual(["background"]);
    if (!hang) release.resolve();
    await done;
    expect(exits).toEqual([hang ? 1 : 0]);
    expect(events).toEqual(hang ? ["background"] : ["background", "events", "database", "cache"]);
    release.resolve();
  }
});

(process.env.PGLITE_RUNTIME_PATH ? test : test.skip)("real HTTP work commits to isolated PostgreSQL before shutdown closes that database", async () => {
  const fixture = await createIsolatedPostgres();
  const started = deferred(), release = deferred(), exits: number[] = [];
  let persisted = false, closed = false;
  const server = createServer(async (_request, response) => {
    started.resolve(); await release.promise;
    await fixture.db.query("CREATE TABLE shutdown_fixture (value text)");
    await fixture.db.query("INSERT INTO shutdown_fixture VALUES ('committed')");
    response.end("committed");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}`).then(value => value.text());
    await started.promise;
    const shutdown = createApiShutdown({ server, drainSubscriptions() {}, closeEvents: async () => {},
      closeDatabase: async () => {
        persisted = (await fixture.db.query("SELECT value FROM shutdown_fixture")).rows[0]?.value === "committed";
        await fixture.close(); closed = true;
      }, closeCache: async () => {}, exit: code => { exits.push(code); }, log() {}, timeoutMs: 5_000 });
    const done = shutdown("SIGTERM");
    expect(closed).toBe(false);
    release.resolve(); expect(await response).toBe("committed"); await done;
    expect(persisted).toBe(true); expect(closed).toBe(true); expect(exits).toEqual([0]);
  } finally { server.closeAllConnections(); server.close(); if (!closed) await fixture.close(); }
}, 30_000);
