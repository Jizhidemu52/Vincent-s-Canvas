import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import {
  adjustAccountCredits,
  apiRoutes,
  callApi,
  callApiAsync,
  configureProviderSettings,
  configureModelPricing,
  configureOperationPricing,
  configureModelRegistry,
  createServerState,
  getWorkspaceSnapshot,
  saveWorkspaceSnapshot,
  setAccountCreditLimit,
  type ApiError,
  type AdminHistoryArchiveRequest,
  type AssetMetadataRequest,
  type CreditAdjustmentRequest,
  type CreditLimitRequest,
  type ModelPricingRequest,
  type OperationPricingRequest,
  type ModelRegistryRequest,
  type PromptPresetRequest,
  type ProviderSettingsRequest,
  type ServerState,
  type WorkspaceSnapshot
} from "./api";
import { loadServerState, saveServerState } from "./storage";
import type { ProviderFetchInit, ProviderFetchResponse } from "./providers";
import type { GenerationRequest, GenerationResult } from "../src/domain/workspace";

type ApiPath = keyof typeof apiRoutes;
type ApiResult = ReturnType<(typeof apiRoutes)[ApiPath]> | ApiError | unknown;

const readOnlyRoutes = new Set<ApiPath>([
  "/api/models",
  "/api/profile",
  "/api/history",
  "/api/admin/history",
  "/api/admin/audit",
  "/api/admin/usage",
  "/api/admin/accounts",
  "/api/admin/jobs",
  "/api/admin/providers"
]);

const writeRoutes = new Set<ApiPath>(["/api/generations", "/api/edits", "/api/upscale", "/api/remove-bg"]);
const DEFAULT_BODY_LIMIT_BYTES = 25_000_000;

export interface ApiHttpServerOptions {
  state?: ServerState;
  stateFilePath?: string;
  bodyLimitBytes?: number;
  providerFetchJson?: (url: string, init: ProviderFetchInit) => Promise<ProviderFetchResponse>;
  resolveProviderSecret?: (name: string) => string | undefined;
}

export interface StartApiServerOptions extends ApiHttpServerOptions {
  host?: string;
  port?: number;
}

function corsHeaders() {
  return {
    "access-control-allow-headers": "content-type,x-request-id,x-user-id",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8"
  };
}

function userIdFromRequest(request: IncomingMessage) {
  return request.headers["x-user-id"]?.toString();
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

function isApiError(result: unknown): result is ApiError {
  return (
    typeof result === "object" &&
    result !== null &&
    "errorMessage" in result &&
    "status" in result &&
    result.status === "failed" &&
    !("outputs" in result)
  );
}

function statusFromApiResult(result: unknown) {
  return isApiError(result) ? statusFromApiError(result) : 200;
}

async function readJsonBody<T = unknown>(request: IncomingMessage, limitBytes: number) {
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
  return JSON.parse(text) as T;
}

function isApiPath(pathname: string): pathname is ApiPath {
  return pathname in apiRoutes;
}

async function defaultProviderFetchJson(url: string, init: ProviderFetchInit): Promise<ProviderFetchResponse> {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return {
    ok: response.ok,
    status: response.status,
    body
  };
}

function defaultResolveProviderSecret(name: string) {
  return process.env[name]?.trim() || undefined;
}

export function createApiHttpServer(options: ApiHttpServerOptions = {}): Server {
  const stateFilePath = options.stateFilePath;
  const state = options.state ?? (stateFilePath ? loadServerState(stateFilePath) : createServerState());
  const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
  const providerFetchJson = options.providerFetchJson ?? defaultProviderFetchJson;
  const resolveProviderSecret = options.resolveProviderSecret ?? defaultResolveProviderSecret;

  return createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const pathname = requestUrl.pathname;
      const userId = userIdFromRequest(request);
      if (pathname === "/api/workspace") {
        if (request.method === "OPTIONS") {
          sendJson(response, 204);
          return;
        }
        if (request.method === "GET") {
          sendJson(response, 200, getWorkspaceSnapshot(state, userId));
          return;
        }
        if (request.method === "POST") {
          const body = await readJsonBody<Partial<WorkspaceSnapshot>>(request, bodyLimitBytes);
          const result = saveWorkspaceSnapshot(state, body ?? {}, userId);
          if (stateFilePath) {
            saveServerState(stateFilePath, state);
          }
          sendJson(response, 200, result);
          return;
        }
        sendJson(response, 405, { status: "failed", errorMessage: "Method not allowed" });
        return;
      }

      if (pathname === "/api/admin/credits") {
        if (request.method === "OPTIONS") {
          sendJson(response, 204);
          return;
        }
        if (request.method !== "POST") {
          sendJson(response, 405, { status: "failed", errorMessage: "Method not allowed" });
          return;
        }
        const body = await readJsonBody<Partial<CreditAdjustmentRequest>>(request, bodyLimitBytes);
        const result = adjustAccountCredits(state, body ?? {}, userId);
        if (!isApiError(result) && stateFilePath) {
          saveServerState(stateFilePath, state);
        }
        sendJson(response, statusFromApiResult(result), result);
        return;
      }

      if (pathname === "/api/admin/credit-limit") {
        if (request.method === "OPTIONS") {
          sendJson(response, 204);
          return;
        }
        if (request.method !== "POST") {
          sendJson(response, 405, { status: "failed", errorMessage: "Method not allowed" });
          return;
        }
        const body = await readJsonBody<Partial<CreditLimitRequest>>(request, bodyLimitBytes);
        const result = setAccountCreditLimit(state, body ?? {}, userId);
        if (!isApiError(result) && stateFilePath) {
          saveServerState(stateFilePath, state);
        }
        sendJson(response, statusFromApiResult(result), result);
        return;
      }

      if (pathname === "/api/admin/model-pricing") {
        if (request.method === "OPTIONS") {
          sendJson(response, 204);
          return;
        }
        if (request.method !== "POST") {
          sendJson(response, 405, { status: "failed", errorMessage: "Method not allowed" });
          return;
        }
        const body = await readJsonBody<Partial<ModelPricingRequest>>(request, bodyLimitBytes);
        const result = configureModelPricing(state, body ?? {}, userId);
        if (!isApiError(result) && stateFilePath) {
          saveServerState(stateFilePath, state);
        }
        sendJson(response, statusFromApiResult(result), result);
        return;
      }

      if (pathname === "/api/admin/operation-pricing") {
        if (request.method === "OPTIONS") {
          sendJson(response, 204);
          return;
        }
        if (request.method !== "POST") {
          sendJson(response, 405, { status: "failed", errorMessage: "Method not allowed" });
          return;
        }
        const body = await readJsonBody<Partial<OperationPricingRequest>>(request, bodyLimitBytes);
        const result = configureOperationPricing(state, body ?? {}, userId);
        if (!isApiError(result) && stateFilePath) {
          saveServerState(stateFilePath, state);
        }
        sendJson(response, statusFromApiResult(result), result);
        return;
      }

      if (pathname === "/api/admin/models") {
        if (request.method === "OPTIONS") {
          sendJson(response, 204);
          return;
        }
        if (request.method !== "POST") {
          sendJson(response, 405, { status: "failed", errorMessage: "Method not allowed" });
          return;
        }
        const body = await readJsonBody<Partial<ModelRegistryRequest>>(request, bodyLimitBytes);
        const result = configureModelRegistry(state, body ?? {}, userId);
        if (!isApiError(result) && stateFilePath) {
          saveServerState(stateFilePath, state);
        }
        sendJson(response, statusFromApiResult(result), result);
        return;
      }

      if (pathname === "/api/admin/provider-settings") {
        if (request.method === "OPTIONS") {
          sendJson(response, 204);
          return;
        }
        if (request.method !== "POST") {
          sendJson(response, 405, { status: "failed", errorMessage: "Method not allowed" });
          return;
        }
        const body = await readJsonBody<Partial<ProviderSettingsRequest>>(request, bodyLimitBytes);
        const result = configureProviderSettings(state, body ?? {}, userId);
        if (!isApiError(result) && stateFilePath) {
          saveServerState(stateFilePath, state);
        }
        sendJson(response, statusFromApiResult(result), result);
        return;
      }

      if (
        pathname === "/api/admin/history/archive" ||
        pathname === "/api/admin/history/restore" ||
        pathname === "/api/admin/history/delete"
      ) {
        if (request.method === "OPTIONS") {
          sendJson(response, 204);
          return;
        }
        if (request.method !== "POST") {
          sendJson(response, 405, { status: "failed", errorMessage: "Method not allowed" });
          return;
        }
        const body = await readJsonBody<AdminHistoryArchiveRequest>(request, bodyLimitBytes);
        const result = callApi(state, pathname as "/api/admin/history/archive" | "/api/admin/history/restore" | "/api/admin/history/delete", body ?? {}, undefined, userId);
        if (!isApiError(result) && stateFilePath) {
          saveServerState(stateFilePath, state);
        }
        sendJson(response, statusFromApiResult(result), result);
        return;
      }

      if (pathname === "/api/prompts" || pathname.startsWith("/api/prompts/")) {
        if (request.method === "OPTIONS") {
          sendJson(response, 204);
          return;
        }
        if (request.method === "GET" && pathname === "/api/prompts") {
          const result = callApi(state, "/api/prompts", undefined, undefined, userId);
          sendJson(response, statusFromApiResult(result), result);
          return;
        }
        if (request.method === "POST" && pathname === "/api/prompts") {
          const body = await readJsonBody<PromptPresetRequest>(request, bodyLimitBytes);
          const result = callApi(state, "/api/prompts", body ?? {}, undefined, userId);
          if (!isApiError(result) && stateFilePath) {
            saveServerState(stateFilePath, state);
          }
          sendJson(response, statusFromApiResult(result), result);
          return;
        }
        if (request.method === "DELETE" && pathname.startsWith("/api/prompts/")) {
          const id = decodeURIComponent(pathname.slice("/api/prompts/".length));
          const result = callApi(state, "/api/prompts", { id }, undefined, userId);
          if (!isApiError(result) && stateFilePath) {
            saveServerState(stateFilePath, state);
          }
          sendJson(response, statusFromApiResult(result), result);
          return;
        }
        if (request.method === "PATCH" && pathname.startsWith("/api/prompts/")) {
          const id = decodeURIComponent(pathname.slice("/api/prompts/".length));
          const body = await readJsonBody<PromptPresetRequest>(request, bodyLimitBytes);
          const result = callApi(state, "/api/prompts", { ...(body ?? {}), id }, undefined, userId);
          if (!isApiError(result) && stateFilePath) {
            saveServerState(stateFilePath, state);
          }
          sendJson(response, statusFromApiResult(result), result);
          return;
        }
        sendJson(response, 405, { status: "failed", errorMessage: "Method not allowed" });
        return;
      }

      if (pathname === "/api/assets" || pathname.startsWith("/api/assets/")) {
        if (request.method === "OPTIONS") {
          sendJson(response, 204);
          return;
        }
        if (request.method === "GET" && pathname === "/api/assets") {
          const result = callApi(state, "/api/assets", undefined, undefined, userId);
          sendJson(response, statusFromApiResult(result), result);
          return;
        }
        if (request.method === "PATCH" && pathname.startsWith("/api/assets/")) {
          const id = decodeURIComponent(pathname.slice("/api/assets/".length));
          const body = await readJsonBody<AssetMetadataRequest>(request, bodyLimitBytes);
          const result = callApi(state, "/api/assets", { ...(body ?? {}), id }, undefined, userId);
          if (!isApiError(result) && stateFilePath) {
            saveServerState(stateFilePath, state);
          }
          sendJson(response, statusFromApiResult(result), result);
          return;
        }
        sendJson(response, 405, { status: "failed", errorMessage: "Method not allowed" });
        return;
      }

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
        const result = callApi(state, pathname, undefined, undefined, userId, {
          userId: requestUrl.searchParams.get("userId") ?? undefined,
          projectId: requestUrl.searchParams.get("projectId") ?? undefined,
          modelId: requestUrl.searchParams.get("modelId") ?? undefined,
          operation: requestUrl.searchParams.get("operation") ?? undefined,
          status: requestUrl.searchParams.get("status") ?? undefined,
          from: requestUrl.searchParams.get("from") ?? undefined,
          to: requestUrl.searchParams.get("to") ?? undefined,
          dateFrom: requestUrl.searchParams.get("dateFrom") ?? undefined,
          dateTo: requestUrl.searchParams.get("dateTo") ?? undefined
        });
        sendJson(response, statusFromApiResult(result), result);
        return;
      }

      if (writeRoutes.has(pathname)) {
        if (request.method !== "POST") {
          sendJson(response, 405, { status: "failed", errorMessage: "Method not allowed" });
          return;
        }
        const body = await readJsonBody<GenerationRequest>(request, bodyLimitBytes);
        const generationJobCount = state.generationJobs.length;
        const result = await callApiAsync(state, pathname, body, request.headers["x-request-id"]?.toString(), userId, {
          fetchJson: providerFetchJson,
          resolveSecret: resolveProviderSecret
        });
        if (stateFilePath && (!isApiError(result) || state.generationJobs.length !== generationJobCount)) {
          saveServerState(stateFilePath, state);
        }
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
  const stateFilePath = options.stateFilePath ?? process.env.API_STATE_FILE ?? resolve(".data", "server-state.json");
  const server = createApiHttpServer({ ...options, stateFilePath });
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
