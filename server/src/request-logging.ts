import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";

const context = new AsyncLocalStorage<{ correlationId: string }>();
export const currentCorrelationId = () => context.getStore()?.correlationId;
export const correlationId = (value?: string | null) => value && /^[A-Za-z0-9_-]{8,80}$/.test(value) ? value : randomUUID();
function emit(runtime: "api" | "demo", id: string, method: string, status: number, started: number, route: string) {
  try { console.log(JSON.stringify({ event: "http_request", timestamp: new Date().toISOString(), runtime, correlationId: id, method, route, status, durationMs: Math.round(performance.now() - started) })); }
  catch { /* Logging cannot change request semantics. No URLs, bodies, headers or credentials. */ }
}
export function requestLogging(): RequestHandler {
  return (request, response, next) => {
    const id = correlationId(request.header("x-request-id"));
    const started = performance.now();
    response.setHeader("x-request-id", id);
    let logged = false;
    const done = () => {
      if (logged) return; logged = true;
      emit("api", id, request.method, response.writableFinished ? response.statusCode : 499, started, typeof request.route?.path === "string" ? request.route.path : "unmatched");
    };
    response.once("finish", done); response.once("close", done);
    context.run({ correlationId: id }, next);
  };
}
export async function logDemoRequest(request: Request, action: () => Promise<Response>) {
  const id = correlationId(request.headers.get("x-request-id"));
  const started = performance.now();
  return context.run({ correlationId: id }, async () => {
    try {
      const response = await action();
      response.headers.set("x-request-id", id);
      emit("demo", id, request.method, response.status, started, new URL(request.url).pathname.startsWith("/api/") ? "api" : "web");
      return response;
    } catch (error) { emit("demo", id, request.method, error instanceof Error && error.name === "ZodError" ? 400 : 500, started, "api"); throw error; }
  });
}
