import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { apiRoutes, callApi, createServerState, type ApiError, type ServerState } from "./api";
import type { GenerationRequest, GenerationResult } from "../src/domain/workspace";

type ApiPath = keyof typeof apiRoutes;
type ApiResult = ReturnType<(typeof apiRoutes)[ApiPath]> | ApiError;

const readOnlyRoutes = new Set<ApiPath>([
  "/api/models",
  "/api/profile",
  "/api/history",
  "/api/admin/audit",
  "/api/admin/usage",
  "/api/admin/providers"
]);

const writeRoutes = new Set<ApiPath>(["/api/generations", "/api/edits", "/api/upscale", "/api/remove-bg"]);

export interface ApiHttpServerOptions {
  state?: ServerState;
  bodyLimitBytes?: number;
}

export interface StartApiServerOptions extends ApiHttpServerOptions {
  host?: string;
  port?: number;
}

function corsHeaders() {
  return {
    "access-control-allow-headers": "content-type,x-request-id",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8"
  };
}

function sendJson(response: ServerResponse, statusCode: number, payload?: unknown) {
  response.writeHead(statusCode, corsHeaders());
  response.end(payload === undefined ? "" : JSON.stringify(payload));
}

function statusFromApiError(error: ApiError) {
  if (error.errorMessage === "Duplicate request") return 409;
  if (error.errorMessage === "Not enough credits") return 402;
  if (error.errorMessage === "Model not found") return 404;
  return 400;
}

function isApiError(result: ApiResult): result is ApiError {
  return "errorMessage" in result && result.status === "failed" && !("outputs" in result);
}

function statusFromApiResult(result: ApiResult) {
  return isApiError(result) ? statusFromApiError(result) : 200;
}

async function readJsonBody(request: IncomingMessage, limitBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limitBytes) {
      throw new Error("Request body is too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return undefined;
  return JSON.parse(text) as GenerationRequest;
}

function isApiPath(pathname: string): pathname is ApiPath {
  return pathname in apiRoutes;
}

export function createApiHttpServer(options: ApiHttpServerOptions = {}): Server {
  const state = options.state ?? createServerState();
  const bodyLimitBytes = options.bodyLimitBytes ?? 1_000_000;

  return createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (!isApiPath(pathname)) {
        sendJson(response, 404, { status: "failed", errorMessage: "Route not found" });
        return;
      }

      if (request.method === "OPTIONS") {
        sendJson(response, 204);
        return;
      }

      if (readOnlyRoutes.has(pathname)) {
        if (request.method !== "GET") {
          sendJson(response, 405, { status: "failed", errorMessage: "Method not allowed" });
          return;
        }
        const result = callApi(state, pathname);
        sendJson(response, statusFromApiResult(result), result);
        return;
      }

      if (writeRoutes.has(pathname)) {
        if (request.method !== "POST") {
          sendJson(response, 405, { status: "failed", errorMessage: "Method not allowed" });
          return;
        }
        const body = await readJsonBody(request, bodyLimitBytes);
        const result = callApi(state, pathname, body, request.headers["x-request-id"]?.toString());
        sendJson(response, statusFromApiResult(result), result);
        return;
      }

      sendJson(response, 500, { status: "failed", errorMessage: "Route is not configured" });
    } catch (error) {
      const message = error instanceof SyntaxError ? "Invalid JSON body" : error instanceof Error ? error.message : "Unknown server error";
      const statusCode = message === "Request body is too large" ? 413 : 400;
      sendJson(response, statusCode, { status: "failed", errorMessage: message });
    }
  });
}

export async function startApiServer(options: StartApiServerOptions = {}) {
  const host = options.host ?? process.env.API_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.API_PORT ?? 8787);
  const server = createApiHttpServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { server, host, port };
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  startApiServer()
    .then(({ host, port }) => {
      console.log(`Designer canvas API listening on http://${host}:${port}`);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

export type { GenerationRequest, GenerationResult };
