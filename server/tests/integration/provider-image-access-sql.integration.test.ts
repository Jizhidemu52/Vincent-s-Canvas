import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import ts from "typescript";
import { loadConfig } from "../../src/config";
import type { Cache } from "../../src/db";
import type { ObjectStorage, ObjectReadOptions } from "../../src/object-storage";
import { ProviderImageAccess, PROVIDER_IMAGE_PATH } from "../../src/provider-image-access";
import { createProviderImagesRouter } from "../../src/routes/provider-images";
import { createAssetsRouter } from "../../src/routes/assets";
import { requireAccountReady, sessionMiddleware } from "../../src/session";
import { requireSameOrigin } from "../../src/http-security";
import { requestLogging } from "../../src/request-logging";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const integration = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=", "base64");
const origin = "http://ai.in-choice.com.cn";

integration("formal route wiring and real SQL allow only a live task original; anonymous employee assets stay protected", async () => {
  const fixture = await createIsolatedPostgres();
  const owner = randomUUID(), peer = randomUUID(), taskId = randomUUID(), assetId = randomUUID(), lease = randomUUID();
  const objectKey = `users/${owner}/original.png`, etag = '"original-fixture"';
  const records = new Map<string, string>();
  const cache = { get: async (key: string) => records.get(key) ?? null,
    set: async (key: string, value: string, options: { EX: number }) => { expect(options.EX).toBe(1800); records.set(key, value); return "OK"; } } as unknown as Cache;
  const storage = {
    head: async (key: string) => { expect(key).toBe(objectKey); return { ETag: etag, ContentLength: png.length }; },
    get: async (key: string, options: ObjectReadOptions) => {
      expect(key).toBe(objectKey); expect(options.ifMatch).toBe(etag);
      const range = /^bytes=(\d+)-(\d+)$/.exec(options.range ?? "");
      const bytes = range ? png.subarray(Number(range[1]), Number(range[2]) + 1) : png;
      return { Body: Readable.from([bytes]), ETag: etag, ContentLength: bytes.length,
        ...(range ? { ContentRange: `bytes ${range[1]}-${range[2]}/${png.length}` } : {}) };
    },
  } as unknown as ObjectStorage;
  const access = new ProviderImageAccess(fixture.db, cache, storage, origin);
  const source = { assetId, objectKey, bytes: png, mimeType: "image/png", etag };
  const input = { taskId, userId: owner, executionToken: lease, source };
  const logs: string[] = [];
  const logger = spyOn(console, "log").mockImplementation(line => { logs.push(String(line)); });
  const servers: ReturnType<express.Express["listen"]>[] = [];
  try {
    await fixture.db.query("INSERT INTO users(id,username,display_name) VALUES($1,'http-owner','Owner'),($2,'http-peer','Peer')", [owner, peer]);
    await fixture.db.query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,status) VALUES($1,$2,$3,'original.png','image/png',$4,'ready')", [assetId, owner, objectKey, png.length]);
    await fixture.db.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,status,source_urls,execution_token,lease_expires_at) VALUES($1,$2,$3,'http-fixture','inpaint','processing',$4::jsonb,$5,now()+interval '5 minutes')", [taskId, `http-${taskId}`, owner, JSON.stringify([`/api/assets/${assetId}/content`]), lease]);
    const url = await access.issue(input), path = new URL(url).pathname;
    // Execute the production registration statements, not a hand-written test
    // alternative that could accidentally mount public assets in another order.
    const text = await Bun.file(new URL("../../src/index.ts", import.meta.url)).text();
    const ast = ts.createSourceFile("index.ts", text, ts.ScriptTarget.Latest, true);
    const registrations = ast.statements.filter(node => ts.isIfStatement(node) && node.expression.getText(ast) === "config.PROVIDER_IMAGE_PUBLIC_ORIGIN"
      || ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === "app.use"
        && node.expression.arguments[0]?.getText(ast) === '"/api/assets"');
    expect(registrations).toHaveLength(2);
    const code = ts.transpileModule(registrations.map(node => node.getText(ast)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    const serve = async (enabled: boolean) => {
      const config = loadConfig({ DATABASE_URL: "unused-fixture", REDIS_URL: "unused-fixture", AUTH_ENABLED: "true", PROVIDER_IMAGE_PUBLIC_ORIGIN: enabled ? origin : "" });
      const app = express().use(helmet(), requestLogging(), cookieParser(), requireSameOrigin);
      const values = { app, config, db: fixture.db, cache, storage, PROVIDER_IMAGE_PATH, ProviderImageAccess, createProviderImagesRouter, createAssetsRouter,
        requireSession: sessionMiddleware(fixture.db, cache, config, { allowPersonalWorkspace: true }), requireAccountReady,
        protectModelIdentity: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(), videoPlayback: undefined };
      new Function(...Object.keys(values), code)(...Object.values(values));
      const server = app.listen(0, "127.0.0.1"); servers.push(server);
      await new Promise<void>(resolve => server.once("listening", resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    const base = await serve(true);
    const get = await fetch(base + path);
    expect(get.status).toBe(200); expect(get.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await get.arrayBuffer())).toEqual(png);
    const head = await fetch(base + path, { method: "HEAD" }); expect(head.status).toBe(200); expect(await head.text()).toBe("");
    const range = await fetch(base + path, { headers: { range: "bytes=2-10" } });
    expect(range.status).toBe(206); expect(Buffer.from(await range.arrayBuffer())).toEqual(png.subarray(2, 11));
    expect((await fetch(`${base}/api/assets/${assetId}/content`)).status).toBe(401);
    expect((await fetch(base + path, { method: "POST" })).status).toBe(404);
    await expect(access.issue({ ...input, userId: peer })).rejects.toMatchObject({ status: 404 });
    await fixture.db.query("UPDATE tasks SET execution_token=NULL,lease_expires_at=NULL WHERE id=$1", [taskId]);
    expect((await fetch(base + path)).status).toBe(200); // Polling released only the local lease.
    await expect(access.issue(input)).rejects.toMatchObject({ status: 404 });
    for (const status of ["success", "cancelled", "failed", "paused"]) {
      await fixture.db.query("UPDATE tasks SET status=$2 WHERE id=$1", [taskId, status]);
      expect((await fetch(base + path)).status).toBe(404);
    }
    await fixture.db.query("UPDATE tasks SET status='processing' WHERE id=$1", [taskId]);
    await fixture.db.query("UPDATE users SET status='disabled' WHERE id=$1", [owner]);
    expect((await fetch(base + path)).status).toBe(404);
    await fixture.db.query("UPDATE users SET status='active' WHERE id=$1", [owner]);
    await fixture.db.query("UPDATE assets SET deleted_at=now() WHERE id=$1", [assetId]);
    expect((await fetch(base + path)).status).toBe(404);
    await fixture.db.query("UPDATE assets SET deleted_at=NULL WHERE id=$1", [assetId]);
    const disabled = await serve(false);
    expect((await fetch(disabled + path)).status).toBe(404);
    expect((await fetch(`${disabled}/api/assets/${assetId}/content`)).status).toBe(401);
    const key = [...records.keys()][0]!;
    const grant = JSON.parse(records.get(key)!); records.set(key, JSON.stringify({ ...grant, expiresAt: Date.now() - 1 }));
    expect((await fetch(base + path)).status).toBe(404);
    expect(logs.join("\n")).not.toContain(path.split("/")[3]!);
    expect(logs.join("\n")).not.toContain(objectKey);
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    logger.mockRestore(); await fixture.close();
  }
}, 30_000);
