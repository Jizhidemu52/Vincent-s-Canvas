import { expect, test } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";
import type { AppConfig } from "../src/config";
import type { Cache, Database } from "../src/db";
import { createAuthRouter } from "../src/routes/auth";

test("retired WeCom routes reject requests before touching identity services", async () => {
  const cache = { get: async () => "admin" } as unknown as Cache;
  const db = { query: () => { throw new Error("Must reject before database or upstream access"); } } as unknown as Database;
  const app = express();
  app.use("/auth", createAuthRouter(db, cache, { ROLE_PORTALS_ENABLED: "false" } as AppConfig));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await fetch(`${origin}/auth/wecom/start?portal=admin`)).status).toBe(404);
    expect((await fetch(`${origin}/auth/wecom/callback?state=legacy-admin&code=unused`)).status).toBe(404);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});
