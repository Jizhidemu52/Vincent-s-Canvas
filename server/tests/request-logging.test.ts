import { expect, spyOn, test } from "bun:test";
import express from "express";
import { currentCorrelationId, logDemoRequest, requestLogging } from "../src/request-logging";

test("HTTP correlation survives concurrent async work without logging query, cookie, authorization or body", async () => {
  const lines: Record<string, unknown>[] = [];
  const log = spyOn(console, "log").mockImplementation(value => { lines.push(JSON.parse(value)); });
  const app = express(); app.use(requestLogging(), express.json());
  app.post("/api/fixture/:id", async (_request, response) => {
    await Bun.sleep(5); response.json({ correlationId: currentCorrelationId() });
  });
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const id = `fixture-correlation-${index}`;
      const response = await fetch(`${base}/api/fixture/private-id?oa_token=secret-query`, { method: "POST", headers: {
        "x-request-id": id, "content-type": "application/json", cookie: "session=secret-cookie", authorization: "Bearer secret-credential",
      }, body: JSON.stringify({ prompt: "secret-prompt" }) });
      expect(response.headers.get("x-request-id")).toBe(id);
      expect(await response.json()).toEqual({ correlationId: id });
    }));
    expect(lines).toHaveLength(8);
    expect(new Set(lines.map(line => line.correlationId)).size).toBe(8);
    expect(lines.every(line => line.event === "http_request" && line.status === 200 && line.route === "/api/fixture/:id" && Number(line.durationMs) >= 0)).toBe(true);
    expect(JSON.stringify(lines)).not.toMatch(/secret-|private-id|oa_token/);
    expect(currentCorrelationId()).toBeUndefined();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); log.mockRestore(); }
});

test("demo correlation rejects arbitrary header content and logging exceptions cannot change a successful response", async () => {
  const lines: Record<string, unknown>[] = [];
  const log = spyOn(console, "log").mockImplementation(value => { lines.push(JSON.parse(value)); });
  try {
    const response = await logDemoRequest(new Request("https://canvas.example/api/fixture?token=secret", { headers: { "x-request-id": "invalid correlation credential" } }), async () => {
      await Promise.resolve(); return Response.json({ id: currentCorrelationId() }, { status: 201 });
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
    expect((await response.json()).id).toBe(response.headers.get("x-request-id"));
    expect(lines).toHaveLength(1); expect(JSON.stringify(lines)).not.toMatch(/secret|credential|token/);
    log.mockImplementation(() => { throw new Error("logger unavailable"); });
    expect((await logDemoRequest(new Request("https://canvas.example/"), async () => new Response("ok"))).status).toBe(200);
  } finally { log.mockRestore(); }
});
